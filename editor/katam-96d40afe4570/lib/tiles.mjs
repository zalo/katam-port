// Tilemap entries as text tokens.
//
// A GBA text-BG entry is a u16: tile index (bits 0-9), h-flip (10), v-flip (11),
// palette bank (12-15).  Its authoring token is five characters, `TTTfP`:
//
//   TTT  tile index, 3 lowercase hex digits (000-3ff)
//   f    flip: "." none, "h" horizontal, "v" vertical, "x" both
//   P    palette bank, 1 hex digit (0-f)
//
// e.g. "012.0" = tile 0x12, no flip, bank 0; "3a1h2" = tile 0x3a1, h-flipped, bank 2.
// Fixed width keeps columns aligned in a diff.  A 16x16 metatile is four tokens
// "TL TR BL BR" separated by spaces.
export const TOKEN_RE = /^[0-9a-f]{3}[.hvx][0-9a-f]$/;
const FLIP = ['.', 'h', 'v', 'x'];

export function tokenOf(v) {
  return (v & 0x3ff).toString(16).padStart(3, '0') + FLIP[(v >> 10) & 3] + (v >> 12).toString(16);
}

export function valueOf(tok) {
  if (!TOKEN_RE.test(tok)) throw new Error(`bad tile token "${tok}" (want TTTfP, e.g. "012.0")`);
  return parseInt(tok.slice(0, 3), 16) | (FLIP.indexOf(tok[3]) << 10) | (parseInt(tok[4], 16) << 12);
}

export function metatileOf(tm, widthTiles, cx, cy) {
  const i = cy * 2 * widthTiles + cx * 2;
  const g = (k) => tm[k * 2] | (tm[k * 2 + 1] << 8);
  return [g(i), g(i + 1), g(i + widthTiles), g(i + widthTiles + 1)];
}

export const metaToken = (four) => four.map(tokenOf).join(' ');

export function metaValues(s) {
  const parts = String(s).trim().split(/\s+/);
  if (parts.length !== 4) throw new Error(`metatile "${s}" must be 4 tile tokens "TL TR BL BR"`);
  return parts.map(valueOf);
}
