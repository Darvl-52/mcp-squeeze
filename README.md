# mcp-squeeze

A Claude Code mod that squeezes what the Figma MCP tools return before the model reads it. Each
result a Figma tool sends lands in the context and stays there for the rest of the conversation;
the mod keeps what the model acts on (node ids, names, positions, sizes, every class) and drops
what only repeats it or spells it long.

Over 1,600 Figma calls of past sessions it kept out about 23% of their text and 39 repeated
images: about 235k tokens. `get_metadata` comes out at half its size, a large
`get_design_context` at up to a third.

## What it does

It works by packs, one for each kind of MCP server it knows; for now there is one, `figma`, which
takes the Figma servers' tools, whatever a config names the server (`figma`, `claude_ai_Figma`,
`figma-dev-mode`, the Figma plugin's `plugin_figma_figma`). A tool no pack takes, an error, and a
result in a shape it does not know pass as they came. A result sent with Windows line breaks
(`\r\n`) is squeezed as any other. Each pack is a file in `hooks/` listed in `hooks/packs.ts`.

- **`get_metadata` as an outline.** One node a line, closing tags dropped since the indent says
  where a node ends, a name that is only the node's type (`Frame`, `Group`) left out:

  ```
  <frame id="30:58" name="S1 Hero" x="0" y="0" width="1440" height="900">
  ```

  becomes

  ```
  frame 30:58 "S1 Hero" 0,0 1440×900
  ```

- **`get_design_context`: an instance told in a line.** Where an instance's inside is its
  component's, already in the code (the function Figma wrote for it, or an earlier instance
  written out whole), the inside becomes one line: what it is the same as, how its node ids read,
  and the texts and images that differ.

  ```jsx
  {/* inside as <PlanCard> (1:2), node ids "I1:42;" + its own ids; differs at its own ids: 1:3 "Pro", 1:4 "$19 / month" */}
  ```

  An inside that differs in anything else, a class or a tag, stays whole.

- **`get_design_context`: a class used more than once, declared once.** `const cn1 = "…"` before
  the component, `className={cn1}` where it was; the code means the same, the value kept exactly.
- **Float noise rounded.** A float32 value written out whole, `1.1299999952316284`, becomes the
  shortest writing of the same float32, `1.13`; any other number is left as it is.
- **A repeat left out.** A block, or a PNG image, a tool returns again in the same conversation
  becomes a short note saying so; the copy after it comes whole again, so the model can always
  get it back. A compact, a `/clear` and each subagent start over. Where an organization manages
  Claude Code, a compact does not reach a mod a person installed: there the note after a compact
  may name a copy the summary took the place of, and calling the tool again brings it whole.

## Commands

| Command              | What it does                                                   |
| -------------------- | -------------------------------------------------------------- |
| `/squeeze-gain`      | The tokens saved: this conversation, all time, by tool.        |
| `/squeeze`           | Whether it is on, and what it kept out this conversation.      |
| `/squeeze off`       | Turn it off, kept for every session; `/squeeze on` back on.    |
| `/squeeze figma off` | Turn one pack off, the others on; `/squeeze figma on` back on. |

The tokens are an estimate: text at 3.5 characters a token, an image at a token per 750 pixels.
No API counts the tokens of a text without a model call that would cost about what it saves.

`node tools/measure.mjs` works out what the mod would have kept out of the Figma results in this
machine's past sessions, from the transcripts under `projects` in the Claude config folder
(`CLAUDE_CONFIG_DIR`, else `~/.claude`); it writes nothing.

## Install

Needs Claude Code 2.1.302 or later. At the prompt of a Claude Code session:

```
/plugin install mcp-squeeze --marketplace Darvl-52/mcp-squeeze
```

`y` adds the marketplace, then pick a scope. From a shell:

```sh
claude plugin install mcp-squeeze --marketplace Darvl-52/mcp-squeeze
```

Mods are early access, and Claude Code may not load an installed plugin's hooks module: with a
third-party provider (Bedrock, Vertex, a gateway) or with telemetry turned off, nothing changes
and `/squeeze` is an unknown command. Set `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` in the environment
Claude Code starts in, then start a new session. `claude --debug` says why a module was not
loaded: search its log for `hooks module`.

The mod keeps what it has left out this conversation in the session's own values, and the all-time
count and whether it is on in its store.
