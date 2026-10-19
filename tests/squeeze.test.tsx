import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { MCP_TOOL, packOf } from '../hooks/packs'
import { collapseInstances, hoistClasses, imageTokens, outline, OUTLINE_LEGEND, pngSize, REPEAT_MIN, repeatNote, roundNoise, shortenTokens, squeezeText, tokenNote, tokensOf } from '../hooks/squeeze'

const repeatNoteLength = (text: string) => repeatNote(text).length

const META = `<frame id="30:57" name="Page" x="0" y="0" width="1440" height="5400">
  <frame id="30:58" name="Hero" x="0" y="0" width="1440" height="900">
    <text id="30:63" name="Привет, мир" x="232" y="196" width="977" height="64" />
    <frame id="30:67" name="Frame" x="408" y="46.5" width="64" height="64">
      <instance id="30:68" name="Icon/star" x="18" y="18" width="28" height="28" />
    </frame>
  </frame>
</frame>IMPORTANT: After you call this tool, you MUST call get_design_context if trying to implement the design.`

const CODE = `import { motion } from "motion/react";

export default function Landing() {
  return (
    <div className="bg-[var(--surface\\/base,#101010)] relative size-full" data-node-id="31:251" data-name="Landing">
      <div className="bg-[var(--surface\\/raised,#202020)] flex px-[28px] py-[14px] rounded-[999px]" data-node-id="31:254" data-name="Frame">One</div>
      <div className="bg-[var(--surface\\/raised,#202020)] flex px-[28px] py-[14px] rounded-[999px]" data-node-id="31:256" data-name="Frame">Two</div>
      <p className="leading-[1.1299999952316284]" data-node-id="31:257">x</p>
    </div>
  );
}`

test('metadata becomes an outline: ids, names, positions and sizes kept, closing tags and type names dropped', () => {
  expect(outline(META).split('\n')).toEqual([
    OUTLINE_LEGEND,
    'frame 30:57 "Page" 0,0 1440×5400',
    ' frame 30:58 "Hero" 0,0 1440×900',
    '  text 30:63 "Привет, мир" 232,196 977×64',
    '  frame 30:67 408,46.5 64×64',
    '   instance 30:68 "Icon/star" 18,18 28×28',
    'IMPORTANT: After you call this tool, you MUST call get_design_context if trying to implement the design.',
    '',
  ])
  // The tree alone, as the server sends it before its note in a block of its own: it ends on a
  // line break, so the note does not run on from the last node.
  expect(outline(META.slice(0, META.indexOf('IMPORTANT')))).toMatch(/instance 30:68 "Icon\/star" 18,18 28×28\n$/)
  // A repeat names how the tree starts, not the legend every outline starts with.
  expect(repeatNote(outline(META))).toMatch(/starting "frame 30:57 "Page" 0,0 1440×5400/)
  // A text with no tags is left as it is.
  expect(outline('No node found.')).toBe('No node found.')
})

test('a className used twice is declared once, its value kept exactly; float noise rounded', () => {
  const out = hoistClasses(CODE)
  expect(out).toMatch(/^import \{ motion \} from "motion\/react";\n\nconst cn1 = "bg-\[var\(--surface\\\\\/raised,#202020\)\] flex px-\[28px\] py-\[14px\] rounded-\[999px\]"\n\nexport default function Landing/)
  // The constant reads back as the very class the code had.
  expect(JSON.parse(/const cn1 = (".*")/.exec(out)![1]!)).toBe('bg-[var(--surface\\/raised,#202020)] flex px-[28px] py-[14px] rounded-[999px]')
  expect(out.match(/className=\{cn1\}/g)).toHaveLength(2)
  // Used once, it stays where it is.
  expect(out).toContain('className="bg-[var(--surface\\/base,#101010)] relative size-full"')
  expect(roundNoise('lineHeight: 1.1299999952316284, x1: 0.6499999761581421, id 30:57, 46.5')).toBe('lineHeight: 1.13, x1: 0.65, id 30:57, 46.5')
  // A number that is no float32 value says just what it says, small, precise or worked out in
  // doubles (200.00000298023224 ms from a float32 of seconds).
  expect(roundNoise('0.00001234 3.141592653589793 0.1234567 200.00000298023224')).toBe('0.00001234 3.141592653589793 0.1234567 200.00000298023224')
  // Whatever leads the code stays as it was: the constants go right before the component.
  const led = hoistClasses(`'use client'\nimport {\n  motion,\n} from "motion/react";\n\n${CODE.slice(CODE.indexOf('export default'))}`)
  expect(led).toMatch(/^'use client'\nimport \{\n  motion,\n\} from "motion\/react";\n\nconst cn1 = "[^\n]*"\n\nexport default function Landing/)
  expect(hoistClasses('<div className="a long class, used twice here" /><div className="a long class, used twice here" />')).toBe(
    '<div className="a long class, used twice here" /><div className="a long class, used twice here" />',
  )
  const squeezed = squeezeText('mcp__figma__get_design_context', CODE)
  expect(squeezed).not.toContain('data-name="Frame"')
  expect(squeezed).toContain('data-name="Landing"')
  expect(squeezed).toContain('leading-[1.13]')
  // Never longer than it came.
  expect(squeezeText('mcp__figma__get_design_context', 'short')).toBe('short')
})

const LONG = `${'Lorem ipsum dolor sit amet. '.repeat(Math.ceil(REPEAT_MIN / 28))}`

// The session, with core answering each Figma tool by `answers`, by tool name.
const session = async ($: Parameters<TestBody>[0], on: Parameters<TestBody>[1], answers: Record<string, unknown>) => {
  const store = new Map<string, unknown>()
  // 19 October 2026, noon UTC.
  mock.clock(on, { now: Date.UTC(2026, 9, 19, 12) })
  on('store.get', ($, e) => ({ value: store.get(e.key) }))
  on('store.set', ($, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('command.register', () => ({ value: { command: 'squeeze' } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  // A compact told to keep nothing is one the engine skips.
  on('session.compact', ($, e) => (e.instructions === 'skip' ? { skip: 'nothing to compact' } : { messages: e.messages }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('tool.call', ($, e) => {
    // A name no connected server has, so compared as a string.
    if (String(e.tool) === 'mcp__figma__broken') return { result: 'Server error', isError: true as const, text: 'Server error' }
    const result = answers[e.tool]
    return { result, text: '' }
  })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  const call = async (tool: string, agentId?: string) => {
    const r = await $.tool.call({ tool, ...(agentId ? { agentId } : {}) } as never)
    return (r as { result?: unknown }).result
  }
  const run = async (command: string, args = '') => (await $.command.run({ command, args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })).text
  // A compact of the main conversation, or of an agent's own, as the engine raises it.
  const compact = (trigger: 'manual' | 'auto' | 'precompute' = 'manual', options: { agentId?: string; instructions?: string } = {}) =>
    $.session.compact({ trigger, messages: [{ role: 'user', text: 'The conversation so far, summed up.', toolUses: [] }], ...options })
  const clear = () => $.session.end({ reason: 'clear', sessionId: 'session-1', resume: { id: 'session-1' } })
  return { call, squeeze: (args = '') => run('squeeze', args), gain: () => run('squeeze-gain'), compact, clear, store }
}

const textOf = (result: unknown) => (result as { type: string; text?: string }[]).map(b => b.text ?? `<${b.type}>`).join('|')

// Other names a Figma server goes by in people's configs: the Dev Mode server's, the Figma
// plugin's, one named by hand; each one's metadata of a page of its own, so none is a repeat.
const SERVERS = ['figma-dev-mode', 'plugin_figma_figma', 'Figma_Desktop']
const metaOf = (server: string) => META.replace('name="Page"', `name="${server}"`)

test('a Figma result is squeezed for the model; images and other tools pass as they came', async ($, on) => {
  const IMAGE = { type: 'image', data: 'AAAA', mimeType: 'image/png' }
  const { call } = await session($, on, {
    mcp__figma__get_metadata: [{ type: 'text', text: META }],
    mcp__claude_ai_Figma__get_design_context: [{ type: 'text', text: CODE }, IMAGE],
    mcp__linear__list_issues: [{ type: 'text', text: 'width: 1.1299999952316284' }],
    ...Object.fromEntries(SERVERS.map(server => [`mcp__${server}__get_metadata`, [{ type: 'text', text: metaOf(server) }]])),
    mcp__linear__figma_get_metadata: [{ type: 'text', text: META }],
  })
  expect(textOf(await call('mcp__figma__get_metadata'))).toBe(outline(META))
  // Whatever this person's config names the Figma server; another server's tool named for Figma is
  // not one of its.
  for (const server of SERVERS) expect(textOf(await call(`mcp__${server}__get_metadata`))).toBe(outline(metaOf(server)))
  expect(textOf(await call('mcp__linear__figma_get_metadata'))).toBe(META)
  const context = (await call('mcp__claude_ai_Figma__get_design_context')) as unknown[]
  expect(textOf(context)).toContain('className={cn1}')
  expect(context[1]).toEqual(IMAGE)
  expect(textOf(await call('mcp__linear__list_issues'))).toBe('width: 1.1299999952316284')
  expect(await call('mcp__figma__broken')).toBe('Server error')
})

test('a block returned again is left out once, then comes whole; a compact or another agent starts over', async ($, on) => {
  const { call, compact } = await session($, on, { mcp__figma__use_figma: [{ type: 'text', text: LONG }] })
  const REPEAT = /^\[The same \d+ characters this tool returned earlier in this conversation, starting "Lorem ipsum/
  expect(textOf(await call('mcp__figma__use_figma'))).toBe(LONG)
  expect(textOf(await call('mcp__figma__use_figma'))).toMatch(REPEAT)
  expect(textOf(await call('mcp__figma__use_figma'))).toBe(LONG)
  // A subagent has a context of its own.
  expect(textOf(await call('mcp__figma__use_figma', 'agent-1'))).toBe(LONG)
  // A summary worked out ahead of time, or a compact skipped, leaves the context as it was.
  await compact('precompute')
  await compact('manual', { instructions: 'skip' })
  expect(textOf(await call('mcp__figma__use_figma'))).toMatch(REPEAT)
  expect(textOf(await call('mcp__figma__use_figma'))).toBe(LONG)
  // A compact starts over the context it compacted, the main one's here, not the subagent's.
  await compact('auto')
  expect(textOf(await call('mcp__figma__use_figma'))).toBe(LONG)
  expect(textOf(await call('mcp__figma__use_figma', 'agent-1'))).toMatch(REPEAT)
  await compact('auto', { agentId: 'agent-1' })
  expect(textOf(await call('mcp__figma__use_figma', 'agent-1'))).toBe(LONG)
  expect(textOf(await call('mcp__figma__use_figma'))).toMatch(REPEAT)
})

test('a /clear starts a new conversation: what was returned and what was kept out start over', async ($, on) => {
  const { call, squeeze, compact, clear } = await session($, on, { mcp__figma__use_figma: [{ type: 'text', text: LONG }] })
  await call('mcp__figma__use_figma')
  expect(await squeeze()).toMatch(/This conversation: 1 MCP call/)
  await clear()
  expect(await squeeze()).toMatch(/^MCP squeeze is on\. No MCP tool has answered/)
  expect(textOf(await call('mcp__figma__use_figma'))).toBe(LONG)
  // A compact starts over what was returned, not what was kept out.
  await compact()
  expect(textOf(await call('mcp__figma__use_figma'))).toBe(LONG)
  expect(await squeeze()).toMatch(/This conversation: 2 MCP calls/)
})

test('/squeeze-gain says the tokens saved: this conversation, all time past a /clear, by tool', async ($, on) => {
  const { call, gain, clear } = await session($, on, {
    mcp__figma__get_metadata: [{ type: 'text', text: META }],
    mcp__figma__use_figma: [{ type: 'text', text: LONG }],
  })
  expect(await gain()).toBe(
    "Tokens the MCP tools' results did not bring into the context (text estimated at 3.5 characters a token, an image at a token per 750 pixels):\n\nthis conversation     0 calls  saved ≈      0 tokens  text      0 →      0 (−0%)",
  )
  // Metadata squeezed, then use_figma whole and again left out: what each kept out is summed.
  await call('mcp__figma__get_metadata')
  await call('mcp__figma__use_figma')
  await call('mcp__figma__use_figma')
  const kept = (META.length - outline(META).length + LONG.length - repeatNoteLength(LONG)) / 3.5
  const lines = (await gain())!.split('\n')
  expect(lines[2]).toMatch(new RegExp(`^this conversation\\s+3 calls  saved ≈\\s+${Math.round(kept)} tokens`))
  expect(lines[3]).toMatch(/^all time, since 2026-10-19\s+3 calls/)
  // By tool, the one that saved the most first.
  expect(lines.slice(5)).toEqual(['By tool, all time:', expect.stringMatching(/^  get_metadata\s+1 call /), expect.stringMatching(/^  use_figma\s+2 calls/)])
  // A /clear starts the conversation over; all time keeps counting.
  await clear()
  await call('mcp__figma__get_metadata')
  const after = (await gain())!.split('\n')
  expect(after[2]).toMatch(/^this conversation\s+1 call /)
  expect(after[3]).toMatch(/^all time, since 2026-10-19\s+4 calls/)
})

// The header of a 1024×563 PNG, all the mod reads of one.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAABAAAAAIzCAYAAAA='

test('an image returned again is left out once, its size named and its tokens counted', async ($, on) => {
  expect(pngSize(PNG)).toEqual({ width: 1024, height: 563 })
  expect(pngSize('/9j/4AAQSkZJRgABAQAAAQABAAD/')).toBeUndefined()
  expect(imageTokens({ width: 1024, height: 563 })).toBe(769)
  // Scaled to 1568 pixels a side and 1.15 megapixels first.
  expect(imageTokens({ width: 4000, height: 2000 })).toBe(imageTokens({ width: 1517, height: 758 }))
  const SHOT = { type: 'image', data: PNG, mimeType: 'image/png' }
  // A JPEG, whose size it does not read, so whose saving it could not count.
  const PHOTO = { type: 'image', data: '/9j/4AAQSkZJRgABAQAAAQABAAD/', mimeType: 'image/jpeg' }
  const { call, gain, squeeze } = await session($, on, { mcp__figma__get_screenshot: [SHOT], mcp__figma__get_photo: [PHOTO] })
  expect(await call('mcp__figma__get_screenshot')).toEqual([SHOT])
  expect(textOf(await call('mcp__figma__get_screenshot'))).toMatch(/^\[The same image \(image\/png, 1024×563\) this tool returned earlier in this conversation: left out/)
  expect(await call('mcp__figma__get_screenshot')).toEqual([SHOT])
  expect(await call('mcp__figma__get_photo')).toEqual([PHOTO])
  expect(await call('mcp__figma__get_photo')).toEqual([PHOTO])
  expect((await gain())!.split('\n')[2]).toMatch(/^this conversation\s+5 calls  saved ≈\s+\d+ tokens .*  images left out: 1 \(≈ 769\)$/)
  // No text came, so none was squeezed: the note in the image's place counts as no change.
  expect(await squeeze()).toMatch(/^MCP squeeze is on\. This conversation: 5 MCP calls, 0 → \d+ characters \(−0%\), 1 repeated image left out; about \d+ tokens kept out of the context\./)
})

test('text grown by an image\'s note is said to have grown, the sign once', async ($, on) => {
  const SHOT = { type: 'image', data: PNG, mimeType: 'image/png' }
  const { call, gain, squeeze } = await session($, on, { mcp__figma__get_screenshot: [{ type: 'text', text: 'Node 1:2' }, SHOT] })
  await call('mcp__figma__get_screenshot')
  await call('mcp__figma__get_screenshot')
  const report = (await squeeze())!
  expect(report).toMatch(/This conversation: 2 MCP calls, 16 → \d+ characters \(\+\d+%\), 1 repeated image left out/)
  expect(report).toMatch(/\n  get_screenshot\s+2 ×\s+16 →\s+\d+  \+\d+%\n/)
  expect((await gain())!.split('\n')[2]).toMatch(/text\s+5 →\s+\d+ \(\+\d+%\)  images left out: 1/)
  expect(`${report}${await gain()}`).not.toMatch(/−-|\+-/)
})

const CARD = 'bg-white border border-[#e0e3ed] content-stretch flex flex-col gap-[16px] p-[28px] rounded-[20px] w-[320px]'
const NAME = "font-['Inter:Semi_Bold'] font-semibold leading-[1.3] text-[#121726] text-[18px] whitespace-nowrap"
const DOT = 'relative shrink-0 size-[8px]'
const INSTANCES = `function PlanCard({ className, plan = "Starter" }: PlanCardProps) {
  return (
    <div className={className || "${CARD}"} data-node-id="1:2" data-name="Plan card">
      <p className="${NAME}" data-node-id="1:3">
        {plan}
      </p>
      <div className="${DOT}" data-node-id="1:7" data-name="Check">
        <img alt="" className="absolute block inset-0 size-full" src={imgCheck} />
      </div>
    </div>
  );
}

export default function Pricing() {
  return (
    <div className="bg-[#f7f7fc] flex gap-[24px]" data-node-id="1:20" data-name="Pricing">
      <div className="${CARD}" data-node-id="1:42" data-name="Plan card">
        <p className="${NAME}" data-node-id="I1:42;1:3">
          Pro
        </p>
        <div className="${DOT}" data-node-id="I1:42;1:7" data-name="Check">
          <img alt="" className="absolute block inset-0 size-full" src={imgCheck} />
        </div>
      </div>
      <div className="${CARD}" data-node-id="1:60" data-name="Plan card">
        <p className="${NAME} underline" data-node-id="I1:60;1:3">
          Team
        </p>
        <div className="${DOT}" data-node-id="I1:60;1:7" data-name="Check">
          <img alt="" className="absolute block inset-0 size-full" src={imgCheck} />
        </div>
      </div>
      <div className="${CARD}" data-node-id="1:78" data-name="Plan card">
        <p className="${NAME} underline" data-node-id="I1:78;1:3">
          Enterprise
        </p>
        <div className="${DOT}" data-node-id="I1:78;1:7" data-name="Check">
          <img alt="" className="absolute block inset-0 size-full" src={imgStar} />
        </div>
      </div>
    </div>
  );
}`

test('an instance whose inside is its component\'s is told in a line: what it is the same as, its ids, what differs', () => {
  const out = collapseInstances(INSTANCES).split('\n')
  // Like the function Figma wrote, but for its text.
  const pro = out.indexOf(`      <div className="${CARD}" data-node-id="1:42" data-name="Plan card">`)
  expect(out.slice(pro + 1, pro + 3)).toEqual(['        {/* inside as <PlanCard> (1:2), node ids "I1:42;" + its own ids; differs at its own ids: 1:3 "Pro" */}', '      </div>'])
  // Its text underlined: like no component in the code, so whole; then the next like it, but for
  // its text and its image.
  const team = out.indexOf(`      <div className="${CARD}" data-node-id="1:60" data-name="Plan card">`)
  expect(out[team + 1]).toBe(`        <p className="${NAME} underline" data-node-id="I1:60;1:3">`)
  const enterprise = out.indexOf(`      <div className="${CARD}" data-node-id="1:78" data-name="Plan card">`)
  expect(out[enterprise + 1]).toBe(
    '        {/* inside as 1:60 above, node ids "I1:78;" + its own ids (there after "I1:60;"); differs at its own ids: 1:3 "Enterprise", 1:7 "src={imgStar}" */}',
  )
  // The function itself, and code with no instance, stay as they were.
  expect(out.slice(0, 11).join('\n')).toBe(INSTANCES.split('\n').slice(0, 11).join('\n'))
  expect(collapseInstances(CODE)).toBe(CODE)
})

test('a component whose element has no node id is no template, and a text holding */ keeps the comment closed', () => {
  // PlanCard's element has no node id: the first instance stays whole, rather than told as the
  // element of the function after it; the second is told as the first.
  const noId = INSTANCES.replace(' data-node-id="1:2" data-name="Plan card"', '').replace('          Team', '          Pro').replace(' underline', '').replace(' underline', '')
  const lines = collapseInstances(noId).split('\n')
  expect(lines.some(l => l.includes('inside as <PlanCard>'))).toBe(false)
  expect(lines.filter(l => l.includes('inside as 1:42 above'))).toHaveLength(2)
  // A text that would end the comment is written so it cannot, and reads back as it was.
  const closing = collapseInstances(INSTANCES.replace('          Pro', '          a */ b'))
  const note = closing.split('\n').find(l => l.includes('inside as <PlanCard>'))!
  expect(note.match(/\*\//g)).toHaveLength(1)
  expect(JSON.parse(/1:3 (".*?") \*\/\}$/.exec(note)![1]!)).toBe('a */ b')
})

const BODY = 'content-stretch flex flex-col gap-[4px] items-start px-[12px] py-[6px] rounded-[8px]'
const LABEL = "font-['Inter:Medium'] leading-[1.4] text-[#5b6170] text-[12px] whitespace-nowrap"
const BADGES = `function Badge() {
  return (
    <div className="${DOT}" data-node-id="2:1" data-name="Badge">
      <div className="${BODY}" data-node-id="2:2" data-name="Body">
        <p className="${LABEL}" data-node-id="2:3">Plan</p>
        <span>
          Free
        </span>
      </div>
    </div>
  );
}

export default function Page() {
  return (
    <div className="${DOT}" data-node-id="2:20" data-name="Badge">
      <div className="${BODY}" data-node-id="I2:20;2:2" data-name="Body">
        <p className="${LABEL}" data-node-id="I2:20;2:3">Plan</p>
        <span>
          Paid
        </span>
      </div>
    </div>
  );
}`

test('a tag whose element closes on its own line opens none: a text after it is told by the node it is in', () => {
  const out = collapseInstances(BADGES).split('\n')
  const badge = out.indexOf(`    <div className="${DOT}" data-node-id="2:20" data-name="Badge">`)
  // "Paid" is in Body (2:2), not in the label closed on its line before it (2:3).
  expect(out.slice(badge + 1, badge + 3)).toEqual(['      {/* inside as <Badge> (2:1), node ids "I2:20;" + its own ids; differs at its own ids: 2:2 "Paid" */}', '    </div>'])
})

test('a result with Windows line breaks (\\r\\n) is squeezed as with \\n; one with nothing to squeeze comes as it came', async ($, on) => {
  const crlf = (text: string) => text.replaceAll('\n', '\r\n')
  expect(outline(crlf(META))).toBe(outline(META))
  expect(collapseInstances(crlf(INSTANCES))).toBe(collapseInstances(INSTANCES))
  expect(collapseInstances(crlf(BADGES))).toBe(collapseInstances(BADGES))
  for (const [tool, text] of [
    ['mcp__figma__get_metadata', META],
    ['mcp__figma__get_design_context', INSTANCES],
    ['mcp__figma__get_design_context', CODE],
  ] as const) {
    expect(squeezeText(tool, crlf(text))).toBe(squeezeText(tool, text))
    expect(squeezeText(tool, crlf(text))).not.toContain('\r')
  }
  const plain = crlf('No node found.\nTry another node id.')
  expect(squeezeText('mcp__figma__get_design_context', plain)).toBe(plain)
  expect(squeezeText('mcp__figma__get_metadata', plain)).toBe(plain)
  // Through the hook, as a server on Windows sends it.
  const { call } = await session($, on, { mcp__figma__get_metadata: [{ type: 'text', text: crlf(META) }] })
  expect(textOf(await call('mcp__figma__get_metadata'))).toBe(outline(META))
})

test('/squeeze says what it kept out, and turns it off and on', async ($, on) => {
  const { call, squeeze } = await session($, on, { mcp__figma__get_metadata: [{ type: 'text', text: META }] })
  expect(await squeeze()).toMatch(/^MCP squeeze is on\. No MCP tool has answered/)
  await call('mcp__figma__get_metadata')
  expect(await squeeze()).toMatch(/^MCP squeeze is on\. This conversation: 1 MCP call, \d+ → \d+ characters \(−\d+%\); about \d+ tokens kept out of the context\.\n  get_metadata    1 ×/)
  expect(await squeeze('off')).toMatch(/^MCP squeeze is off\./)
  expect(textOf(await call('mcp__figma__get_metadata'))).toBe(META)
  expect(await squeeze('on')).toMatch(/^MCP squeeze is on\./)
  expect(await squeeze('maybe')).toBe('Usage: /squeeze, /squeeze on, /squeeze off, /squeeze <pack> on, /squeeze <pack> off (figma, other)')
  expect(await squeeze('chrome off')).toMatch(/^Usage: /)
})

test('/squeeze <pack> off turns that pack alone off, kept in the store; a tool belongs to a pack by its server', async ($, on) => {
  const { call, squeeze, store } = await session($, on, { mcp__figma__get_metadata: [{ type: 'text', text: META }] })
  expect(await squeeze()).toContain('\nPacks: figma on, other on.\n')
  expect(await squeeze('figma off')).toMatch(/^MCP squeeze is on\. No MCP tool has answered in this conversation yet\.\nPacks: figma off, other on\.\n/)
  expect(store.get('off:figma')).toBe(true)
  expect(textOf(await call('mcp__figma__get_metadata'))).toBe(META)
  expect(await squeeze('Figma  ON')).toContain('\nPacks: figma on, other on.\n')
  expect(textOf(await call('mcp__figma__get_metadata'))).toBe(outline(META))
  expect(packOf('mcp__figma__get_metadata')?.id).toBe('figma')
  expect(packOf('mcp__claude_ai_Figma__use_figma')?.id).toBe('figma')
  expect(packOf('mcp__chrome-devtools__take_snapshot')).toBeUndefined()
  // Another server's tool named for Figma: an MCP tool the hook sees, of no pack.
  expect(packOf('mcp__linear__figma_get_metadata')).toBeUndefined()
  for (const tool of ['mcp__figma-dev-mode__get_metadata', 'mcp__linear__figma_get_metadata', 'mcp__chrome-devtools__click']) expect(MCP_TOOL.test(tool)).toBe(true)
  expect(MCP_TOOL.test('figma_export')).toBe(false)
  // A tool of no MCP server, though its name says figma.
  expect(packOf('figma_export')).toBeUndefined()
})

test('the all-time count an earlier version kept, by tool name alone, counts as the Figma pack\'s', async ($, on) => {
  const { call, gain, store } = await session($, on, { mcp__figma__get_metadata: [{ type: 'text', text: META }] })
  store.set('total', { since: Date.UTC(2026, 9, 1), tools: { get_metadata: { calls: 2, before: 7000, after: 3500 } } })
  await call('mcp__figma__get_metadata')
  const lines = (await gain())!.split('\n')
  expect(lines[3]).toMatch(/^all time, since 2026-10-01\s+3 calls/)
  expect(lines.slice(5)).toEqual(['By tool, all time:', expect.stringMatching(/^  get_metadata\s+3 calls/)])
  // Kept back under the pack's key, the earlier one gone.
  expect(Object.keys((store.get('total') as { tools: object }).tools)).toEqual(['figma:get_metadata'])
})

test('a tool no pack takes has its repeats left out too, counted by its server; /squeeze other off lets it be', async ($, on) => {
  const { call, squeeze, gain } = await session($, on, {
    'mcp__chrome-devtools__evaluate_script': [{ type: 'text', text: LONG }],
    mcp__figma__use_figma: [{ type: 'text', text: LONG }],
  })
  expect(textOf(await call('mcp__chrome-devtools__evaluate_script'))).toBe(LONG)
  expect(textOf(await call('mcp__chrome-devtools__evaluate_script'))).toMatch(/^\[The same \d+ characters this tool returned earlier/)
  await call('mcp__figma__use_figma')
  // Two groups answered, so each row names its pack or server.
  const report = (await squeeze())!
  expect(report).toMatch(/\n  chrome-devtools evaluate_script\s+2 ×/)
  expect(report).toMatch(/\n  figma use_figma\s+1 ×/)
  expect((await gain())!.split('\n').slice(5)).toEqual(['By tool, all time:', expect.stringMatching(/^  chrome-devtools evaluate_script\s+2 calls/), expect.stringMatching(/^  figma use_figma\s+1 call /)])
  expect(await squeeze('other off')).toContain('\nPacks: figma on, other off.\n')
  expect(textOf(await call('mcp__chrome-devtools__evaluate_script'))).toBe(LONG)
  expect(textOf(await call('mcp__chrome-devtools__evaluate_script'))).toBe(LONG)
  // The Figma pack goes on.
  expect(textOf(await call('mcp__figma__use_figma'))).toMatch(/^\[The same/)
})

const JWT = `eyJhbGciOiJSUzI1NiIsInR5cCIgOiAiSldUIn0.${'eyJzdWIiOiIxMTExMTExMS0xMTExLTQxMTEtODExMS0xMTExMTExMTExMTEiLCJleHAiOjE3OTI0NDM2NDB9'.repeat(2)}.${'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'.repeat(3)}`
const request = (path: string) => `## Request https://example.test/api/${path}\nStatus: 200\n- authorization:Bearer ${JWT}\n`

test('a long token that came whole before is told by a note, the next whole again; a path or a short token is left as it is', () => {
  const seen = new Map<string, boolean>()
  const isRepeat = (key: string) => {
    const was = seen.get(key) === true
    seen.set(key, !was)
    return was
  }
  expect(tokensOf(request('a'))).toEqual([JWT])
  expect(shortenTokens(request('a'), isRepeat)).toBe(request('a'))
  const second = shortenTokens(request('b'), isRepeat)
  expect(second).toBe(request('b').replace(JWT, tokenNote(JWT)))
  expect(second).toContain(`[the same ${JWT.length}-character token as earlier in this conversation, ${JWT.slice(0, 12)}…${JWT.slice(-6)}]`)
  expect(shortenTokens(request('c'), isRepeat)).toBe(request('c'))
  // A data URI's base64, past its comma.
  const png = `data:image/png;base64,${'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk'.repeat(4)}`
  expect(tokensOf(png)).toEqual([png.slice(png.indexOf(',') + 1)])
  // A long path, a long word, a short token: none is opaque.
  const path = `/home/${'timePlanning/Department42/'.repeat(8)}`
  expect(tokensOf(`${path} ${'a'.repeat(200)} eyJhbGciOiJIUzI1NiJ9.e30.abc123XYZ`)).toEqual([])
})

test('in the results, a token that came whole is told by a note in another; a copy called for again comes with its tokens whole', async ($, on) => {
  const { call } = await session($, on, {
    'mcp__chrome-devtools__get_network_request': [{ type: 'text', text: request('a') }],
    'mcp__chrome-devtools__list_network_requests': [{ type: 'text', text: request('b') }],
    'mcp__chrome-devtools__list_console_messages': [{ type: 'text', text: request('c') }],
  })
  expect(textOf(await call('mcp__chrome-devtools__get_network_request'))).toBe(request('a'))
  expect(textOf(await call('mcp__chrome-devtools__list_network_requests'))).toBe(request('b').replace(JWT, tokenNote(JWT)))
  // The same block again is left out whole, its token untouched; the copy after it, called for
  // again, comes whole, token and all.
  expect(textOf(await call('mcp__chrome-devtools__get_network_request'))).toMatch(/^\[The same \d+ characters/)
  expect(textOf(await call('mcp__chrome-devtools__get_network_request'))).toBe(request('a'))
  // The token came whole there, so in a request after it the note stands again.
  expect(textOf(await call('mcp__chrome-devtools__list_console_messages'))).toBe(request('c').replace(JWT, tokenNote(JWT)))
})
