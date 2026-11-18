// katam render: draw a room so a person or a model can see what it made.
//
// Layers, back to front: background (tiled, bottom-aligned, no parallax),
// playfield art, then optional overlays: collision (tinted by terrain bits),
// objects (boxes + "o<i>" labels), doors (outlined cells + "d<i>" labels,
// arrival markers), nav (node regions), grid (16-px cells, labels every 5).
// When the tileset/palette/background are not loaded (no --base), the art is
// replaced by a schematic of the collision so the render still says something.
import { Bindings, makeContext } from './project.mjs';
import { compileRoom } from './room.mjs';
import { compileTileset, compileBackground, bgr555 } from './gfx.mjs';
import { decodeGrid } from './grid.mjs';

const FONT = {
  // 3x5 glyphs, rows top to bottom, 3 bits each (MSB = left)
  0: [7, 5, 5, 5, 7], 1: [2, 6, 2, 2, 7], 2: [7, 1, 7, 4, 7], 3: [7, 1, 3, 1, 7], 4: [5, 5, 7, 1, 1], 5: [7, 4, 7, 1, 7], 6: [7, 4, 7, 5, 7], 7: [7, 1, 2, 2, 2], 8: [7, 5, 7, 5, 7], 9: [7, 5, 7, 1, 7],
  o: [0, 7, 5, 5, 7], d: [1, 1, 7, 5, 7], n: [0, 6, 5, 5, 5], a: [0, 7, 1, 7, 7], '>': [4, 2, 1, 2, 4],
};

class Canvas {
  constructor(w, h) { this.w = w; this.h = h; this.rgba = new Uint8Array(w * h * 4); }
  px(x, y, [r, g, b], a = 255) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const o = (y * this.w + x) * 4;
    const k = a / 255;
    this.rgba[o] = this.rgba[o] * (1 - k) + r * k; this.rgba[o + 1] = this.rgba[o + 1] * (1 - k) + g * k; this.rgba[o + 2] = this.rgba[o + 2] * (1 - k) + b * k; this.rgba[o + 3] = 255;
  }
  rect(x, y, w, h, c, a) { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.px(x + i, y + j, c, a); }
  box(x, y, w, h, c, a = 255) { for (let i = 0; i < w; i++) { this.px(x + i, y, c, a); this.px(x + i, y + h - 1, c, a); } for (let j = 0; j < h; j++) { this.px(x, y + j, c, a); this.px(x + w - 1, y + j, c, a); } }
  text(x, y, s, c, bg = [0, 0, 0]) {
    this.rect(x - 1, y - 1, s.length * 4 + 1, 7, bg, 200);
    [...s].forEach((ch, i) => (FONT[ch] || FONT[0]).forEach((row, r) => { for (let b = 0; b < 3; b++) if (row & (4 >> b)) this.px(x + i * 4 + b, y + r, c); }));
  }
}

const rgb = (c) => [c & 31, (c >> 5) & 31, (c >> 10) & 31].map((v) => (v << 3) | (v >> 2));

function terrainColor(bits) {
  if (!bits || bits === 'empty' || bits === 'unused') return null;
  if (bits.includes('hazard')) return [255, 40, 40];
  if (bits.includes('door')) return [40, 255, 80];
  if (bits.includes('water')) return [40, 160, 255];
  if (bits.includes('ladder')) return [255, 230, 40];
  if (bits.includes('breakable')) return [200, 120, 40];
  if (bits.includes('top_solid')) return [80, 120, 255];
  if (bits.includes('force')) return [200, 80, 255];
  if (bits.includes('slope')) return [255, 150, 40];
  if (bits.includes('solid')) return [140, 140, 140];
  return [255, 0, 255];
}

function drawTiles(cv, tm, wTiles, hTiles, tiles, bankColor, ox = 0, oy = 0, transparent0 = true) {
  for (let ty = 0; ty < hTiles; ty++) for (let tx = 0; tx < wTiles; tx++) {
    const v = tm[(ty * wTiles + tx) * 2] | (tm[(ty * wTiles + tx) * 2 + 1] << 8);
    const t = v & 0x3ff, hf = v & 0x400, vf = v & 0x800, bank = v >> 12;
    if (t * 32 + 32 > tiles.length) continue;
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      const sx = hf ? 7 - x : x, sy = vf ? 7 - y : y;
      const b = tiles[t * 32 + sy * 4 + (sx >> 1)];
      const ci = sx & 1 ? b >> 4 : b & 0xf;
      if (ci === 0 && transparent0) continue;
      const col = bankColor(bank, ci);
      if (col) cv.px(ox + tx * 8 + x, oy + ty * 8 + y, col);
    }
  }
}

export function renderRoom({ io, layers, vocab, registry, roomId, overlay = [], scale = 1 }) {
  const bindings = new Bindings(vocab, layers);
  const ctx = makeContext({ vocab, registry, bindings, external: true });
  const rid = bindings.resolve(roomId);
  if (!rid) throw new Error(`room "${roomId}" not found in the loaded projects`);
  const doc = bindings.docs.get(rid).doc;
  const c = compileRoom(doc, ctx);
  const W = doc.size.width, H = doc.size.height;
  const cv = new Canvas(W * 16, H * 16);
  const notes = [];
  const get = (id) => { const r = bindings.resolve(id); return r ? bindings.docs.get(r) : null; };
  const ts = get(doc.tileset), pal = get(doc.palette), bg = get(doc.background);
  const cells = decodeGrid(doc.collision, W, H).map((v) => ctx.collisionValue(v));
  const bitsOf = (v) => (vocab.collision[v] || {}).bits;

  cv.rect(0, 0, cv.w, cv.h, [24, 24, 40]);
  if (bg) {
    try {
      const b = compileBackground(bg.doc, (n) => io.readBytes(`${bg.base}/${n}`)).blobs;
      const off = bg.doc.palette.offset;
      const cols = bg.doc.palette.colors.map((h) => rgb(bgr555(h)));
      const bw = bg.doc.size.width * 8, bh = bg.doc.size.height * 8;
      const oy = cv.h - bh;
      for (let y0 = oy; y0 > -bh; y0 -= bh) for (let x0 = 0; x0 < cv.w; x0 += bw) {
        drawTiles(cv, b.tilemap, bg.doc.size.width, bg.doc.size.height, b.tiles, (bank, ci) => cols[bank * 16 + ci - off], x0, y0, false);
      }
    } catch (e) { notes.push(`background not drawn: ${e.message}`); }
  } else notes.push(`background ${doc.background} not loaded`);
  if (ts && pal) {
    const t = compileTileset(ts.doc, (n) => io.readBytes(`${ts.base}/${n}`)).blobs;
    const banks = pal.doc.banks.map((bank) => bank.map((h) => rgb(bgr555(h))));
    drawTiles(cv, c.blobs.fgTilemap, W * 2, H * 2, t.tiles, (bank, ci) => (banks[bank] ? banks[bank][ci] : [255, 0, 255]));
  } else {
    notes.push('tileset/palette not loaded (pass --base): drawing a collision schematic instead of art');
    cells.forEach((v, i) => { const col = terrainColor(bitsOf(v)); if (col) cv.rect((i % W) * 16, ((i / W) | 0) * 16, 16, 16, col, 255); });
  }

  if (overlay.includes('collision')) {
    cells.forEach((v, i) => {
      const col = terrainColor(bitsOf(v));
      if (!col) return;
      const x = (i % W) * 16, y = ((i / W) | 0) * 16;
      cv.rect(x, y, 16, 16, col, 90);
      cv.box(x, y, 16, 16, col, 200);
    });
  }
  if (overlay.includes('grid')) {
    for (let x = 0; x < W; x++) for (let y = 0; y < cv.h; y += 2) cv.px(x * 16, y, [255, 255, 255], x % 5 ? 40 : 110);
    for (let y = 0; y < H; y++) for (let x = 0; x < cv.w; x += 2) cv.px(x, y * 16, [255, 255, 255], y % 5 ? 40 : 110);
    for (let x = 0; x < W; x += 5) cv.text(x * 16 + 1, 1, String(x), [255, 255, 255]);
    for (let y = 5; y < H; y += 5) cv.text(1, y * 16 + 1, String(y), [255, 255, 255]);
  }
  if (overlay.includes('nav') && doc.nav) {
    const nm = decodeGrid(doc.nav, W, H);
    nm.forEach((n, i) => { const x = (i % W) * 16, y = ((i / W) | 0) * 16; const hue = [(n * 97) % 256, (n * 57 + 80) % 256, (n * 151 + 40) % 256]; cv.rect(x, y, 16, 16, hue, 60); });
    doc.nav.nodes.forEach((nd, i) => { cv.rect(nd.x - 2, nd.y - 2, 5, 5, [255, 255, 255]); cv.text(nd.x + 4, nd.y - 2, 'n' + i, [255, 255, 255]); });
  }
  if (overlay.includes('doors')) {
    (doc.doors || []).forEach((d, i) => {
      for (const [x, y] of d.cells) { cv.box(x * 16, y * 16, 16, 16, [40, 255, 80]); cv.box(x * 16 + 1, y * 16 + 1, 14, 14, [40, 255, 80]); }
      const [x, y] = d.cells[0];
      cv.text(x * 16 + 1, y * 16 - 7, 'd' + i, [40, 255, 80]);
    });
    // arrivals into this room from any loaded room
    for (const [, o] of bindings.docs) {
      if (o.doc.format !== 'katam-room/1') continue;
      for (const d of o.doc.doors || []) if (bindings.resolve(d.to) === rid) { const x = d.arrive.x * 16, y = d.arrive.y * 16; cv.rect(x + 4, y - 3, 8, 3, [255, 255, 255]); cv.text(x + 4, y - 10, 'a', [255, 255, 255]); }
    }
  }
  if (overlay.includes('objects')) {
    (doc.objects || []).forEach((o, i) => {
      const t = typeof o.type === 'number' ? o.type : vocab.objectTypes[o.type];
      const col = t < 0x5e ? [255, 80, 80] : t < 0x6d ? [80, 255, 255] : t < 0x9b ? [255, 220, 60] : [200, 200, 255];
      cv.box(o.x - 6, o.y - 6, 13, 13, col);
      cv.px(o.x, o.y, col);
      cv.text(o.x - 6, o.y + 8, 'o' + i, col);
    });
    notes.push('objects: red = enemy/boss (types < 0x5e), cyan = food/item, yellow = gadget/door/chest, lavender = projectile/other');
  }
  if (scale > 1) {
    const s = new Canvas(cv.w * scale, cv.h * scale);
    for (let y = 0; y < s.h; y++) for (let x = 0; x < s.w; x++) { const o = ((y / scale | 0) * cv.w + (x / scale | 0)) * 4, p = (y * s.w + x) * 4; s.rgba.set(cv.rgba.subarray(o, o + 4), p); }
    return { w: s.w, h: s.h, rgba: s.rgba, notes };
  }
  return { w: cv.w, h: cv.h, rgba: cv.rgba, notes };
}
