// What the mod does to the text an MCP tool returns, whichever pack squeezes it, and the notes it
// leaves where a repeat was left out. What each pack does to its own tools is in its file.
import { packOf, packs } from './packs.ts'

export { collapseInstances, hoistClasses, isCode, outline, OUTLINE_LEGEND, roundNoise } from './figma.ts'

// FNV-1a over a text: which blocks were returned before.
export const hash = (text: string) => {
  let h = 0x811c9dc5
  for (const ch of text) {
    h ^= ch.codePointAt(0)!
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

// One text block of an MCP tool's result, squeezed by its server's pack; a tool no pack takes as it
// came. Never longer than it was. Its line breaks read as `\n`, however it came (`\r\n` from a
// server on Windows); a block with nothing else to squeeze comes as it came, line breaks and all.
export const squeezeText = (tool: string, text: string) => {
  const lf = text.replaceAll('\r\n', '\n')
  const out = packOf(tool)?.squeezeText(tool, lf) ?? lf
  return out.length < lf.length ? out : text
}

// An opaque token written out long: a JWT, or a run of base64 (or base64url).
const TOKEN = /\beyJ[\w-]+\.[\w-]+\.[\w-]+|(?<![\w+/=-])[A-Za-z0-9+/_-]+={0,2}(?![\w+/=-])/g
// A token this long or longer is told by a note where it came whole before.
export const TOKEN_MIN = 160

// Long, with capitals, small letters and digits, as random bytes written out are, and no path:
// base64 has a slash in 64 characters, a path one every few.
const isOpaque = (t: string) => t.length >= TOKEN_MIN && /[A-Z]/.test(t) && /[a-z]/.test(t) && /\d/.test(t) && (t.match(/\//g)?.length ?? 0) * 16 < t.length

// The opaque tokens of a text, as they are written.
export const tokensOf = (text: string) => [...text.matchAll(TOKEN)].map(m => m[0]).filter(isOpaque)

export const tokenKey = (token: string) => `token:${hash(token)}`

export const tokenNote = (token: string) => `[the same ${token.length}-character token as earlier in this conversation, ${token.slice(0, 12)}…${token.slice(-6)}]`

// A text with each opaque token `isRepeat` says to leave out told by a note: the token stays in the
// context where it came whole before (a bearer token in every request of a page, a data URI).
export const shortenTokens = (text: string, isRepeat: (key: string) => boolean) =>
  text.replace(TOKEN, t => (isOpaque(t) && isRepeat(tokenKey(t)) ? tokenNote(t) : t))

// A block this long or longer is left out where it was returned whole before.
export const REPEAT_MIN = 300

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

// A PNG's width and height from its header (the first 24 bytes, 32 base64 characters); undefined
// for any other image.
export const pngSize = (base64: string) => {
  const bytes: number[] = []
  for (let i = 0; i + 4 <= 32 && i + 4 <= base64.length; i += 4) {
    const n = [...base64.slice(i, i + 4)].reduce((v, ch) => (v << 6) | Math.max(0, BASE64.indexOf(ch)), 0)
    bytes.push((n >> 16) & 255, (n >> 8) & 255, n & 255)
  }
  const isPng = bytes.length >= 24 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
  const u32 = (at: number) => ((bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!) >>> 0
  return isPng ? { width: u32(16), height: u32(20) } : undefined
}

// The tokens an image of this size costs the model, by Anthropic's rule of thumb: about one per 750
// pixels, after it is scaled to fit 1568 pixels a side and 1.15 megapixels.
export const imageTokens = (size: { width: number; height: number }) => {
  const { width: w, height: h } = size
  if (w <= 0 || h <= 0) return 0
  const scale = Math.min(1, 1568 / Math.max(w, h), Math.sqrt(1_150_000 / (w * h)))
  return Math.round((w * scale * (h * scale)) / 750)
}

export const imageNote = (mimeType: string, size: { width: number; height: number }) =>
  `[The same image (${mimeType}, ${size.width}×${size.height}) this tool returned earlier in this conversation: left out to save context. If it is no longer in view, call the tool again and the next copy comes whole.]\n`

// Quoting how the block starts, past a pack's legend, which every block of its kind starts with.
const pastLegend = (text: string) => packs.reduce((t, p) => (p.legend ? t.replace(`${p.legend}\n`, '') : t), text)

export const repeatNote = (text: string) =>
  `[The same ${text.length} characters this tool returned earlier in this conversation, starting "${pastLegend(text).slice(0, 60).replace(/\s+/g, ' ').trim()}…": left out to save context. If that copy is no longer in view, call the tool again and the next copy comes whole.]\n`
