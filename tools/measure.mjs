// What the mod would have kept out of the MCP tools' results in this machine's past sessions:
// reads every transcript under the Claude config folder's `projects` (`CLAUDE_CONFIG_DIR`, else
// `.claude` in the home folder, `HOME` or `USERPROFILE`), squeezes each result as the mod does, a
// repeat left out within its own conversation, and prints it by server and tool. A server no pack
// takes passes as it came; its row says what leaving out its repeats would keep out, to weigh a
// pack for it. A transcript keeps a result as the model read it: one the mod had squeezed already
// is left out of the count, and the count of those said.
//
//   node tools/measure.mjs                       every MCP server
//   node tools/measure.mjs --server chrome       the servers whose name holds `chrome`
//   node tools/measure.mjs --sample take_snapshot [3]
//                                                the first results of the tools whose name holds
//                                                `take_snapshot`, as they came and squeezed
//
// The transcripts are read where they are and nothing is written.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const { hash, imageNote, imageTokens, OUTLINE_LEGEND, pngSize, REPEAT_MIN, repeatNote, squeezeText } = await import(new URL('../hooks/squeeze.ts', import.meta.url))
const { packOf } = await import(new URL('../hooks/packs.ts', import.meta.url))

const argAfter = flag => {
  const at = process.argv.indexOf(flag)
  return at < 0 ? undefined : (process.argv[at + 1] ?? '')
}
const serverFilter = argAfter('--server')?.toLowerCase()
const sample = argAfter('--sample')
const sampleCount = Number(process.argv[process.argv.indexOf('--sample') + 2]) || 3
// A sample's text past this many characters is cut, as it came and squeezed alike.
const SAMPLE_CHARS = 1500

const files = []
const walk = dir => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    // A subagent's transcript can be a link to one that is gone.
    const stat = statSync(path, { throwIfNoEntry: false })
    if (stat?.isDirectory()) walk(path)
    else if (stat && name.endsWith('.jsonl')) files.push(path)
  }
}
const config = process.env.CLAUDE_CONFIG_DIR || join(process.env.HOME || process.env.USERPROFILE || homedir(), '.claude')
walk(join(config, 'projects'))

// An MCP tool's server, the part of its name before the last `__`.
const MCP_TOOL = /^mcp__(.*)__((?:(?!__).)+)$/

// By server, then tool: the calls, the text as it came, after its pack, after the repeats left out
// (each in characters), the repeated PNG images left out and the tokens they would have cost, and the
// tokens of every PNG image that came.
const stats = {}
const statOf = (server, tool) => {
  stats[server] ??= {}
  return (stats[server][tool] ??= { calls: 0, before: 0, packed: 0, after: 0, images: 0, imageTokens: 0, allImageTokens: 0 })
}
const samples = []
// By server, the results the mod had squeezed already when they came.
const squeezedBefore = {}

// A text the mod had squeezed: a note where a repeat was left out, an outline, a class declared
// once, an instance told in a line.
const NOTE = /^\[The same [^\n]* this tool returned earlier in this conversation[^\n]*: left out to save context\./
const wasSqueezed = text => NOTE.test(text) || text.startsWith(OUTLINE_LEGEND) || /^const (?:cn|cls)\d+ = "/m.test(text) || text.includes('{/* inside as ')

for (const file of files) {
  const names = new Map()
  const seen = new Map()
  const isRepeat = key => {
    const was = seen.get(key) === 'whole'
    seen.set(key, was ? 'pointed' : 'whole')
    return was
  }
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.includes('mcp__') && !line.includes('tool_result')) continue
    let record
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    const content = record.message?.content
    if (!Array.isArray(content)) continue
    for (const b of content) {
      if (b?.type === 'tool_use' && MCP_TOOL.test(b.name ?? '')) names.set(b.id, b.name)
      if (b?.type !== 'tool_result' || !names.has(b.tool_use_id)) continue
      const tool = names.get(b.tool_use_id)
      const [, server, short] = MCP_TOOL.exec(tool)
      if (serverFilter !== undefined && !server.toLowerCase().includes(serverFilter)) continue
      const blocks = typeof b.content === 'string' ? [{ type: 'text', text: b.content }] : Array.isArray(b.content) ? b.content : []
      if (blocks.some(x => x.type === 'text' && typeof x.text === 'string' && wasSqueezed(x.text))) {
        squeezedBefore[server] = (squeezedBefore[server] ?? 0) + 1
        continue
      }
      const s = statOf(server, short)
      s.calls++
      if (sample !== undefined && short.includes(sample) && samples.length < sampleCount) samples.push({ tool, blocks })
      for (const x of blocks) {
        if (x.type === 'image') {
          const data = x.source?.data ?? x.data
          const size = typeof data === 'string' ? pngSize(data) : undefined
          if (!size) continue
          s.allImageTokens += imageTokens(size)
          if (!isRepeat(`image:${hash(data)}`)) continue
          s.images++
          s.imageTokens += imageTokens(size)
          s.after += imageNote(x.source?.media_type ?? 'image', size).length
          continue
        }
        if (x.type !== 'text' || typeof x.text !== 'string') continue
        const text = squeezeText(tool, x.text)
        s.before += x.text.length
        s.packed += text.length
        s.after += text.length >= REPEAT_MIN && isRepeat(hash(text)) ? repeatNote(text).length : text.length
      }
    }
  }
}

if (sample !== undefined) {
  if (samples.length === 0) console.log(`No result of a tool whose name holds "${sample}".`)
  const cut = text => (text.length > SAMPLE_CHARS ? `${text.slice(0, SAMPLE_CHARS)}\n… (${text.length - SAMPLE_CHARS} more characters)` : text)
  for (const { tool, blocks } of samples) {
    const text = blocks.map(x => (x.type === 'text' ? x.text : `<${x.type}>`)).join('\n')
    const squeezed = blocks.map(x => (x.type === 'text' ? squeezeText(tool, x.text) : `<${x.type}>`)).join('\n')
    console.log(`===== ${tool}: ${text.length} characters${squeezed === text ? ', squeezed the same' : `, squeezed ${squeezed.length}`}\n${cut(text)}`)
    if (squeezed !== text) console.log(`----- squeezed\n${cut(squeezed)}`)
  }
  process.exit(0)
}

const CHARS_PER_TOKEN = 3.5
const tokens = chars => Math.round(chars / CHARS_PER_TOKEN)
// Under 50 tokens either way, about none.
const k = n => (n === 0 ? '0' : Math.abs(n) < 50 ? '~0' : Math.abs(n) < 1000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n / 1000)}k`)
const byPack = s => tokens(s.before - s.packed)
// An image's note is text where the image was none: the repeats' saving is net of it.
const byRepeats = s => tokens(s.packed - s.after)
const saved = s => byPack(s) + byRepeats(s) + s.imageTokens
// What the results cost as they came: their text and their PNG images.
const cost = s => tokens(s.before) + s.allImageTokens
const sum = rows => rows.reduce((t, s) => Object.fromEntries(Object.keys(t).map(key => [key, t[key] + s[key]])), { calls: 0, before: 0, packed: 0, after: 0, images: 0, imageTokens: 0, allImageTokens: 0 })

const servers = Object.entries(stats)
  .map(([server, tools]) => ({ server, pack: packOf(`mcp__${server}__x`)?.id, tools: Object.entries(tools), all: sum(Object.values(tools)) }))
  .sort((a, b) => b.all.before - a.all.before)
if (servers.length === 0) {
  console.log(serverFilter === undefined ? 'No MCP tool has answered in these transcripts.' : `No MCP server whose name holds "${serverFilter}" has answered in these transcripts.`)
  process.exit(0)
}

const rowsOf = ({ server, pack, tools, all }) => [
  { label: `${server}  (${pack ? `pack ${pack}` : 'no pack'})`, s: all },
  ...tools.sort((a, b) => b[1].before - a[1].before).map(([tool, s]) => ({ label: `  ${tool}`, s })),
]
const rows = servers.flatMap(rowsOf)
const packed = sum(servers.filter(s => s.pack).map(s => s.all))
const every = sum(servers.map(s => s.all))
const totals = [
  { label: 'total, packs (what the mod keeps out)', s: packed },
  { label: 'total, every server, its repeats left out', s: every },
]
const width = Math.max(...[...rows, ...totals].map(r => r.label.length))
const line = ({ label, s }) =>
  `${label.padEnd(width)} ${String(s.calls).padStart(6)} ${k(tokens(s.before)).padStart(8)} ${k(byPack(s)).padStart(8)} ${k(byRepeats(s)).padStart(8)} ${`${s.images}${s.images ? ` (${k(s.imageTokens)})` : ''}`.padStart(12)} ${k(saved(s)).padStart(8)} ${String(cost(s) === 0 ? 0 : Math.round((100 * saved(s)) / cost(s))).padStart(4)}%`

console.log(`Tokens estimated at ${CHARS_PER_TOKEN} characters a token, a PNG image at a token per 750 pixels; "of" is of the text and images as they came.`)
console.log('A server with no pack passes as it came: its row says what leaving out its repeats would keep out.')
console.log('')
console.log(`${''.padEnd(width)} ${'calls'.padStart(6)} ${'text'.padStart(8)} ${'by pack'.padStart(8)} ${'repeats'.padStart(8)} ${'images'.padStart(12)} ${'saved ≈'.padStart(8)} ${'of'.padStart(5)}`)
for (const group of servers) {
  for (const r of rowsOf(group)) console.log(line(r))
  console.log('')
}
for (const r of totals) console.log(line(r))
const before = Object.entries(squeezedBefore)
if (before.length)
  console.log(`\nLeft out of the count, as the mod had squeezed them already when they came: ${before.map(([server, n]) => `${n} ${n === 1 ? 'result' : 'results'} of ${server}`).join(', ')}.`)
