// katam validate: schema + structure + cross-reference + GBA-limit checks.
//
// Every finding is {severity, code, file, where, message, hint}: `where` is a
// JSON-pointer-like path into the file ("/doors/0/to"), `hint` says how to fix
// it.  Codes are stable strings for tools (and models) to key on.
import { SchemaSet } from './schema.mjs';
import { loadProject, Bindings, makeContext, parseId, pathOf } from './project.mjs';
import { compileRoom } from './room.mjs';
import { decodeGrid } from './grid.mjs';
import { metaValues } from './tiles.mjs';
import { COLLISION_CAP } from './native.mjs';
import { SCHEMA_PREFIX } from './schemas.mjs';

const FORMATS = { 'katam-room/1': 'room', 'katam-project/1': 'project', 'katam-tileset/1': 'tileset', 'katam-background/1': 'background', 'katam-palette/1': 'palette', 'katam-object/1': 'object' };
const ptr = (w) => (!w ? '' : w.startsWith('/') ? w : '/' + w.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean).join('/'));

export function loadSchemas(io, dir) {
  const set = new SchemaSet();
  for (const p of io.list(dir).filter((p) => p.endsWith('.schema.json'))) set.add(JSON.parse(io.readText(p)));
  return set;
}

export function validatePath({ io, target, bases = [], vocab, registry, schemaDir }) {
  const schemas = loadSchemas(io, schemaDir);
  let root = target, only = null;
  if (!io.isDir(target)) {
    only = target;
    root = target;
    while (root.includes('/') && !io.exists(root + '/project.json')) root = root.slice(0, root.lastIndexOf('/'));
    if (!io.exists(root + '/project.json')) root = target.slice(0, target.lastIndexOf('/'));
  }
  const layers = bases.map((b) => loadProject(io, b));
  const main = loadProject(io, root);
  layers.push(main);
  const res = { target, files: 0, errors: [], warnings: [], checked: [] };
  const add = (sev, code, file, where, message, hint) => (sev === 'error' ? res.errors : res.warnings).push({ severity: sev, code, file, where: ptr(where), message, ...(hint ? { hint } : {}) });
  for (const e of main.errors) add('error', 'json', e.file, '', e.message, 'fix the JSON syntax');

  const mine = [...main.docs].filter(([, d]) => !only || d.abs === only);
  if (main.project) {
    const errs = schemas.validate(SCHEMA_PREFIX + 'project', main.project);
    for (const e of errs) add('error', 'schema', 'project.json', e.path, e.message, e.hint);
    if (main.project.base && !bases.length) add('warning', 'base-missing', 'project.json', '/base', `project builds on "${main.project.base}" but no --base folder was given: references into it are not checked`, 'pass --base <decompiled vanilla project> (katam decompile writes one)');
  } else if (!only) add('warning', 'no-project', '.', '', 'no project.json in this folder', 'katam new-room writes a minimal project.json next to a new room');

  let bindings, ctx;
  try { bindings = new Bindings(vocab, layers); ctx = makeContext({ vocab, registry, bindings, external: !bases.length }); } catch (e) { add('error', 'bind', '.', '', e.message); return res; }
  const baseLoaded = bases.length > 0;
  const externalOk = (id) => !baseLoaded && /^(room:[a-z0-9_]+\/\d+|(tileset|palette|background):vanilla\/\d+)$/.test(id || ''); // vanilla ids carry their number
  const roomDims = (id) => { const r = bindings.resolve(id); const d = r && bindings.docs.get(r).doc; return d && d.size; };
  const roomDoc = (id) => { const r = bindings.resolve(id); return r && bindings.docs.get(r).doc; };

  for (const [id, d] of mine) {
    res.files++;
    res.checked.push(d.rel);
    const doc = d.doc;
    const kind = FORMATS[doc.format];
    if (!kind) { add('error', 'format', d.rel, '/format', `unknown format "${doc.format}"`, `one of: ${Object.keys(FORMATS).join(', ')}`); continue; }
    const want = pathOf(doc.id || id);
    if (doc.id !== id) add('error', 'id-path', d.rel, '/id', `id "${doc.id}" does not match the file's path (expects "${id}")`, `rename the file to ${want} or set "id": "${id}"`);
    const serr = schemas.validate(SCHEMA_PREFIX + kind, doc);
    for (const e of serr.slice(0, 40)) add('error', 'schema', d.rel, e.path, e.message, e.hint || (e.schema && e.schema.description));
    if (kind === 'room') {
      // keep going after schema errors, so one run reports as much as it can;
      // drop later findings at a path the schema already reported
      const seen = new Set(serr.map((e) => e.path));
      const n0 = res.errors.length, w0 = res.warnings.length;
      try { checkRoom(d, doc); } catch (e) { if (!serr.length) add('error', 'internal', d.rel, '', e.message); }
      const keep = (f, i, start) => i < start || !seen.has(f.where);
      res.errors = res.errors.filter((f, i) => keep(f, i, n0));
      res.warnings = res.warnings.filter((f, i) => keep(f, i, w0));
    }
  }

  function checkRoom(d, doc) {
    const W = doc.size.width, H = doc.size.height;
    if (W * H > COLLISION_CAP) add('error', 'limit-cells', d.rel, '/size', `${W}x${H} = ${W * H} cells; the game's per-room collision buffer holds ${COLLISION_CAP}`, `shrink the room (e.g. ${Math.floor(COLLISION_CAP / H)}x${H})`);
    // references (resolved, or vanilla when no base is loaded)
    for (const [k, kind] of [['tileset', 'tileset'], ['palette', 'palette'], ['background', 'background']]) {
      if (!bindings.resolve(doc[k])) {
        if (externalOk(doc[k])) add('warning', 'ref-unchecked', d.rel, `/${k}`, `${doc[k]} is not checked (no --base)`, 'pass --base <vanilla project>');
        else add('error', 'ref', d.rel, `/${k}`, `${kind} "${doc[k]}" does not exist`, `define ${pathOf(doc[k])} or reference an existing ${kind}`);
      }
    }
    (doc.doors || []).forEach((dr, i) => {
      if (!bindings.resolve(dr.to)) {
        if (externalOk(dr.to)) add('warning', 'ref-unchecked', d.rel, `/doors/${i}/to`, `${dr.to} is not checked (no --base)`, 'pass --base <vanilla project>');
        else add('error', 'ref', d.rel, `/doors/${i}/to`, `room "${dr.to}" does not exist`, 'point the door at a room defined in this project or its base');
        return;
      }
      const dims = roomDims(dr.to);
      if (dims && (dr.arrive.x >= dims.width || dr.arrive.y >= dims.height)) add('error', 'arrive-bounds', d.rel, `/doors/${i}/arrive`, `arrival cell (${dr.arrive.x}, ${dr.arrive.y}) is outside ${dr.to} (${dims.width}x${dims.height})`, 'arrive is in cells of the destination room');
      const dest = roomDoc(dr.to);
      if (dest) {
        const back = (dest.doors || []).some((x) => bindings.resolve(x.to) === bindings.resolve(doc.id));
        if (!back && !doc.bind) add('warning', 'one-way', d.rel, `/doors/${i}`, `${dr.to} has no door back to this room`, 'add a door in the destination room (or ignore if the one-way exit is intended)');
        try {
          // arrive names the cell Kirby lands ON (vanilla: the floor cell under the
          // destination door), so the cell above it must be passable.
          const dc = decodeGrid(dest.collision, dest.size.width, dest.size.height);
          const at = (x, y) => (vocab.collision[ctx.collisionValue(dc[y * dest.size.width + x])] || {}).bits || '';
          const above = dr.arrive.y > 0 ? at(dr.arrive.x, dr.arrive.y - 1) : 'solid';
          if (/(^|\+)solid/.test(above) || above.includes('hazard')) add(doc.bind ? 'warning' : 'error', 'arrive-blocked', d.rel, `/doors/${i}/arrive`, `Kirby would arrive inside ${above} at cell (${dr.arrive.x}, ${dr.arrive.y - 1}) of ${dr.to}`, 'arrive is the cell Kirby stands on (usually the floor under the destination door); the cell above must be empty (23 vanilla doors break this rule, entering through a floor or ceiling)');
        } catch { /* destination's own errors are reported on it */ }
        // The camera never shows the bottom 40 px of a room (the view stops
        // at roomHeight - 200 px: FillLevelInfo's unk_S32Vec2_74), so Kirby
        // standing on one of the last two rows is drawn below the screen.
        // Vanilla floors sit 3-4 rows above the bottom (room 101: height 13,
        // floor row 9).  Found by playtesting the examples (web/playtest/).
        if (!doc.bind && dr.arrive.y > dest.size.height - 3) add('warning', 'camera-bottom', d.rel, `/doors/${i}/arrive`, `Kirby arrives on row ${dr.arrive.y} of ${dr.to}, ${dest.size.height - dr.arrive.y} row(s) from the bottom: the camera never shows the bottom 40 px of a room, so he would be off-screen`, 'keep floors at least 3 rows above the bottom of the room (vanilla rooms keep 3-4 solid rows under the floor)');
      }
    });
    // objects inside the room
    (doc.objects || []).forEach((o, i) => {
      if (o.x < 0 || o.y < 0 || o.x >= W * 16 || o.y >= H * 16) add(doc.bind ? 'warning' : 'error', 'object-bounds', d.rel, `/objects/${i}`, `${o.type} at (${o.x}, ${o.y}) px is outside the ${W * 16}x${H * 16} px room`, 'x, y are pixels; a cell centre is cell*16+8');
    });
    const ids = new Set();
    (doc.objects || []).forEach((o, i) => { if (o.id) { if (ids.has(o.id)) add('error', 'object-id', d.rel, `/objects/${i}/id`, `duplicate object id "${o.id}"`); ids.add(o.id); } });
    // fg art vs. GBA limits
    try {
      for (const [k, m] of Object.entries(doc.art.legend)) {
        const four = metaValues(m);
        for (const v of four) {
          if ((v >> 12) > 5 && (v >> 12) < 15) add(doc.bind ? 'warning' : 'error', 'limit-bank', d.rel, `/art/legend/${k}`, `palette bank ${v >> 12} belongs to the background`, 'foreground tiles use banks 0-5 (the room palette) or 15');
          if ((v & 0x3ff) >= 768) add('error', 'limit-tile', d.rel, `/art/legend/${k}`, `tile ${(v & 0x3ff).toString(16)} is past the 768 tiles the playfield can address`, 'tiles 000-2ff');
        }
      }
      const ts = bindings.resolve(doc.tileset) && bindings.docs.get(bindings.resolve(doc.tileset)).doc;
      if (ts) for (const [k, m] of Object.entries(doc.art.legend)) for (const v of metaValues(m)) if ((v & 0x3ff) >= ts.tileCount) { add('warning', 'tile-range', d.rel, `/art/legend/${k}`, `tile ${(v & 0x3ff).toString(16)} is past ${doc.tileset}'s ${ts.tileCount} tiles`, 'it will show whatever VRAM holds there'); break; }
    } catch { /* reported by compile */ }
    // nav sanity
    if (doc.nav) {
      try { decodeGrid(doc.nav, W, H).forEach((v, i) => { if (v >= doc.nav.nodes.length) throw Object.assign(new Error(), { v, i }); }); } catch (e) { if (e.v !== undefined) add('warning', 'nav-node', d.rel, '/nav', `cell ${e.i % W},${(e.i / W) | 0} names nav node ${e.v}; there are ${doc.nav.nodes.length}`, 'helpers in that region read past the node list'); }
    } else add('warning', 'nav-default', d.rel, '/nav', 'no nav graph: the compiler emits a one-node graph, so helper Kirbys will idle here', 'fine for a first version; see rooms.md "nav"');
    // spawn-ability: some door must deliver here, or it is a dead room
    const incoming = [...bindings.docs.values()].some(({ doc: o }) => o.format === 'katam-room/1' && (o.doors || []).some((x) => bindings.resolve(x.to) === bindings.resolve(doc.id)));
    if (!incoming && !doc.bind) add('warning', 'unreachable', d.rel, '', 'no door in the loaded projects leads here', 'add a door to this room from another room (or reach it by a warp star / --warp)');
    // grids, each on its own so one bad row does not hide the others
    let cgrid = null;
    for (const layer of ['art', 'collision', 'nav']) {
      if (!doc[layer]) continue;
      try { const g = decodeGrid(doc[layer], W, H, layer); if (layer === 'collision') cgrid = g; } catch (e) { add('error', 'grid', d.rel, e.where || layer, e.message, 'every row must be width keys long and use legend keys only'); }
    }
    // doors need door terrain under their cells, and usually a door object there
    if (cgrid) (doc.doors || []).forEach((dr, i) => (dr.cells || []).forEach(([x, y], j) => {
      if (x >= W || y >= H) return;
      let v; try { v = ctx.collisionValue(cgrid[y * W + x]); } catch { return; }
      // a patch on the cell (a block that breaks open) may be what turns it into a door
      const vals = [v, ...(doc.patches || []).filter((p) => p.x === x && p.y === y).map((p) => { try { return ctx.collisionValue(p.collision); } catch { return -1; } })];
      const bits = vals.map((k) => (vocab.collision[k] || {}).bits || '').join(' then ');
      if (!bits.includes('door')) add(doc.bind ? 'warning' : 'error', 'door-terrain', d.rel, `/doors/${i}/cells/${j}`, `door cell (${x}, ${y}) has collision ${v} (${bits || 'air'}), not a door value`, 'give door cells collision 255 (door), or a patch that turns the cell into a door (all 724 vanilla door cells do one or the other)');
      const hasObj = (doc.objects || []).some((o) => Math.floor(o.x / 16) === x && Math.floor(o.y / 16) === y);
      if (!hasObj && !doc.bind) add('warning', 'door-object', d.rel, `/doors/${i}/cells/${j}`, `no object at door cell (${x}, ${y})`, 'place a "door" object at the cell centre (x = cell*16+8) so the door is drawn');
    }));
    // everything structural: run the compiler itself
    try { compileRoom(doc, ctx); } catch (e) { add('error', 'compile', d.rel, e.where || '', e.message, e.hint); }
  }
  return res;
}
