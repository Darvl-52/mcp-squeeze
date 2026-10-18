// What became of one tool's results this conversation: the calls, their text before and after in
// characters, and the repeated images left out with the tokens they would have cost (absent in a
// stat an earlier version kept).
export type Stat = { calls: number; before: number; after: number; images?: number; imageTokens?: number }

// What became of each tool's results since the mod was first on, across sessions, kept in the
// store: `since` in milliseconds.
export type Total = { since: number; tools: Record<string, Stat> }

// One agent's blocks returned this conversation, by hash: `whole` its last copy went whole, so the
// next one is left out; `pointed` it was left out, so the next goes whole.
export type Seen = Record<string, 'whole' | 'pointed'>

declare module 'claude-code' {
  interface PluginState {
    'mcp-squeeze': {
      seen: Record<string, Seen>
      stats: Record<string, Stat>
    }
  }
}
