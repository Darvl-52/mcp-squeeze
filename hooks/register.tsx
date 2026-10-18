import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Seen, Stat, Total } from '../types'
import { hash, imageNote, imageTokens, pngSize, REPEAT_MIN, repeatNote, squeezeText } from './squeeze'

// Each agent's blocks returned this conversation, by hash: `whole` the last copy went whole, so the
// next is left out; `pointed` it was left out, so the next goes whole. By agent, '' the main one.
const seenAtom = atom({ plugin: 'mcp-squeeze', key: 'seen' } as const, {} as Record<string, Seen>)
const statsAtom = atom({ plugin: 'mcp-squeeze', key: 'stats' } as const, {} as Record<string, Stat>)

// The Figma servers' tools, whichever name the server goes by (`figma`, `claude_ai_Figma`).
const isFigma = (tool: string) => tool.startsWith('mcp__') && /figma/i.test(tool.slice(5, tool.lastIndexOf('__')))
const OFF_KEY = 'off'
// What it has kept out since it was first on, across sessions (Total).
const TOTAL_KEY = 'total'
// Characters a token, roughly, over code and text in either language: for the estimate alone, as
// no API counts the tokens of a text without a model call that would cost about what it saves.
const CHARS_PER_TOKEN = 3.5

// The stores of the total one after another, so two Figma calls answering at once both count.
let totalWrites: Promise<unknown> = Promise.resolve()

type Block = { type: string; text?: string; [field: string]: unknown }

// The text blocks of an MCP tool's record, however it came: blocks, `{ content }`, or a string.
const blocksOf = (result: unknown): { blocks: Block[]; wrap: (blocks: Block[]) => unknown } | undefined => {
  if (typeof result === 'string') return { blocks: [{ type: 'text', text: result }], wrap: b => b.map(x => x.text ?? '').join('') }
  if (Array.isArray(result) && result.every(x => typeof x === 'object' && x !== null && typeof x.type === 'string'))
    return { blocks: result as Block[], wrap: b => b }
  if (typeof result === 'object' && result !== null && Array.isArray((result as { content?: unknown }).content)) {
    const inner = blocksOf((result as { content: unknown }).content)
    return inner && { blocks: inner.blocks, wrap: b => ({ ...result, content: b }) }
  }
  return undefined
}

const textLength = (blocks: readonly Block[]) => blocks.reduce((n, b) => n + (b.type === 'text' ? (b.text ?? '').length : 0), 0)

// An image block's data and kind, as MCP sends it (`data`, `mimeType`) or as the API takes it
// (`source.data`, `source.media_type`).
const imageOf = (b: Block) => {
  const source = (typeof b.source === 'object' && b.source !== null ? b.source : {}) as { data?: unknown; media_type?: unknown }
  const data = typeof b.data === 'string' ? b.data : typeof source.data === 'string' ? source.data : undefined
  const mimeType = typeof b.mimeType === 'string' ? b.mimeType : typeof source.media_type === 'string' ? source.media_type : 'image'
  return data === undefined ? undefined : { data, mimeType }
}

// The blocks squeezed, a block returned whole before left out; with the images left out and the
// tokens they would have cost.
async function squeeze($: EngineInterface, tool: string, agent: string, blocks: readonly Block[]) {
  const seen = { ...((await read($, seenAtom))[agent] ?? {}) }
  let images = 0
  let imageCost = 0
  // Whether this copy goes whole: not when the last copy did.
  const isRepeat = (key: string) => {
    const was = seen[key] === 'whole'
    seen[key] = was ? 'pointed' : 'whole'
    return was
  }
  const out = blocks.map((b): Block => {
    if (b.type === 'image') {
      // Only an image whose size it reads (a PNG, as Figma sends) is left out, so what it saves
      // is counted; any other passes as it came.
      const image = imageOf(b)
      const size = image && pngSize(image.data)
      if (!image || !size || !isRepeat(`image:${hash(image.data)}`)) return b
      images++
      imageCost += imageTokens(size)
      return { type: 'text', text: imageNote(image.mimeType, size) }
    }
    if (b.type !== 'text' || typeof b.text !== 'string') return b
    const text = squeezeText(tool, b.text)
    if (text.length < REPEAT_MIN) return text === b.text ? b : { ...b, text }
    return { ...b, text: isRepeat(hash(text)) ? repeatNote(text) : text }
  })
  await update($, seenAtom, all => ({ ...all, [agent]: seen }))
  return { blocks: out, images, imageCost }
}

const kilo = (n: number) => (n < 1000 ? String(n) : `${(n / 1000).toFixed(1)}k`)
const percent = (s: Stat) => (s.before === 0 ? 0 : Math.round(100 - (100 * s.after) / s.before))
const tokens = (chars: number) => Math.round(chars / CHARS_PER_TOKEN)

// What one call adds to a tool's stat; an earlier version's stat counts no images.
const added = (was: Stat | undefined, call: Omit<Stat, 'calls'>): Stat => {
  const s = was ?? { calls: 0, before: 0, after: 0 }
  return {
    calls: s.calls + 1,
    before: s.before + call.before,
    after: s.after + call.after,
    images: (s.images ?? 0) + (call.images ?? 0),
    imageTokens: (s.imageTokens ?? 0) + (call.imageTokens ?? 0),
  }
}

const sum = (stats: Readonly<Record<string, Stat>>) =>
  Object.values(stats).reduce(
    (s, r) => ({
      calls: s.calls + r.calls,
      before: s.before + r.before,
      after: s.after + r.after,
      images: (s.images ?? 0) + (r.images ?? 0),
      imageTokens: (s.imageTokens ?? 0) + (r.imageTokens ?? 0),
    }),
    { calls: 0, before: 0, after: 0, images: 0, imageTokens: 0 } as Stat,
  )

// The tokens a stat kept out: its text's, estimated, and its images'.
const saved = (s: Stat) => tokens(s.before - s.after) + (s.imageTokens ?? 0)

// The total as kept, or none yet; a value of another shape (an earlier version's) counts as none.
async function totalIn($: EngineInterface): Promise<Total | undefined> {
  const t = (await $.store.get(TOTAL_KEY).catch(() => undefined)) as Partial<Total> | undefined
  return t && typeof t.since === 'number' && typeof t.tools === 'object' && t.tools !== null ? (t as Total) : undefined
}

function addToTotal($: EngineInterface, tool: string, call: Omit<Stat, 'calls'>) {
  totalWrites = totalWrites
    .then(async () => {
      const t = (await totalIn($)) ?? { since: await $.clock.now(), tools: {} }
      await $.store.set(TOTAL_KEY, { since: t.since, tools: { ...t.tools, [tool]: added(t.tools[tool], call) } })
    })
    .catch(() => {})
  return totalWrites
}

// One line of what was kept out: the calls, the tokens saved, the text before and after, the
// images left out.
const gainLine = (label: string, s: Stat, width: number) =>
  `${label.padEnd(width)}  ${String(s.calls).padStart(4)} ${s.calls === 1 ? 'call ' : 'calls'}  saved ≈ ${kilo(saved(s)).padStart(6)} tokens  text ${kilo(tokens(s.before)).padStart(6)} → ${kilo(tokens(s.after)).padStart(6)} (−${percent(s)}%)${s.images ? `  images left out: ${s.images} (≈ ${kilo(s.imageTokens ?? 0)})` : ''}`

function gain(conversation: Readonly<Record<string, Stat>>, total: Total | undefined) {
  const since = total ? new Date(total.since).toISOString().slice(0, 10) : ''
  const tools = Object.entries(total?.tools ?? {}).sort((a, b) => saved(b[1]) - saved(a[1]))
  const width = Math.max(`all time, since ${since}`.length, ...tools.map(([t]) => t.length + 2))
  return [
    `Tokens the Figma tools' results did not bring into the context (text estimated at ${CHARS_PER_TOKEN} characters a token, an image at a token per 750 pixels):`,
    '',
    gainLine('this conversation', sum(conversation), width),
    ...(total ? [gainLine(`all time, since ${since}`, sum(total.tools), width), '', 'By tool, all time:', ...tools.map(([t, s]) => gainLine(`  ${t}`, s, width))] : []),
  ].join('\n')
}

const FOOT = '/squeeze off turns it off, /squeeze on back on; /squeeze-gain says the tokens saved, all time too.'

function report(stats: Readonly<Record<string, Stat>>, isOn: boolean) {
  const rows = Object.entries(stats).sort((a, b) => b[1].before - a[1].before)
  const all = sum(stats)
  const head = `MCP squeeze is ${isOn ? 'on' : 'off'}.`
  if (all.calls === 0) return `${head} No Figma tool has answered in this conversation yet.\n${FOOT}`
  const width = Math.max(...rows.map(([t]) => t.length))
  const images = all.images ? `, ${all.images} repeated ${all.images === 1 ? 'image' : 'images'} left out` : ''
  return [
    `${head} This conversation: ${all.calls} Figma ${all.calls === 1 ? 'call' : 'calls'}, ${kilo(all.before)} → ${kilo(all.after)} characters (−${percent(all)}%)${images}; about ${kilo(saved(all))} tokens kept out of the context.`,
    ...rows.map(([t, r]) => `  ${t.padEnd(width)}  ${String(r.calls).padStart(3)} × ${kilo(r.before).padStart(6)} → ${kilo(r.after).padStart(6)}  −${percent(r)}%`),
    FOOT,
  ].join('\n')
}

const isOnIn = async ($: EngineInterface) => (await $.store.get(OFF_KEY).catch(() => undefined)) !== true

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'squeeze', description: 'What squeezing the Figma MCP tools has kept out of the context; on or off', argumentHint: '[on|off]' })
    await $.command.register({ name: 'squeeze-gain', description: 'Tokens squeezing the Figma MCP tools has saved: this conversation, all time, by tool' })
    return next(e)
  })

  on('command.run', { command: 'squeeze-gain' }, async $ => ({ text: gain(await read($, statsAtom), await totalIn($)) }))

  // A compact or a /clear starts the context over: a block left out now would point at nothing.
  on('classic.SessionStart', async ($, e, next) => {
    const ran = await next(e)
    if (e.source === 'compact' || e.source === 'clear') {
      await update($, seenAtom, () => ({}))
      if (e.source === 'clear') await update($, statsAtom, () => ({}))
    }
    return ran
  }).catch(($, e, next) => next(e))

  // A Figma tool's result is squeezed after it ran; any other tool, an error, or a shape it does
  // not know passes as it came.
  on('tool.call', async ($, e, next) => {
    if (!isFigma(e.tool)) return next(e)
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError || !(await isOnIn($))) return ran
    const found = blocksOf(ran.result)
    if (!found) return ran
    const { blocks, images, imageCost } = await squeeze($, e.tool, e.agentId ?? '', found.blocks)
    // An image left out leaves a note in its place, counted with the text.
    const isChanged = blocks.some((b, k) => b !== found.blocks[k])
    const before = textLength(found.blocks)
    const after = isChanged ? textLength(blocks) : before
    const call = { before, after, images, imageTokens: imageCost }
    const name = e.tool.slice(e.tool.lastIndexOf('__') + 2)
    await update($, statsAtom, s => ({ ...s, [name]: added(s[name], call) }))
    await addToTotal($, name, call)
    if (!isChanged) return ran
    return { result: found.wrap(blocks), ...(ran.context ? { context: ran.context } : {}) }
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'squeeze' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'on' || arg === 'off') await $.store.set(OFF_KEY, arg === 'off')
    else if (arg !== '') return { text: 'Usage: /squeeze, /squeeze on, /squeeze off' }
    return { text: report(await read($, statsAtom), await isOnIn($)) }
  })
}
