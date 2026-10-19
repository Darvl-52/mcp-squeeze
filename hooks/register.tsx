import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Seen, Stat, Total } from '../types'
import { PACK_TOOL, packOf, packs, packsLabel } from './packs'
import { hash, imageNote, imageTokens, pngSize, REPEAT_MIN, repeatNote, squeezeText } from './squeeze'

// Each agent's blocks returned this conversation, by hash: `whole` the last copy went whole, so the
// next is left out; `pointed` it was left out, so the next goes whole. By agent, '' the main one.
const seenAtom = atom({ plugin: 'mcp-squeeze', key: 'seen' } as const, {} as Record<string, Seen>)
const statsAtom = atom({ plugin: 'mcp-squeeze', key: 'stats' } as const, {} as Record<string, Stat>)

const OFF_KEY = 'off'
// Kept true while a pack is off, by itself: `off:figma`.
const packOffKey = (pack: string) => `off:${pack}`
// What it has kept out since it was first on, across sessions (Total).
const TOTAL_KEY = 'total'
// Characters a token, roughly, over code and text in either language: for the estimate alone, as
// no API counts the tokens of a text without a model call that would cost about what it saves.
const CHARS_PER_TOKEN = 3.5

// The stores of the total one after another, so two calls answering at once both count.
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
// The text's change, signed: `−23%` smaller, `+40%` larger (a repeated image's note is text where
// the image was none).
const change = (s: Stat) => (percent(s) < 0 ? `+${-percent(s)}%` : `−${percent(s)}%`)
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

const sum = (stats: Readonly<Record<string, Stat>> | readonly Stat[]) =>
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

// A stat's key, `<pack>:<tool>`; a key an earlier version kept is a tool's name alone, of the Figma
// pack, the only one it had.
const keyOf = (pack: string, tool: string) => `${pack}:${tool}`
const splitKey = (key: string) => {
  const at = key.indexOf(':')
  return at < 0 ? { pack: 'figma', tool: key } : { pack: key.slice(0, at), tool: key.slice(at + 1) }
}

// The stats each under its `<pack>:<tool>` key, an earlier version's added to its own.
const keyed = (stats: Readonly<Record<string, Stat>>) => {
  const out: Record<string, Stat> = {}
  for (const [key, s] of Object.entries(stats)) {
    const { pack, tool } = splitKey(key)
    const k = keyOf(pack, tool)
    out[k] = out[k] ? sum([out[k], s]) : s
  }
  return out
}

// How a row is named: by its tool alone while one pack has answered, by pack and tool past that.
const namer = (keys: readonly string[]) => {
  const isMany = new Set(keys.map(k => splitKey(k).pack)).size > 1
  return (key: string) => {
    const { pack, tool } = splitKey(key)
    return isMany ? `${pack} ${tool}` : tool
  }
}

// The tokens a stat kept out: its text's, estimated, and its images'.
const saved = (s: Stat) => tokens(s.before - s.after) + (s.imageTokens ?? 0)

// The total as kept, or none yet; a value of another shape (an earlier version's) counts as none.
async function totalIn($: EngineInterface): Promise<Total | undefined> {
  const t = (await $.store.get(TOTAL_KEY).catch(() => undefined)) as Partial<Total> | undefined
  return t && typeof t.since === 'number' && typeof t.tools === 'object' && t.tools !== null ? { since: t.since, tools: keyed(t.tools) } : undefined
}

function addToTotal($: EngineInterface, key: string, call: Omit<Stat, 'calls'>) {
  totalWrites = totalWrites
    .then(async () => {
      const t = (await totalIn($)) ?? { since: await $.clock.now(), tools: {} }
      await $.store.set(TOTAL_KEY, { since: t.since, tools: { ...t.tools, [key]: added(t.tools[key], call) } })
    })
    .catch(() => {})
  return totalWrites
}

// One line of what was kept out: the calls, the tokens saved, the text before and after, the
// images left out.
const gainLine = (label: string, s: Stat, width: number) =>
  `${label.padEnd(width)}  ${String(s.calls).padStart(4)} ${s.calls === 1 ? 'call ' : 'calls'}  saved ≈ ${kilo(saved(s)).padStart(6)} tokens  text ${kilo(tokens(s.before)).padStart(6)} → ${kilo(tokens(s.after)).padStart(6)} (${change(s)})${s.images ? `  images left out: ${s.images} (≈ ${kilo(s.imageTokens ?? 0)})` : ''}`

function gain(conversation: Readonly<Record<string, Stat>>, total: Total | undefined) {
  const since = total ? new Date(total.since).toISOString().slice(0, 10) : ''
  const name = namer(Object.keys(total?.tools ?? {}))
  const tools = Object.entries(total?.tools ?? {})
    .sort((a, b) => saved(b[1]) - saved(a[1]))
    .map(([k, s]) => [name(k), s] as const)
  const width = Math.max(`all time, since ${since}`.length, ...tools.map(([t]) => t.length + 2))
  return [
    `Tokens the ${packsLabel} tools' results did not bring into the context (text estimated at ${CHARS_PER_TOKEN} characters a token, an image at a token per 750 pixels):`,
    '',
    gainLine('this conversation', sum(conversation), width),
    ...(total ? [gainLine(`all time, since ${since}`, sum(total.tools), width), '', 'By tool, all time:', ...tools.map(([t, s]) => gainLine(`  ${t}`, s, width))] : []),
  ].join('\n')
}

const FOOT = '/squeeze off turns it off, /squeeze on back on; /squeeze <pack> off one pack alone; /squeeze-gain says the tokens saved, all time too.'
const USAGE = `Usage: /squeeze, /squeeze on, /squeeze off, /squeeze <pack> on, /squeeze <pack> off (packs: ${packs.map(p => p.id).join(', ')})`

// Each pack, on or off by itself: "Packs: figma on."
const packsLine = (offPacks: ReadonlySet<string>) => `Packs: ${packs.map(p => `${p.id} ${offPacks.has(p.id) ? 'off' : 'on'}`).join(', ')}.`

function report(stats: Readonly<Record<string, Stat>>, isOn: boolean, offPacks: ReadonlySet<string>) {
  const name = namer(Object.keys(stats))
  const rows = Object.entries(stats)
    .sort((a, b) => b[1].before - a[1].before)
    .map(([k, s]) => [name(k), s] as const)
  const all = sum(stats)
  const head = `MCP squeeze is ${isOn ? 'on' : 'off'}.`
  if (all.calls === 0) return `${head} No ${packsLabel} tool has answered in this conversation yet.\n${packsLine(offPacks)}\n${FOOT}`
  const width = Math.max(...rows.map(([t]) => t.length))
  const images = all.images ? `, ${all.images} repeated ${all.images === 1 ? 'image' : 'images'} left out` : ''
  return [
    `${head} This conversation: ${all.calls} ${packsLabel} ${all.calls === 1 ? 'call' : 'calls'}, ${kilo(all.before)} → ${kilo(all.after)} characters (${change(all)})${images}; about ${kilo(saved(all))} tokens kept out of the context.`,
    ...rows.map(([t, r]) => `  ${t.padEnd(width)}  ${String(r.calls).padStart(3)} × ${kilo(r.before).padStart(6)} → ${kilo(r.after).padStart(6)}  ${change(r)}`),
    packsLine(offPacks),
    FOOT,
  ].join('\n')
}

const isOnIn = async ($: EngineInterface) => (await $.store.get(OFF_KEY).catch(() => undefined)) !== true
const isPackOnIn = async ($: EngineInterface, pack: string) => (await $.store.get(packOffKey(pack)).catch(() => undefined)) !== true

async function offPacksIn($: EngineInterface) {
  const off = new Set<string>()
  for (const p of packs) if (!(await isPackOnIn($, p.id))) off.add(p.id)
  return off
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'squeeze', description: `What squeezing the ${packsLabel} MCP tools has kept out of the context; on or off, all or one pack`, argumentHint: '[on|off|<pack> on|<pack> off]' })
    await $.command.register({ name: 'squeeze-gain', description: `Tokens squeezing the ${packsLabel} MCP tools has saved: this conversation, all time, by tool` })
    return next(e)
  })

  on('command.run', { command: 'squeeze-gain' }, async $ => ({ text: gain(keyed(await read($, statsAtom)), await totalIn($)) }))

  // A compact starts the compacting agent's context over: a block left out now would point at what
  // the summary took the place of. Once the compact stood, not for one skipped, nor for a summary
  // worked out ahead of time (`precompute`), which leaves the context as it was.
  on('session.compact', async ($, e, next) => {
    const ran = await next(e)
    if (e.trigger !== 'precompute' && ran.skip === undefined) await update($, seenAtom, all => ({ ...all, [e.agentId ?? '']: {} }))
    return ran
  }).catch(($, e, next) => next(e))

  // A /clear starts a new conversation: what was returned and what was kept out start over.
  on('session.end', async ($, e, next) => {
    const ran = await next(e)
    if (e.reason === 'clear') {
      await update($, seenAtom, () => ({}))
      await update($, statsAtom, () => ({}))
    }
    return ran
  }).catch(($, e, next) => next(e))

  // The result of a tool some pack takes is squeezed after it ran; an error, a shape it does not
  // know, or a pack turned off passes as it came, as does any other tool, which the hook never sees.
  on('tool.call', { tool: PACK_TOOL }, async ($, e, next) => {
    const pack = packOf(e.tool)
    if (!pack) return next(e)
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError || !(await isOnIn($)) || !(await isPackOnIn($, pack.id))) return ran
    const found = blocksOf(ran.result)
    if (!found) return ran
    const { blocks, images, imageCost } = await squeeze($, e.tool, e.agentId ?? '', found.blocks)
    // An image left out leaves a note in its place, counted with the text.
    const isChanged = blocks.some((b, k) => b !== found.blocks[k])
    const before = textLength(found.blocks)
    const after = isChanged ? textLength(blocks) : before
    const call = { before, after, images, imageTokens: imageCost }
    const key = keyOf(pack.id, e.tool.slice(e.tool.lastIndexOf('__') + 2))
    await update($, statsAtom, was => {
      const s = keyed(was)
      return { ...s, [key]: added(s[key], call) }
    })
    await addToTotal($, key, call)
    if (!isChanged) return ran
    return { result: found.wrap(blocks), ...(ran.context ? { context: ran.context } : {}) }
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'squeeze' }, async ($, e) => {
    const args = e.args.trim().toLowerCase().split(/\s+/).filter(Boolean)
    const [first, second] = args
    const isSwitch = (word: string | undefined) => word === 'on' || word === 'off'
    if (args.length === 1 && isSwitch(first)) await $.store.set(OFF_KEY, first === 'off')
    else if (args.length === 2 && packs.some(p => p.id === first) && isSwitch(second)) await $.store.set(packOffKey(first!), second === 'off')
    else if (args.length !== 0) return { text: USAGE }
    return { text: report(keyed(await read($, statsAtom)), await isOnIn($), await offPacksIn($)) }
  })
}
