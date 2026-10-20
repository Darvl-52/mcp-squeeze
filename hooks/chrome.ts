// The Chrome DevTools pack: what the mod does to the text the Chrome DevTools server's tools return
// (`chrome-devtools`, `chrome_devtools`, `chrome-devtools-mcp`). It keeps what the model acts on
// (every uid, role, name, value, URL) and drops only what spells it long.
import type { Memory } from '../types'
import type { Pack } from './packs.ts'

// A run of percent-escapes of bytes past ASCII, as UTF-8 writes a character past it.
const ESCAPED = /(?:%[89A-Fa-f][0-9A-Fa-f])+/g
// A character better left escaped: one that does not show, or shows as a space.
const UNSEEN = /[\p{C}\p{Z}]/u

// A URL with each character past ASCII that is percent-escaped written as itself: the same URL to a
// browser, one character where it was six. An escaped ASCII character (%20, %2F, %26) stays, as
// unescaped it may mean something else; so does a run that is no UTF-8, or spells a character that
// does not show.
export const unescapeUrl = (url: string) =>
  url.replace(ESCAPED, run => {
    let text: string
    try {
      text = decodeURIComponent(run)
    } catch {
      return run
    }
    return UNSEEN.test(text) ? run : text
  })

// The page's snapshot, from its heading on: `take_snapshot`'s, and the one after a click, a fill, a
// wait.
const SNAPSHOT = '## Latest page snapshot\n'
const URL_ATTR = / url="([^"]*)"/g

// A result with each `url="…"` of its snapshot unescaped; whatever comes before the snapshot (a URL
// navigated to) is left as it is, and so is a result with none.
export const unescapeSnapshot = (text: string) => {
  const at = text.startsWith(SNAPSHOT) ? 0 : text.indexOf(`\n${SNAPSHOT}`)
  if (at < 0) return text
  return text.slice(0, at) + text.slice(at).replace(URL_ATTR, (all, url: string) => ` url="${unescapeUrl(url)}"`)
}

// A snapshot's line: its indent, then its node's uid, which the node keeps from one snapshot to the
// next while it is on the page.
const NODE = /^(\s*)uid=(\S+)(?:\s|$)/
const HEADING = '## Latest page snapshot'

type Mark = ' ' | '+' | '-' | '~'
type Entry = { mark: Mark; line: string; keep: boolean }

const indentOf = (line: string) => line.length - line.trimStart().length
const uidOf = (line: string) => NODE.exec(line)![2]!

// The longest run of `positions` that only rises, as their indexes: the nodes of a snapshot in the
// order they had in the last one.
const rising = (positions: readonly number[]) => {
  const tails: number[] = []
  const before: number[] = []
  positions.forEach((p, k) => {
    if (p < 0) return
    let lo = 0
    let hi = tails.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (positions[tails[mid]!]! < p) lo = mid + 1
      else hi = mid
    }
    before[k] = lo > 0 ? tails[lo - 1]! : -1
    tails[lo] = k
  })
  const out = new Set<number>()
  for (let k = tails.at(-1) ?? -1; k >= 0; k = before[k]!) out.add(k)
  return out
}

// The snapshot `now` told by its changes since `last`, both its lines: each line marked new (+),
// gone (-, a node gone with all in it told once) or changed (~), with the lines above it it is in,
// and each run of lines as they were told by their count. Undefined where a node's uid is on two
// lines, which no snapshot has.
export const snapshotChanges = (last: readonly string[], now: readonly string[]) => {
  const lastAt = new Map(last.map((line, k) => [uidOf(line), k]))
  if (lastAt.size !== last.length || new Set(now.map(uidOf)).size !== now.length) return undefined
  const positions = now.map(line => lastAt.get(uidOf(line)) ?? -1)
  const kept = rising(positions)
  const entries: Entry[] = []
  let i = 0
  // The last snapshot's lines from `i` up to `to`, the next one still on the page, as gone: each
  // told, but for a line in one told before it, which it counts. A line in it that is still on the
  // page is past `to`, and no line past `to` is counted, so each line is told once.
  const gone = (to: number) => {
    while (i < to) {
      const line = last[i]!
      let count = 0
      while (i + 1 + count < to && indentOf(last[i + 1 + count]!) > indentOf(line)) count++
      entries.push({ mark: '-', line: count ? `${line} (and the ${count} ${count === 1 ? 'line' : 'lines'} in it)` : line, keep: true })
      i += 1 + count
    }
  }
  now.forEach((line, k) => {
    if (!kept.has(k)) {
      entries.push({ mark: '+', line, keep: true })
      return
    }
    gone(positions[k]!)
    i = positions[k]! + 1
    entries.push(line === last[positions[k]!] ? { mark: ' ', line, keep: false } : { mark: '~', line, keep: true })
  })
  gone(last.length)
  // Each change keeps the lines it is in, the nearest above it of each lesser indent. A line gone is
  // in no line of the snapshot now, so it closes none.
  const open: Entry[] = []
  for (const entry of entries) {
    const indent = indentOf(entry.line)
    if (entry.mark === '-') {
      for (const parent of open) if (indentOf(parent.line) < indent) parent.keep = true
      continue
    }
    while (open.length && indentOf(open.at(-1)!.line) >= indent) open.pop()
    if (entry.mark !== ' ') for (const parent of open) parent.keep = true
    open.push(entry)
  }
  if (entries.every(e => e.mark === ' ')) return []
  const out: string[] = []
  for (let k = 0; k < entries.length; ) {
    const entry = entries[k]!
    if (entry.keep) {
      out.push(`${entry.mark} ${entry.line}`)
      k++
      continue
    }
    // A run as deep as its first line or deeper, so the count stays in what that line is in.
    let end = k
    while (end < entries.length && !entries[end]!.keep && indentOf(entries[end]!.line) >= indentOf(entry.line)) end++
    out.push(`  ${' '.repeat(indentOf(entry.line))}… ${end - k} ${end - k === 1 ? 'line' : 'lines'} as before`)
    k = end
  }
  return out
}

// A snapshot told by its changes is used where it comes to this part of the whole, or less.
const CHANGES_AT_MOST = 0.6

// A result with its snapshot told by its changes since the last one this agent read, as the pack
// remembers it: where there is one, the changes come to little enough, and this is no copy called
// for again nor a take_snapshot called next after a snapshot told so, which come whole. Either way
// the snapshot is remembered as the one the model reads now.
const tellSnapshot = (tool: string, text: string, memory: Memory, isAgain: boolean): { text: string; isWhole?: boolean } => {
  const lines = text.split('\n')
  const at = lines.indexOf(HEADING)
  let end = at + 1
  while (at >= 0 && end < lines.length && NODE.test(lines[end]!)) end++
  const wasTold = memory['chrome:told'] === 'yes'
  // Any call between a snapshot told so and a take_snapshot makes the take_snapshot no call for it.
  memory['chrome:told'] = 'no'
  if (at < 0 || end === at + 1) return { text }
  const now = lines.slice(at + 1, end)
  const last = memory['chrome:snapshot']
  memory['chrome:snapshot'] = now.join('\n')
  if (wasTold && tool.endsWith('__take_snapshot')) return { text, isWhole: true }
  if (last === undefined || isAgain) return { text }
  const changes = snapshotChanges(last.split('\n'), now)
  if (!changes) return { text }
  const head =
    changes.length === 0
      ? [`${HEADING}: the same as the last one, its ${now.length} lines as they were. A take_snapshot called next gives it whole.`]
      : [`${HEADING}, told by its changes since the last one: + a line new, - gone, ~ changed, each with the lines it is in; "…" lines as they were. A take_snapshot called next gives it whole.`, ...changes]
  const whole = now.join('\n').length
  if (head.join('\n').length > whole * CHANGES_AT_MOST) return { text }
  memory['chrome:told'] = 'yes'
  return { text: [...lines.slice(0, at), ...head, ...lines.slice(end)].join('\n') }
}

export const chrome: Pack = {
  id: 'chrome',
  server: /.*chrome[-_]?dev[-_]?tools.*/,
  // What it emulates (`Emulating viewport: {…}`), said again after each call while it lasts.
  states: [/^(Emulating[^:\n]*: )(.+)$/],
  squeezeText: (tool, text) => unescapeSnapshot(text),
  tell: tellSnapshot,
}
