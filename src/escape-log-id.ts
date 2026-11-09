// One caller-controlled string in, one log-safe string out. The line
// breaks, C0 and C1 controls, delete, and the bidi controls enumerated
// below become fixed visible ASCII forms; every other code point passes
// through unchanged. The backslash escapes first so the mapping is
// reversible: an escaped real line break never collides with a typed
// backslash-n.
export function escapeLogId(id: string): string {
  let out = ''
  for (const ch of id) {
    const cp = ch.codePointAt(0) ?? 0
    if (cp === 0x5c) {
      out += '\\\\'
    } else if (cp === 0x0a) {
      out += '\\n'
    } else if (cp === 0x0d) {
      out += '\\r'
    } else if (
      cp < 0x20 ||
      cp === 0x7f ||
      (cp >= 0x80 && cp <= 0x9f) ||
      cp === 0x200e ||
      cp === 0x200f ||
      cp === 0x2028 ||
      cp === 0x2029 ||
      (cp >= 0x202a && cp <= 0x202e) ||
      (cp >= 0x2066 && cp <= 0x2069)
    ) {
      out += `\\u${cp.toString(16).padStart(4, '0')}`
    } else {
      out += ch
    }
  }
  return out
}
