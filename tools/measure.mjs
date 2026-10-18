// What the mod would have kept out of the Figma tools' results in this machine's past sessions:
// reads every transcript under ~/.claude/projects, squeezes each result as the mod does, a repeat
// left out within its own conversation, and prints it by tool.
//
//   node tools/measure.mjs
//
// The transcripts are read where they are and nothing is written.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const { hash, imageNote, imageTokens, pngSize, REPEAT_MIN, repeatNote, squeezeText } = await import(new URL('../hooks/squeeze.ts', import.meta.url))

const files = []
const walk = dir => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) walk(path)
    else if (name.endsWith('.jsonl')) files.push(path)
  }
}
walk(join(homedir(), '.claude/projects'))

const stats = {}
const add = (tool, key, n) => {
  stats[tool] ??= { calls: 0, before: 0, after: 0, images: 0, imageTokens: 0 }
  stats[tool][key] += n
}
for (const file of files) {
  const names = new Map()
  const seen = new Map()
  const isRepeat = key => {
    const was = seen.get(key) === 'whole'
    seen.set(key, was ? 'pointed' : 'whole')
    return was
  }
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.includes('figma') && !line.includes('tool_result')) continue
    let record
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    const content = record.message?.content
    if (!Array.isArray(content)) continue
    for (const b of content) {
      if (b?.type === 'tool_use' && /^mcp__.*figma.*__/i.test(b.name ?? '')) names.set(b.id, b.name)
      if (b?.type !== 'tool_result' || !names.has(b.tool_use_id) || !Array.isArray(b.content)) continue
      const tool = names.get(b.tool_use_id)
      const short = tool.slice(tool.lastIndexOf('__') + 2)
      add(short, 'calls', 1)
      for (const x of b.content) {
        if (x.type === 'image') {
          const data = x.source?.data ?? x.data
          const size = typeof data === 'string' ? pngSize(data) : undefined
          if (!size || !isRepeat(`image:${hash(data)}`)) continue
          add(short, 'images', 1)
          add(short, 'imageTokens', imageTokens(size))
          add(short, 'after', imageNote(x.source?.media_type ?? 'image', size).length)
          continue
        }
        if (x.type !== 'text') continue
        add(short, 'before', x.text.length)
        const text = squeezeText(tool, x.text)
        add(short, 'after', text.length >= REPEAT_MIN && isRepeat(hash(text)) ? repeatNote(text).length : text.length)
      }
    }
  }
}

const k = n => `${(n / 1000).toFixed(0)}k`
const saved = s => Math.round((s.before - s.after) / 3.5) + s.imageTokens
const rows = Object.entries(stats).sort((a, b) => saved(b[1]) - saved(a[1]))
const all = rows.reduce((t, [, s]) => Object.fromEntries(Object.keys(s).map(key => [key, t[key] + s[key]])), { calls: 0, before: 0, after: 0, images: 0, imageTokens: 0 })
console.log(`${'tool'.padEnd(22)} ${'calls'.padStart(6)} ${'text before'.padStart(12)} ${'after'.padStart(8)} ${'−%'.padStart(5)} ${'images'.padStart(7)} ${'tokens saved ≈'.padStart(15)}`)
for (const [tool, s] of [...rows, ['total', all]])
  console.log(
    `${tool.padEnd(22)} ${String(s.calls).padStart(6)} ${k(s.before).padStart(12)} ${k(s.after).padStart(8)} ${String(Math.round(100 - (100 * s.after) / (s.before || 1))).padStart(5)} ${String(s.images).padStart(7)} ${k(saved(s)).padStart(15)}`,
  )
