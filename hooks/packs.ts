// The packs: each one squeezes the tools of the MCP servers it knows, by what each tool returns. A
// tool no pack takes has only what the mod does to every MCP tool (repeats left out).
import type { Memory } from '../types'
import { chrome } from './chrome.ts'
import { figma } from './figma.ts'

export type Pack = {
  // How the pack is named in the stats and in `/squeeze <id> off`.
  id: string
  // The names of the servers whose tools the pack takes, whatever a config names them, matched
  // whole and in any case, as they read in a tool's name: `claude_ai_Figma` in
  // `mcp__claude_ai_Figma__get_metadata`.
  server: RegExp
  // A line the pack starts a kind of block with, passed over where a repeat quotes how one starts.
  legend?: string
  // The lines that say a state the server keeps and says again after each call, each pattern's
  // first group the label and its second the value: where the value is the one the last such line
  // said, the line says so in its place.
  states?: readonly RegExp[]
  // One text block of the tool's result, squeezed; the caller keeps the original where it is no
  // shorter.
  squeezeText: (tool: string, text: string) => string
  // The block squeezed, as the pack tells it by what it holds of this agent's conversation:
  // `memory`, its keys under its id, kept up for the next (a page's last snapshot); `isAgain` for
  // the copy the model called for again, after one left out. `isWhole` where the pack gives it
  // whole as the model called for it so, which no repeat then leaves out.
  tell?: (tool: string, text: string, memory: Memory, isAgain: boolean) => { text: string; isWhole?: boolean }
}

export const packs: readonly Pack[] = [figma, chrome]

const isServer = (pack: Pack, server: string) => new RegExp(`^(?:${pack.server.source})$`, 'i').test(server)

// The pack that takes an MCP tool, by its server, the part of the name before the last `__`, so
// another server's `figma_export` is no Figma tool; none for a tool of no MCP server.
export const packOf = (tool: string) => {
  if (!tool.startsWith('mcp__') || tool.lastIndexOf('__') < 5) return undefined
  const server = tool.slice(5, tool.lastIndexOf('__'))
  return packs.find(p => isServer(p, server))
}

// Every MCP server's tools, for a hook's matcher, so the hook never sees any other: the server the
// part of the name before the last `__`.
export const MCP_TOOL = /^mcp__.+__(?:(?!__).)+$/

// The tools no pack takes, as `/squeeze other off` names them.
export const OTHER = 'other'

// What `/squeeze <name> on|off` turns: each pack, and the tools no pack takes.
export const switches = [...packs.map(p => p.id), OTHER]

// The tool's group in the stats: its pack, or else its server.
export const groupOf = (tool: string) => packOf(tool)?.id ?? tool.slice(5, tool.lastIndexOf('__'))
