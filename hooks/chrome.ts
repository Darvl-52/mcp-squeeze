// The Chrome DevTools pack: what the mod does to the text the Chrome DevTools server's tools return
// (`chrome-devtools`, `chrome_devtools`, `chrome-devtools-mcp`). It keeps what the model acts on
// (every uid, role, name, value, URL) and drops only what spells it long.
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

export const chrome: Pack = {
  id: 'chrome',
  server: /.*chrome[-_]?dev[-_]?tools.*/,
  // What it emulates (`Emulating viewport: {…}`), said again after each call while it lasts.
  states: [/^(Emulating[^:\n]*: )(.+)$/],
  squeezeText: (tool, text) => unescapeSnapshot(text),
}
