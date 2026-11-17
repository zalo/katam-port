// Consumer side of the semantics registry (assets/schema/semantics/*.json,
// format "katam-semantics/1", owned by the `semantics` work; spec in
// docs/design/semantics/README.md on that branch).
//
// The contract the authoring layer relies on, and nothing more:
//   - a record is found by its `record` key, a field by its C member name (`field`);
//   - a field's semantic `name` is used in authoring files only when the
//     registry is sure of it (confidence confirmed|likely, usage not padding);
//     otherwise the field stays `raw.<cField>`;
//   - `raw.<cField>` is ALWAYS accepted on input, whatever the registry says,
//     so improving the registry never invalidates a file;
//   - an optional `aliases: [..]` on a field (or enum value) keeps old names valid
//     after a rename.
// With no registry present everything is raw, and every tool still works.

const SURE = new Set(['confirmed', 'likely']);

export class Registry {
  constructor(files = []) {
    this.records = new Map();
    this.objectTypes = new Map();
    this.sources = [];
    for (const { path, json } of files) this.add(path, json);
  }

  add(path, json) {
    if (!json || typeof json !== 'object') return;
    if (json.format && !String(json.format).startsWith('katam-semantics/')) return;
    this.sources.push(path);
    const recs = Array.isArray(json.records) ? json.records : [json];
    for (const r of recs) {
      if (!r || !r.record) continue;
      if (r.record === 'object_params' && r.types) {
        for (const [k, t] of Object.entries(r.types)) this.objectTypes.set(Number(k), t);
        continue;
      }
      this.records.set(r.record, r);
    }
  }

  get empty() { return this.records.size === 0 && this.objectTypes.size === 0; }

  field(record, cField) {
    const r = this.records.get(record);
    return r && Array.isArray(r.fields) ? r.fields.find((f) => f.field === cField) || null : null;
  }

  /** The authoring name for a field, or null when it must stay raw. */
  nameOf(entry) {
    if (!entry || !entry.name) return null;
    if (entry.usage === 'padding') return null;
    if (entry.confidence && !SURE.has(entry.confidence)) return null;
    return entry.name;
  }

  semName(record, cField) { return this.nameOf(this.field(record, cField)); }

  /** {name -> cField} for one record, including aliases. */
  nameMap(record) {
    const out = {};
    const r = this.records.get(record);
    for (const f of (r && r.fields) || []) {
      const n = this.nameOf(f);
      if (n) out[n] = f.field;
      for (const a of f.aliases || []) out[a] = f.field;
    }
    return out;
  }

  /** Per-object-type parameter entries: {cField -> entry}. */
  objectParams(type) {
    const t = this.objectTypes.get(type);
    const out = {};
    for (const p of (t && t.params) || []) if (p.field) out[p.field] = p;
    return out;
  }

  objectType(type) { return this.objectTypes.get(type) || null; }

  /** Collision value enum: value -> {name, description}.  Looks for the
   *  metatile record's value enum wherever the registry put it. */
  collisionEnum() {
    const r = this.records.get('metatile_attr') || this.records.get('metatile_attributes') || this.records.get('collision');
    if (!r) return {};
    const src = r.values || r.enum || (Array.isArray(r.fields) && (r.fields.find((f) => f.enum && Object.keys(f.enum).length > 16) || {}).enum) || {};
    const out = {};
    for (const [k, v] of Object.entries(src)) {
      const val = Number(k);
      const e = typeof v === 'string' ? { name: v } : v;
      if (Number.isInteger(val) && e && e.name) out[val] = e;
    }
    return out;
  }
}

/** Load every *.json under a directory through an io adapter (see io.mjs). */
export function loadRegistry(io, dir) {
  if (!io.exists(dir)) return new Registry();
  const files = [];
  for (const p of io.list(dir).filter((p) => p.endsWith('.json')).sort()) {
    try { files.push({ path: p, json: JSON.parse(io.readText(p)) }); } catch (e) { /* malformed registry file: ignore, validator of that branch reports it */ }
  }
  return new Registry(files);
}
