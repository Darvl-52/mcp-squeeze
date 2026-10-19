// The Figma pack: what the mod does to the text the Figma servers' tools return (`figma`,
// `claude_ai_Figma`). Each step keeps what the model acts on (node ids, names, positions, sizes,
// every class) and drops only what repeats it or spells it long.
import type { Pack } from './packs.ts'

// A number written with seven or more places, as a float32 value read as a double is
// (1.1299999952316284 for 1.13).
const LONG_NUMBER = /(?<![\w.])-?\d+\.\d{7,}(?![\w.])/g

// The shortest writing of a float32 value that reads back as the same float32; a number that is no
// float32 value (Math.PI, 0.00001234) is left as it is, so nothing it says is lost.
const shortFloat32 = (written: string) => {
  const v = Number(written)
  if (Math.fround(v) !== v) return written
  for (let digits = 1; digits <= 9; digits++) {
    const short = String(Number(v.toPrecision(digits)))
    if (Math.fround(Number(short)) === v) return short.length < written.length ? short : written
  }
  return written
}

export const roundNoise = (text: string) => text.replace(LONG_NUMBER, shortFloat32)

const OPEN = /^(\s*)<([\w-]+)((?:\s+[\w-]+="[^"]*")*)\s*\/?>$/
const ATTR = /([\w-]+)="([^"]*)"/g
const CLOSING = /^\s*(?:<\/[\w-]+>)+/

export const OUTLINE_LEGEND = '[Figma metadata as an outline: type id "name" x,y width×height, each child one space in from its parent; a node whose name is its type (Frame, Group…) goes without it]'

// `get_metadata`'s XML as an outline, one node a line, the closing tags dropped since the indent
// says where a node ends; a line that is no tag (the note after it) is kept as it is. A line may end
// `\r\n`, as a server on Windows may send it.
export const outline = (text: string) => {
  const out: string[] = []
  let isTree = false
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(CLOSING, '')
    if (line !== raw) isTree = true
    if (line.trim() === '') {
      if (line === raw) out.push(line)
      continue
    }
    const m = OPEN.exec(line)
    if (!m) {
      out.push(line)
      continue
    }
    isTree = true
    const [, indent = '', tag = '', attrs = ''] = m
    const { id, name, x, y, width, height, ...rest } = Object.fromEntries([...attrs.matchAll(ATTR)].map(a => [a[1]!, a[2]!]))
    const parts = [tag]
    if (id !== undefined) parts.push(id)
    if (name !== undefined && name.toLowerCase() !== tag.toLowerCase()) parts.push(`"${name}"`)
    if (x !== undefined && y !== undefined) parts.push(`${x},${y}`)
    else if (x !== undefined || y !== undefined) parts.push(...(x !== undefined ? [`x=${x}`] : []), ...(y !== undefined ? [`y=${y}`] : []))
    if (width !== undefined && height !== undefined) parts.push(`${width}×${height}`)
    else if (width !== undefined || height !== undefined) parts.push(...(width !== undefined ? [`width=${width}`] : []), ...(height !== undefined ? [`height=${height}`] : []))
    for (const [k, v] of Object.entries(rest)) parts.push(`${k}=${v}`)
    out.push(`${' '.repeat(Math.floor(indent.length / 2))}${parts.join(' ')}`)
  }
  // Ended by a line break: the server sends its note after the tree as a block of its own, which
  // the model reads joined on, so the last node keeps a line to itself.
  return isTree ? `${OUTLINE_LEGEND}\n${out.join('\n').replace(/\n*$/, '\n')}` : text
}

// A `data-name` that says only what kind of node it is.
const GENERIC_NAME = / data-name="(?:Frame|Group|Rectangle|Vector|Ellipse|Line|Container)"/g

const CLASS = /className="([^"]*)"/g
// Where the constants go: right before the component, at the start of a line, so whatever leads
// the code (imports over several lines, a 'use client') stays as it was. They are read only when a
// component renders, so one declared above it may use them too.
const COMPONENT = [/^export default function /m, /^(?:export )?(?:default )?function \w/m]

// `get_design_context`'s code with each className used more than once, and long enough to be worth
// it, declared once as a constant before the component; the code means the same, the value kept
// exactly (written as a JSON string, so a `\/` in a class stays one). Code with no component to put
// them before is left as it is.
export const hoistClasses = (code: string, minLength = 24) => {
  const at = COMPONENT.map(re => code.search(re)).find(i => i >= 0) ?? -1
  if (at < 0) return code
  const counts = new Map<string, number>()
  for (const m of code.matchAll(CLASS)) counts.set(m[1]!, (counts.get(m[1]!) ?? 0) + 1)
  const hoisted = [...counts].filter(([c, n]) => n > 1 && c.length >= minLength).map(([c]) => c)
  if (hoisted.length === 0) return code
  const prefix = /\bcn\d+\b/.test(code) ? 'cls' : 'cn'
  const names = new Map(hoisted.map((c, i) => [c, `${prefix}${i + 1}`]))
  const decls = hoisted.map(c => `const ${names.get(c)} = ${JSON.stringify(c)}`).join('\n')
  const use = (part: string) => part.replace(CLASS, (all, c: string) => (names.has(c) ? `className={${names.get(c)}}` : all))
  return `${use(code.slice(0, at))}${decls}\n\n${use(code.slice(at))}`
}

export const isCode = (text: string) => text.includes('className="') && /\bexport default function\b|\bfunction \w+\(/.test(text)

const NODE_ID = /data-node-id="([^"]+)"/
const DATA_NAME = /data-name="([^"]*)"/
const SRC = /src=\{([^}]*)\}/g
const BARE_ID = /^\d+:\d+$/

const indentOf = (line: string) => line.length - line.trimStart().length
const isTag = (line: string) => line.trimStart().startsWith('<')
// A tag whose element goes on over the lines after it: not one that closes an element, closes
// itself, or whose element closes on its own line (`<p data-node-id="1:3">Pro</p>`).
const CLOSED_ON_LINE = /<\/[\w.-]*>\s*$/
const isOpening = (line: string) => isTag(line) && !line.trimStart().startsWith('</') && !line.trimEnd().endsWith('/>') && line.trimEnd().endsWith('>') && !CLOSED_ON_LINE.test(line)

// The line that closes the element `lines[at]` opens: the next closing tag at its indent, as the
// code Figma writes puts each tag on a line of its own; -1 where there is none.
const closingOf = (lines: readonly string[], at: number) => {
  const indent = indentOf(lines[at]!)
  for (let i = at + 1; i < lines.length; i++) if (indentOf(lines[i]!) === indent && lines[i]!.trimStart().startsWith('</')) return i
  return -1
}

type Slot = { id: string; value: string }

// An element's inside as a shape to compare: its lines from its own indent, each node id less
// `prefix`, each text and each `src={…}` a slot; and the slots, by the node they are in.
const shapeOf = (lines: readonly string[], indent: number, prefix: string) => {
  const slots: Slot[] = []
  const open: string[] = []
  const shape = lines.map(raw => {
    const line = raw.slice(indent).split(`data-node-id="${prefix}`).join('data-node-id="')
    if (!isTag(line)) {
      slots.push({ id: open.at(-1) ?? '', value: line.trim() })
      return `${' '.repeat(indentOf(line))}§`
    }
    if (line.trimStart().startsWith('</')) {
      open.pop()
      return line
    }
    const id = NODE_ID.exec(line)?.[1] ?? open.at(-1) ?? ''
    for (const m of line.matchAll(SRC)) slots.push({ id, value: `src={${m[1]}}` })
    if (isOpening(line)) open.push(id)
    return line.replace(SRC, 'src={§}')
  })
  return { shape: shape.join('\n'), slots }
}

type Template = { name: string; label: string; prefix: string; shape: string; slots: Slot[] }

// `get_design_context`'s code with each instance whose inside is a component's already in the code
// (the function Figma wrote for it, or an earlier instance written out whole) told in one line in
// place of that inside: what it is the same as, how its node ids read, and the texts and images that
// differ, by node. Nothing it says is lost; an inside that differs in anything else stays whole.
export const collapseInstances = (code: string) => {
  const lines = code.split(/\r?\n/)
  const templates: Template[] = []
  // The components Figma wrote as functions: the element each returns, its node ids as they are.
  // Only the first tag in the function's own body counts, and only with a node id of its own.
  for (let i = 0; i < lines.length; i++) {
    const fn = /^function (\w+)\(/.exec(lines[i]!)
    if (!fn) continue
    const body = lines.findIndex((l, k) => k > i && l.startsWith('}'))
    const root = lines.findIndex((l, k) => k > i && (body < 0 || k < body) && isTag(l))
    const end = root >= 0 && isOpening(lines[root]!) && NODE_ID.test(lines[root]!) ? closingOf(lines, root) : -1
    if (end < 0 || (body >= 0 && end > body)) continue
    const id = NODE_ID.exec(lines[root]!)![1]!
    const { shape, slots } = shapeOf(lines.slice(root + 1, end), indentOf(lines[root]!), '')
    templates.push({ name: DATA_NAME.exec(lines[root]!)?.[1] ?? '', label: `<${fn[1]}> (${id})`, prefix: '', shape, slots })
  }
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const id = NODE_ID.exec(line)?.[1]
    const end = id && BARE_ID.test(id) && isOpening(line) ? closingOf(lines, i) : -1
    const inside = end < 0 ? [] : lines.slice(i + 1, end)
    const prefix = `I${id};`
    const isInstance = inside.some(l => NODE_ID.test(l)) && inside.every(l => !NODE_ID.test(l) || NODE_ID.exec(l)![1]!.startsWith(prefix))
    if (!isInstance) {
      out.push(line)
      continue
    }
    const indent = indentOf(line)
    const { shape, slots } = shapeOf(inside, indent, prefix)
    const name = DATA_NAME.exec(line)?.[1] ?? ''
    const same = templates.find(t => t.name === name && t.shape === shape)
    if (!same) {
      templates.push({ name, label: `${id} above`, prefix, shape, slots })
      out.push(line)
      continue
    }
    // A slot is named by the component's own id of its node, as the line says how to read it here;
    // its value a JSON string in which the slash of any star-slash is written as the JSON escape
    // for a slash (backslash, u002f): the same string to JSON.parse, and a text holding a
    // star-slash no longer ends the comment.
    const differs = slots.filter((s, k) => s.value !== same.slots[k]?.value).map(s => `${s.id} ${JSON.stringify(s.value).replaceAll('*/', '*\\u002f')}`)
    const ids = same.prefix ? `"${prefix}" + its own ids (there after "${same.prefix}")` : `"${prefix}" + its own ids`
    const note = `${' '.repeat(indent + 2)}{/* inside as ${same.label}, node ids ${ids}${differs.length ? `; differs at its own ids: ${differs.join(', ')}` : ''} */}`
    if (note.length >= inside.join('\n').length) {
      out.push(line)
      continue
    }
    out.push(line, note, lines[end]!)
    i = end
  }
  return out.join('\n')
}

// One text block of a Figma tool's result, squeezed by what the tool is.
export const figma: Pack = {
  id: 'figma',
  label: 'Figma',
  // `figma`, `claude_ai_Figma`, `figma-dev-mode`, a plugin's `plugin_figma_figma`.
  server: /.*figma.*/,
  legend: OUTLINE_LEGEND,
  squeezeText: (tool, text) => {
    const out = roundNoise(text)
    if (tool.endsWith('__get_metadata')) return outline(out)
    if (tool.endsWith('__get_design_context') && isCode(out)) return hoistClasses(collapseInstances(out).replace(GENERIC_NAME, ''))
    return out
  },
}
