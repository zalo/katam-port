// Projects: a folder of authoring files, plus the ID scheme and the context
// (name <-> number bindings) every codec needs.
//
//   <project>/project.json                              katam-project/1
//   <project>/rooms/<area>/<name>.room.json             room:<area>/<name>
//   <project>/tilesets/<ns>/<name>/tileset.json         tileset:<ns>/<name>   (+ tiles.png, anim.png)
//   <project>/backgrounds/<ns>/<name>/background.json   background:<ns>/<name> (+ tiles.png)
//   <project>/palettes/<ns>/<name>.palette.json         palette:<ns>/<name>
//   <project>/objects/<name>.object.json                object:<name>
//
// The path of a file is a function of its id and vice versa, so a tool or a
// model can find any resource from a reference without an index.
import { decodeGrid } from './grid.mjs';

export const PROJECT_FORMAT = 'katam-project/1';
/** The first id a new room gets: one past the original game's 983 room slots. */
export const FIRST_NEW_ROOM = 983;
/** The first content index a new room gets: one past the 287-entry per-room tables. */
export const FIRST_NEW_CONTENT = 287;
export const KINDS = {
  room: { dir: 'rooms', file: (n) => `${n}.room.json` },
  tileset: { dir: 'tilesets', file: (n) => `${n}/tileset.json` },
  background: { dir: 'backgrounds', file: (n) => `${n}/background.json` },
  palette: { dir: 'palettes', file: (n) => `${n}.palette.json` },
  object: { dir: 'objects', file: (n) => `${n}.object.json` },
};
export const ID_RE = /^(room|tileset|background|palette|object):([a-z0-9_]+(?:\/[a-z0-9_]+)*)$/;

export function parseId(id) {
  const m = ID_RE.exec(id || '');
  return m ? { kind: m[1], name: m[2] } : null;
}

export function pathOf(id) {
  const p = parseId(id);
  if (!p) throw new Error(`"${id}" is not a resource id (kind:namespace/name, lowercase)`);
  return `${KINDS[p.kind].dir}/${KINDS[p.kind].file(p.name)}`;
}

export function idOfPath(rel) {
  for (const [kind, k] of Object.entries(KINDS)) {
    if (!rel.startsWith(k.dir + '/')) continue;
    const rest = rel.slice(k.dir.length + 1);
    const tail = k.file('');
    if (rest.endsWith(tail)) return `${kind}:${rest.slice(0, rest.length - tail.length)}`;
  }
  return null;
}

/** Vanilla ids, frozen by rule (format katam-project/1):
 *  rooms: room:<area>/<roomId>, area from the area map table (sAreaMapRoomInfos),
 *  else "other";  tileset|palette|background:vanilla/<table index>;
 *  object:<OBJ_ name lowercased>.  room:vanilla/<roomId> is always an alias. */
export function vanillaRoomId(vocab, num) {
  return `room:${vocab.roomAreas[num] || 'other'}/${num}`;
}

/** Load every authoring file under `dir` -> {project, docs: Map(id -> {doc, rel, dir})} */
export function loadProject(io, dir) {
  const docs = new Map();
  const errors = [];
  const pj = `${dir}/project.json`;
  const project = io.exists(pj) ? JSON.parse(io.readText(pj)) : null;
  for (const abs of io.list(dir)) {
    const rel = abs.slice(dir.length + 1);
    const id = idOfPath(rel);
    if (!id) continue;
    let doc;
    try { doc = JSON.parse(io.readText(abs)); } catch (e) { errors.push({ file: rel, where: '', message: `not valid JSON: ${e.message}` }); continue; }
    const base = abs.slice(0, abs.lastIndexOf('/'));
    docs.set(id, { doc, rel, abs, base, project: dir });
  }
  return { project, docs, errors, dir };
}

/** Bindings across a project stack (base first, overriding project last). */
export class Bindings {
  constructor(vocab, layers) {
    this.vocab = vocab;
    this.docs = new Map();
    for (const L of layers) for (const [id, d] of L.docs) this.docs.set(id, d);
    this.alias = new Map();
    this.num = new Map();      // id -> roomId / table index / type
    this.content = new Map();  // room id -> content index
    const used = { room: new Set(), tileset: new Set(), background: new Set(), palette: new Set(), content: new Set() };
    const pending = { room: [], tileset: [], background: [], palette: [] };
    for (const [id, { doc }] of [...this.docs].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      const kind = parseId(id).kind;
      if (kind === 'room') {
        if (doc.bind && Number.isInteger(doc.bind.roomId)) { this.num.set(id, doc.bind.roomId); used.room.add(doc.bind.roomId); this.alias.set(`room:vanilla/${doc.bind.roomId}`, id); } else pending.room.push(id);
        if (doc.bind && Number.isInteger(doc.bind.content)) { this.content.set(id, doc.bind.content); used.content.add(doc.bind.content); }
      } else if (kind in pending) {
        if (doc.bind && Number.isInteger(doc.bind.index)) { this.num.set(id, doc.bind.index); used[kind].add(doc.bind.index); } else pending[kind].push(id);
      } else if (kind === 'object' && doc.bind) this.num.set(id, doc.bind.type);
    }
    // New rooms are numbered after the original game's ids: gRoomProps has
    // NUM_ROOM_SLOTS (983) entries, so new rooms take 983 and up, by sorted
    // id.  The runtime grows the room tables past the vanilla extent when it
    // loads the room bundle (MODDING.md R2).  The vanilla filler slots 1-100
    // are left alone, so a new room can never collide with an id the game
    // (or a save) already gives a meaning to.  New content and table indices
    // continue after the vanilla tables (see AUTHORING.md "Bindings").
    this.allocated = [];
    let next = FIRST_NEW_ROOM;
    for (const id of pending.room) {
      while (used.room.has(next)) next++;
      this.num.set(id, next); used.room.add(next); this.allocated.push([id, next]);
    }
    let nc = FIRST_NEW_CONTENT;
    for (const id of [...this.docs.keys()].filter((i) => i.startsWith('room:')).sort()) {
      if (this.content.has(id)) continue;
      while (used.content.has(nc)) nc++;
      this.content.set(id, nc); used.content.add(nc);
    }
    const tableBase = { tileset: 34, background: 36, palette: 42 };
    for (const k of Object.keys(tableBase)) {
      let n = tableBase[k];
      for (const id of pending[k]) { while (used[k].has(n)) n++; this.num.set(id, n); used[k].add(n); }
    }
    // reverse maps for decompile-side naming
    this.byNum = { room: new Map(), tileset: new Map(), background: new Map(), palette: new Map() };
    for (const [id, n] of this.num) { const k = parseId(id).kind; if (this.byNum[k]) this.byNum[k].set(n, id); }
  }

  resolve(id) {
    if (this.docs.has(id)) return id;
    if (this.alias.has(id)) return this.alias.get(id);
    return null;
  }
}

/** Collision legend vocabulary: registry names, else bit-derived glyph suggestions. */
export function collisionVocab(vocab, registry) {
  const named = registry.collisionEnum();
  const nameOf = new Map(), valueOf = new Map();
  for (const [v, e] of Object.entries(named)) {
    nameOf.set(Number(v), e.name);
    valueOf.set(e.name, Number(v));
    for (const a of e.aliases || []) valueOf.set(a, Number(v));
  }
  const glyph = (v) => {
    const e = named[v];
    if (e && e.glyph) return e.glyph;
    const b = vocab.collision[v] ? vocab.collision[v].bits : '';
    if (v === 0) return '.';
    if (b === 'solid') return '#';
    if (b.includes('door')) return 'D';
    if (b.includes('slope') && !b.includes('water')) return null;
    if (b.includes('top_solid')) return '=';
    if (b.includes('ladder')) return 'H';
    if (b.includes('water')) return '~';
    if (b.includes('hazard')) return '^';
    if (b.includes('breakable')) return '%';
    return null;
  };
  return {
    name: (v) => (nameOf.has(v) ? nameOf.get(v) : v),
    value: (x, where) => {
      if (Number.isInteger(x) && x >= 0 && x < 256) return x;
      if (typeof x === 'string' && valueOf.has(x)) return valueOf.get(x);
      const err = new Error(`unknown collision "${x}"`);
      err.where = where;
      err.hint = valueOf.size ? `use a name from the semantics registry (e.g. ${[...valueOf.keys()].slice(0, 6).join(', ')}) or a raw value 0-255` : 'no semantics registry is loaded: use a raw collision value 0-255 (0 = empty, 13 = solid); see vocab.json "collision"';
      throw err;
    },
    glyph,
  };
}

/** The codec context for one project stack. */
export function makeContext({ vocab, registry, bindings, external = false }) {
  const col = collisionVocab(vocab, registry);
  // external: references into a base that is not loaded resolve by the number
  // their vanilla id carries (room:<area>/<n>, <kind>:vanilla/<n>); used by
  // validate/render without --base, after warning that they are unchecked.
  const ext = (id) => { if (!external) return undefined; const m = /^(room:[a-z0-9_]+|tileset:vanilla|palette:vanilla|background:vanilla)\/(\d+)$/.exec(id || ''); return m ? Number(m[2]) : undefined; };
  const fail = (msg, where, hint) => { const e = new Error(msg); e.where = where; e.hint = hint; throw e; };
  return {
    vocab, registry, bindings,
    roomRef: (num) => (bindings && bindings.byNum.room.get(num)) || vanillaRoomId(vocab, num),
    roomNum: (id, where = 'id') => {
      const r = bindings.resolve(id);
      if (!r && ext(id) !== undefined) return ext(id);
      if (!r) fail(`room "${id}" does not exist`, where, 'reference a room id defined in this project or its base (room:<area>/<name>)');
      return bindings.num.get(r);
    },
    contentOf: (id) => bindings.content.get(bindings.resolve(id)),
    ref: (kind, idx) => (bindings && bindings.byNum[kind] && bindings.byNum[kind].get(idx)) || `${kind}:vanilla/${idx}`,
    refIdx: (kind, id, where) => {
      const r = bindings.resolve(id);
      if (!r && id && id.startsWith(kind + ':') && ext(id) !== undefined) return ext(id);
      if (!r || !id.startsWith(kind + ':')) fail(`${kind} "${id}" does not exist`, where, `reference a ${kind} defined in this project or its base (${kind}:<ns>/<name>)`);
      return bindings.num.get(r);
    },
    collisionName: col.name,
    collisionValue: col.value,
    collisionGlyph: col.glyph,
  };
}

export { decodeGrid };
