# mcp-squeeze

A Claude Code mod that squeezes what the MCP tools return before the model reads it. Each result
an MCP tool sends lands in the context and stays there for the rest of the conversation; the mod
keeps what the model acts on and drops what only repeats it or spells it long: a repeat from any
server, and for the servers it has a pack for (Figma, Chrome DevTools), what their results spell
long.

Over 1,600 Figma calls of past sessions it kept out about 23% of their text and 39 repeated
images: about 235k tokens. `get_metadata` comes out at half its size, a large
`get_design_context` at up to a third.

## What it does

It works on every MCP server's tools; an error and a result in a shape it does not know pass as
they came, and a result sent with Windows line breaks (`\r\n`) is squeezed as any other.

For every MCP tool:

- **A repeat left out.** A block, or a PNG image, a tool returns again in the same conversation
  becomes a short note saying so; the copy after it comes whole again, so the model can always
  get it back. A compact, a `/clear` and each subagent start over. Where an organization manages
  Claude Code, a compact does not reach a mod a person installed: there the note after a compact
  may name a copy the summary took the place of, and calling the tool again brings it whole.
- **A long token told once.** A JWT, or a run of base64 (a data URI's, say) 160 characters or
  longer, that came whole earlier in the conversation becomes a note naming its length, how it
  starts and how it ends: a bearer token in every request of a page comes once. The token after a
  note comes whole again, and so does each token of a block called for again after one left out.

And a pack for each kind of MCP server it knows, a file in `hooks/` listed in `hooks/packs.ts`.

`figma` takes the Figma servers' tools, whatever a config names the server (`figma`,
`claude_ai_Figma`, `figma-dev-mode`, the Figma plugin's `plugin_figma_figma`):

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

`chrome` takes the Chrome DevTools server's tools (`chrome-devtools`, `chrome_devtools`,
`chrome-devtools-mcp`):

- **A state said once.** `Emulating viewport: {…}`, which the server says after each call while it
  emulates, becomes `Emulating viewport: (as before)` where its value is the one it said last; a
  new value comes whole, and so does the one before it said again. The line stays, so the model
  can tell the emulation lasting from one turned off, after which the server says nothing.
- **A snapshot's URLs in letters.** In the page's snapshot, a letter past ASCII percent-escaped in a
  `url="…"` is written as itself: `title=%D0%9F%D0%BB%D0%B0%D0%BD` becomes `title=План`, the same
  URL to a browser. An escaped ASCII character (`%20`, `%2F`, `%26`) stays, as do a character that
  does not show and every URL outside the snapshot (a request's, a script's result).
- **A snapshot told by its changes.** A node keeps its uid from one snapshot to the next, so a
  snapshot, `take_snapshot`'s or the one after a click, a fill, a wait, comes as what changed
  since the last one: a line new (`+`), gone (`-`, with how many lines were in it) or changed
  (`~`), each with the lines it is in, and `… 33 lines as before` for the rest; a page the same as
  the last says so in a line. A `take_snapshot` called next comes whole, as does a snapshot whose
  changes would come to more than 60% of it (another page). A compact, a `/clear` and each
  subagent start over.

  ```
  ## Latest page snapshot, told by its changes since the last one: + a line new, - gone, ~ changed, …
    uid=7_0 RootWebArea "Home" url="https://example.com/home"
      uid=7_1 banner
  ~     uid=7_2 button "Profile" expandable expanded haspopup="menu"
        … 3 lines as before
      … 33 lines as before
  +   uid=8_0 menu "Profile" orientation="vertical"
  +     uid=8_1 menuitem "Sign out"
  ```

## Commands

| Command              | What it does                                                   |
| -------------------- | -------------------------------------------------------------- |
| `/squeeze-gain`      | The tokens saved: this conversation, all time, by tool.        |
| `/squeeze`           | Whether it is on, and what it kept out this conversation.      |
| `/squeeze off`       | Turn it off, kept for every session; `/squeeze on` back on.    |
| `/squeeze figma off` | Turn one pack off, the others on; `/squeeze figma on` back on. |
| `/squeeze other off` | Leave the tools no pack takes as they come; `on` back on.      |

The tokens are an estimate: text at 3.5 characters a token, an image at a token per 750 pixels.
No API counts the tokens of a text without a model call that would cost about what it saves.

`node tools/measure.mjs` works out what the mod would have kept out of the MCP results in this
machine's past sessions, from the transcripts under `projects` in the Claude config folder
(`CLAUDE_CONFIG_DIR`, else `~/.claude`); it writes nothing. It goes by server and tool, and for a
server no pack takes it says what leaving out its repeats would keep out, to weigh a pack for it.
A result the mod had squeezed already when it came is left out of the count.

```sh
node tools/measure.mjs                          # every MCP server
node tools/measure.mjs --server chrome          # the servers whose name holds "chrome"
node tools/measure.mjs --sample take_snapshot 3 # the first 3 results of a tool, as they came and squeezed
```

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
