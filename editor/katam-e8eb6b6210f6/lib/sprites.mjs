// One representative picture per object type, decoded at run time from the
// player's ROM (Sonic-Advance-style sprite engine: game/src/sprite.c).
// Browser-safe: no Node APIs, no ROM bytes in this file.  Everything below
// that looks like data is either a ROM *address* (the dump is pinned by sha1,
// see rom.mjs VANILLA_SHA1) or a constant read off the C source.
//
//   objectSprite(romBytes, typeNumber[, romTables]) -> {w,h,rgba,ox,oy} | null
//   kirbySprite(romBytes[, romTables])              -> {w,h,rgba,ox,oy} | null
//   animSprite(romBytes, spec[, romTables])         -> same, for any animation
//
// How a type becomes a picture (ObjectInitSprite, game/src/object.c):
//   gUnk_08351648[type] = { ..., u16 palAnim @8, u32 numTiles @0xC,
//                           AnimInfo *anims @0x14 }      (0x18 bytes each)
//   sprite.animId/variant = anims[state]                 ({u16 animId; u8 variant; s8})
//   OBJ palette           = the GetPalette command of animation (palAnim & 0xFFF)
//                           (sub_0803DFAC); palAnim 0 = shared slot 15, which
//                           sub_0803E050 fills from animation 0x28A.
// and how an animation becomes pixels (sub_08155128 / sub_081564D8):
//   gSpriteTables->anims[animId][variant] is a command list; negative words
//   are commands (GetTiles -1, GetPalette -2, ...), the first non-negative
//   word pair is ShowFrame{delay, frame}.  attrs[animId][frame] gives the OAM
//   piece range, picture size and origin; oamData[animId] the pieces.
import { u8, u16, s16, u32, s32 } from './bytes.mjs';

const ROM_BASE = 0x08000000;
const SPRITE_TABLES = 0x083B909C; // gUnk_083B909C (struct SpriteTables)
const OBJ_INFO = 0x08351648;      // gUnk_08351648 (struct Unk_08351648[0xDB])
const OBJ_INFO_SIZE = 0x18;
export const OBJECT_TYPE_COUNT = 0xDB;
const SHARED_PAL_ANIM = 0x28A;    // OBJ palette slot 15 (sub_0803E050)
const KIRBY_PAL_ANIM = 0x15;      // sub_0803E558: variant = Kirby colour, 0 = pink

// [shape<<2 | size] -> [w, h]   (gUnk_08D6084C, the hardware OBJ sizes)
const OAM_SIZE = [[8, 8], [16, 16], [32, 32], [64, 64], [16, 8], [32, 8], [32, 16], [64, 32], [8, 16], [8, 32], [16, 32], [32, 64], [8, 8], [8, 8], [8, 8], [8, 8]];
// words per animation command, indexed by ~cmdId (struct AnimCmd_* sizes)
const CMD_WORDS = [3, 3, 2, 1, 2, 3, 2, 3, 2, 4, 2, 2];

// Per-type picture overrides.  Each entry is one layer or a list of layers,
// drawn back to front around the same origin:
//   { a: animId, v: variant, p: paletteAnimId, pv: paletteVariant, s: state
//     index into the type's own AnimInfo table, x/y: layer offset, fx/fy: flip }
// Missing a/v = the type's own table at state `s` (default 0); missing p =
// the type's own palAnim.  `null` = deliberately no picture.
// Sources are the constructors named in assets/schema/semantics/object_params.json.
const OVERRIDES = {
  // OBJ_EMPTY_* / unknown slots whose table rows are leftovers
  0x2C: null, 0x31: null, 0x40: null, 0x41: null, 0x42: null, 0x43: null, 0x44: null,
  0x66: null, 0x67: null, 0x68: null, 0x6A: null, 0x6B: null, 0x6C: null, 0xA0: null, 0xD4: null,
  0x10: { s: 2 },                       // Jack: state 0 is only the antenna ball
  // Kracko has numTiles 0 and is built from effect sprites (kracko.c
  // sub_080DCF18 & co.): the cloud half drawn twice (palette 0x33B, then
  // vflipped with 0x33A), spikes in 0x33B, the eye in 0x339.
  0x45: [{ a: 0x339, v: 9, p: 0x33B }, { a: 0x339, v: 9, p: 0x33A, fy: true }, { a: 0x339, v: 0xC, p: 0x33B }, { a: 0x339, v: 0, p: 0x339 }],
  // Dark Mind's second form is an 8bpp affine background (anim 0x39B); show
  // the eye its OBJ parts use (dark_mind.c gUnk_08357304).
  0x50: { a: 0x399, v: 0x30, p: 0x399 },
  0xA3: { s: 4 }, 0xA5: { s: 4 },       // ability / inhalable star: the star itself
  0xA7: { s: 1 }, 0xA9: { s: 1 },       // large ice cube / large nut (state = unk0)
  0xCC: { s: 1 }, 0xCD: { s: 2 }, 0xCE: { s: 3 }, // Dark Mind stars: ice, spark, mix
};

const ctxCache = new WeakMap();
function context(rom, tables) {
  let c = ctxCache.get(rom);
  if (c) return c;
  const st = (tables && tables.gUnk_083B909C) || SPRITE_TABLES;
  const o = st - ROM_BASE;
  c = {
    b: rom,
    anims: u32(rom, o) - ROM_BASE,
    attrs: u32(rom, o + 4) - ROM_BASE,
    oam: u32(rom, o + 8) - ROM_BASE,
    pal: u32(rom, o + 12) - ROM_BASE,
    t4: u32(rom, o + 16) - ROM_BASE,
    t8: u32(rom, o + 20) - ROM_BASE,
    info: ((tables && tables.gUnk_08351648) || OBJ_INFO) - ROM_BASE,
    numAnims: 0,
    pals: new Map(),
    out: new Map(),
    kirby: undefined,
  };
  // The anims table is immediately followed by the data its entries point to.
  c.numAnims = Math.min(0x1000, (c.attrs - c.anims) >>> 2);
  ctxCache.set(rom, c);
  return c;
}

const inRom = (c, o, n = 4) => o >= 0 && o + n <= c.b.length;

/** Walk animation (animId, variant) up to its first ShowFrame. */
function firstFrame(c, animId, variant) {
  const b = c.b;
  if (animId >= c.numAnims) return null;
  const vt = u32(b, c.anims + 4 * animId) - ROM_BASE;
  if (!inRom(c, vt + 4 * variant)) return null;
  let p = u32(b, vt + 4 * variant) - ROM_BASE;
  if (!inRom(c, p)) return null;
  const r = { animId, frame: -1, tiles: null, pal: [], };
  for (let guard = 0; guard < 64; guard++) {
    if (!inRom(c, p, 16)) return null;
    const cmd = s32(b, p);
    if (cmd >= 0) { r.frame = s32(b, p + 4); return r; }
    const k = ~cmd;
    if (k >= CMD_WORDS.length) return null;
    if (k === 0) r.tiles = { index: s32(b, p + 4), count: u32(b, p + 8) };
    else if (k === 1) r.pal.push({ id: s32(b, p + 4), n: u16(b, p + 8), at: u16(b, p + 10) });
    else if (k === 2 || k === 3) return r.frame >= 0 ? r : null; // loop/end before any frame
    else if (k === 8) { // SetIdAndVariant: continue in the other animation
      const n = firstFrame(c, u16(b, p + 4), u16(b, p + 6));
      if (n && !n.pal.length) n.pal = r.pal;
      return n;
    }
    p += 4 * CMD_WORDS[k];
  }
  return null;
}

/** 16 OBJ colours (Uint32 RGBA little-endian words, entry 0 transparent). */
function palette(c, animId, variant) {
  const key = animId * 256 + variant;
  let pal = c.pals.get(key);
  if (pal !== undefined) return pal;
  pal = null;
  const f = firstFrameLoose(c, animId, variant);
  if (f && f.pal.length) {
    pal = new Uint32Array(16);
    for (const g of f.pal) {
      for (let i = 0; i < g.n && g.at + i < 16; i++) {
        const o = c.pal + 2 * (16 * g.id + i);
        if (!inRom(c, o, 2)) break;
        const v = u16(c.b, o);
        const R = v & 31, G = (v >> 5) & 31, B = (v >> 10) & 31;
        pal[g.at + i] = (0xff000000 | (((B << 3) | (B >> 2)) << 16) | (((G << 3) | (G >> 2)) << 8) | ((R << 3) | (R >> 2))) >>> 0;
      }
    }
    pal[0] = 0;
  }
  c.pals.set(key, pal);
  return pal;
}
// A palette-only animation may end without ever showing a frame.
function firstFrameLoose(c, animId, variant) {
  const b = c.b;
  if (animId >= c.numAnims) return null;
  const vt = u32(b, c.anims + 4 * animId) - ROM_BASE;
  if (!inRom(c, vt + 4 * variant)) return null;
  let p = u32(b, vt + 4 * variant) - ROM_BASE;
  const r = { pal: [] };
  for (let guard = 0; guard < 64 && inRom(c, p, 16); guard++) {
    const cmd = s32(b, p);
    if (cmd >= 0) break;
    const k = ~cmd;
    if (k >= CMD_WORDS.length || k === 2 || k === 3 || k === 8) break;
    if (k === 1) r.pal.push({ id: s32(b, p + 4), n: u16(b, p + 8), at: u16(b, p + 10) });
    p += 4 * CMD_WORDS[k];
  }
  return r;
}

/** One animation's first frame as positioned pieces. */
function layer(c, spec) {
  const f = firstFrame(c, spec.a, spec.v || 0);
  if (!f || f.frame < 0 || !f.tiles || f.tiles.index < 0) return null; // 8bpp/none: not handled
  const b = c.b;
  if ((f.frame >>> 28) !== 0) return null; // "full" attrs with streamed tiles: not used by objects
  const at = u32(b, c.attrs + 4 * f.animId) - ROM_BASE + 12 * f.frame;
  if (!inRom(c, at, 12)) return null;
  const bits = u16(b, at), n = u16(b, at + 2);
  const W = u16(b, at + 4), H = u16(b, at + 6);
  const offX = s16(b, at + 8), offY = s16(b, at + 10);
  if (n === 0 || n > 128) return null;
  const hf = (((bits >> 14) & 1) ^ (spec.fx ? 1 : 0)) === 1, vf = (((bits >> 15) & 1) ^ (spec.fy ? 1 : 0)) === 1;
  const oam = u32(b, c.oam + 4 * f.animId) - ROM_BASE + 6 * (bits & 0x3fff);
  if (!inRom(c, oam, 6 * n)) return null;
  let pal = palette(c, spec.p ? spec.p & 0xfff : SHARED_PAL_ANIM, spec.pv || 0);
  if (!pal && f.pal.length) pal = palette(c, f.animId, spec.v || 0);
  if (!pal) pal = palette(c, spec.a, spec.v || 0) || palette(c, SHARED_PAL_ANIM, 0);
  if (!pal) return null;
  const pieces = [];
  for (let i = 0; i < n; i++) {
    const a0 = u16(b, oam + 6 * i), a1 = u16(b, oam + 6 * i + 2), a2 = u16(b, oam + 6 * i + 4);
    if (a0 & 0x2000) return null; // 8bpp
    let x = a1 & 0x1ff, y = a0 & 0xff;
    if (x >= 0x100) x -= 0x200;
    if (y >= 0x80) y -= 0x100;
    const [w, h] = OAM_SIZE[((a0 & 0xc000) >> 12) | ((a1 & 0xc000) >> 14)];
    let ph = (a1 & 0x1000) !== 0, pv = (a1 & 0x2000) !== 0;
    if (vf) { pv = !pv; y = H - h - y; }
    if (hf) { ph = !ph; x = W - w - x; }
    pieces.push({ x: x - (hf ? W - offX : offX) + (spec.x || 0), y: y - (vf ? H - offY : offY) + (spec.y || 0), w, h, hf: ph, vf: pv, tile: a2 & 0x3ff });
  }
  return { pieces, pal, src: c.t4 + 0x20 * f.tiles.index, count: f.tiles.count };
}

function compose(c, specs) {
  const layers = [];
  for (const s of specs) { const l = layer(c, s); if (l) layers.push(l); }
  if (!layers.length) return null;
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  for (const l of layers) for (const p of l.pieces) {
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.x + p.w > x1) x1 = p.x + p.w;
    if (p.y + p.h > y1) y1 = p.y + p.h;
  }
  const w = x1 - x0, h = y1 - y0;
  if (w <= 0 || h <= 0 || w > 512 || h > 512) return null;
  const px = new Uint32Array(w * h);
  const b = c.b;
  // GBA OBJ order: the first piece of a frame is on top.
  for (const l of layers) for (let i = l.pieces.length - 1; i >= 0; i--) {
    const p = l.pieces[i], tw = p.w >> 3, th = p.h >> 3;
    for (let ty = 0; ty < th; ty++) for (let tx = 0; tx < tw; tx++) {
      const t = p.tile + ty * tw + tx;
      if (t >= l.count) continue;
      const src = l.src + 0x20 * t;
      if (src + 0x20 > b.length) continue;
      const dx0 = p.x - x0 + (p.hf ? p.w - 8 - 8 * tx : 8 * tx), dy0 = p.y - y0 + (p.vf ? p.h - 8 - 8 * ty : 8 * ty);
      for (let yy = 0; yy < 8; yy++) {
        const row = (dy0 + (p.vf ? 7 - yy : yy)) * w + dx0;
        for (let xx = 0; xx < 8; xx++) {
          const v = (b[src + yy * 4 + (xx >> 1)] >> ((xx & 1) << 2)) & 15;
          if (v) px[row + (p.hf ? 7 - xx : xx)] = l.pal[v];
        }
      }
    }
  }
  // crop to the opaque box
  let cx0 = w, cy0 = h, cx1 = -1, cy1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (px[y * w + x]) {
    if (x < cx0) cx0 = x;
    if (x > cx1) cx1 = x;
    if (y < cy0) cy0 = y;
    if (y > cy1) cy1 = y;
  }
  if (cx1 < 0) return null;
  const cw = cx1 - cx0 + 1, ch = cy1 - cy0 + 1;
  const rgba = new Uint8ClampedArray(cw * ch * 4);
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    const v = px[(y + cy0) * w + x + cx0], o = (y * cw + x) * 4;
    rgba[o] = v & 255; rgba[o + 1] = (v >> 8) & 255; rgba[o + 2] = (v >> 16) & 255; rgba[o + 3] = v >>> 24;
  }
  return { w: cw, h: ch, rgba, ox: -x0 - cx0, oy: -y0 - cy0 };
}

/** What the engine's own table says about a type (no pictures decoded). */
export function objectAnimInfo(romBytes, type, romTables) {
  const c = context(romBytes, romTables);
  if (!(type >= 0 && type < OBJECT_TYPE_COUNT)) return null;
  const e = c.info + OBJ_INFO_SIZE * type;
  const tab = u32(c.b, e + 0x14) - ROM_BASE;
  const numTiles = u32(c.b, e + 0xC);
  return {
    palAnim: u16(c.b, e + 8), numTiles, table: inRom(c, tab) ? tab : -1,
    state(i) { return inRom(c, tab + 4 * i) ? { a: u16(c.b, tab + 4 * i), v: u8(c.b, tab + 4 * i + 2) } : null; },
  };
}

/** Any animation: spec = {a, v, p, pv, x, y, fx} or a list of them (back to front). */
export function animSprite(romBytes, spec, romTables) {
  return compose(context(romBytes, romTables), Array.isArray(spec) ? spec : [spec]);
}

export function objectSprite(romBytes, typeNumber, romTables) {
  const c = context(romBytes, romTables);
  const type = typeNumber | 0;
  if (!(type >= 0 && type < OBJECT_TYPE_COUNT) || type !== typeNumber) return null;
  if (c.out.has(type)) return c.out.get(type);
  let out = null;
  try {
    const info = objectAnimInfo(romBytes, type, romTables);
    let ov = OVERRIDES[type];
    if (ov !== null) {
      if (ov === undefined) ov = info.numTiles && info.table >= 0 ? [{}] : null;
      else if (!Array.isArray(ov)) ov = [ov];
      if (ov) {
        const specs = [];
        for (const s of ov) {
          const q = { ...s };
          if (q.a === undefined) {
            const st = info.table >= 0 ? info.state(q.s || 0) : null;
            if (!st) continue;
            q.a = st.a;
            if (q.v === undefined) q.v = st.v;
          }
          if (q.p === undefined) q.p = info.palAnim;
          specs.push(q);
        }
        out = compose(c, specs);
      }
    }
  } catch (e) {
    out = null; // a modded/foreign ROM: no picture rather than a crash
  }
  c.out.set(type, out);
  return out;
}

/** Kirby standing, pink, no ability (animation 0, palette animation 0x17). */
export function kirbySprite(romBytes, romTables) {
  const c = context(romBytes, romTables);
  if (c.kirby === undefined) {
    try { c.kirby = compose(c, [{ a: 0, v: 0, p: KIRBY_PAL_ANIM }]); } catch (e) { c.kirby = null; }
  }
  return c.kirby;
}
