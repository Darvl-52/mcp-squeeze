// The packs: each one squeezes the tools of the MCP servers it knows, by what each tool returns. A
// tool no pack takes passes as it came.
import { figma } from './figma.ts'

export type Pack = {
  // How the pack is named in the stats and in `/squeeze <id> off`.
  id: string
  // How the pack is named in a sentence: "the Figma tools".
  label: string
  // The names of the servers whose tools the pack takes, whatever a config names them, matched
  // whole and in any case, as they read in a tool's name: `claude_ai_Figma` in
  // `mcp__claude_ai_Figma__get_metadata`.
  server: RegExp
  // A line the pack starts a kind of block with, passed over where a repeat quotes how one starts.
  legend?: string
  // One text block of the tool's result, squeezed; the caller keeps the original where it is no
  // shorter.
  squeezeText: (tool: string, text: string) => string
}

export const packs: readonly Pack[] = [figma]

const isServer = (pack: Pack, server: string) => new RegExp(`^(?:${pack.server.source})$`, 'i').test(server)

// The pack that takes an MCP tool, by its server, the part of the name before the last `__`, so
// another server's `figma_export` is no Figma tool; none for a tool of no MCP server.
export const packOf = (tool: string) => {
  if (!tool.startsWith('mcp__') || tool.lastIndexOf('__') < 5) return undefined
  const server = tool.slice(5, tool.lastIndexOf('__'))
  return packs.find(p => isServer(p, server))
}

// The tools of every pack's servers, for a hook's matcher, so the hook never sees any other.
export const PACK_TOOL = new RegExp(`^mcp__(?:${packs.map(p => p.server.source).join('|')})__(?:(?!__).)+$`, 'i')

// The words for the tools of every pack, in a sentence: "Figma", "Figma and Chrome DevTools".
export const packsLabel = packs.length < 2 ? (packs[0]?.label ?? '') : `${packs.slice(0, -1).map(p => p.label).join(', ')} and ${packs.at(-1)!.label}`
