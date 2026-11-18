// A small JSON Schema (draft 2020-12) validator: the subset the authoring
// schemas use.  Zero dependencies so it runs in the editor too; the schemas
// themselves are standard and work with any full validator (ajv, jsonschema).
//
// Supported: type, enum, const, pattern, minLength, maxLength, minimum,
// maximum, multipleOf, properties, required, additionalProperties,
// patternProperties, propertyNames, items, prefixItems, minItems, maxItems,
// uniqueItems, allOf, anyOf, oneOf, not, if/then/else, $ref (#/$defs/... and
// other loaded schemas by $id).  Unknown keywords are ignored (annotations).
export class SchemaSet {
  constructor() { this.byId = new Map(); }
  add(schema) { this.byId.set(schema.$id, schema); return this; }
  get(id) { return this.byId.get(id); }

  validate(id, value) {
    const root = this.byId.get(id);
    if (!root) throw new Error(`no schema ${id}`);
    const errors = [];
    this._v(root, root, value, '', errors);
    return errors;
  }

  _ref(root, ref) {
    const [file, frag] = ref.split('#');
    const base = file ? this.byId.get(file) : root;
    if (!base) throw new Error(`unresolved $ref ${ref}`);
    let s = base;
    for (const part of (frag || '').split('/').filter(Boolean)) s = s[decodeURIComponent(part)];
    if (!s) throw new Error(`unresolved $ref ${ref}`);
    return { s, root: base };
  }

  _v(root, s, v, path, errs) {
    if (s === true || s === undefined) return;
    if (s === false) { errs.push({ path, message: 'no value is allowed here' }); return; }
    if (s.$ref) { const r = this._ref(root, s.$ref); this._v(r.root, r.s, v, path, errs); }
    const t = typeOf(v);
    if (s.type) {
      const ts = Array.isArray(s.type) ? s.type : [s.type];
      if (!ts.some((x) => x === t || (x === 'number' && t === 'integer'))) {
        errs.push({ path, message: `expected ${ts.join(' or ')}, got ${t}${t === 'number' ? ` (${v})` : ''}`, schema: s });
        return;
      }
    }
    if ('const' in s && JSON.stringify(s.const) !== JSON.stringify(v)) errs.push({ path, message: `must be ${JSON.stringify(s.const)}`, schema: s });
    if (s.enum && !s.enum.some((e) => JSON.stringify(e) === JSON.stringify(v))) {
      errs.push({ path, message: `${JSON.stringify(v)} is not one of the allowed values`, hint: suggest(v, s.enum), schema: s });
    }
    if (t === 'string') {
      if (s.pattern && !new RegExp(s.pattern, 'u').test(v)) errs.push({ path, message: `"${short(v)}" does not match ${s.pattern}`, schema: s });
      if (s.minLength !== undefined && v.length < s.minLength) errs.push({ path, message: `shorter than ${s.minLength}`, schema: s });
      if (s.maxLength !== undefined && v.length > s.maxLength) errs.push({ path, message: `longer than ${s.maxLength}`, schema: s });
    }
    if (t === 'integer' || t === 'number') {
      if (s.minimum !== undefined && v < s.minimum) errs.push({ path, message: `${v} < minimum ${s.minimum}`, schema: s });
      if (s.maximum !== undefined && v > s.maximum) errs.push({ path, message: `${v} > maximum ${s.maximum}`, schema: s });
      if (s.multipleOf && v % s.multipleOf) errs.push({ path, message: `${v} is not a multiple of ${s.multipleOf}`, schema: s });
    }
    if (t === 'object') {
      const keys = Object.keys(v);
      for (const r of s.required || []) if (!(r in v)) errs.push({ path, message: `missing required "${r}"`, schema: s });
      if (s.propertyNames) for (const k of keys) this._v(root, s.propertyNames, k, `${path}/${esc(k)}`, errs);
      for (const k of keys) {
        let matched = false;
        if (s.properties && k in s.properties) { matched = true; this._v(root, s.properties[k], v[k], `${path}/${esc(k)}`, errs); }
        for (const [re, ps] of Object.entries(s.patternProperties || {})) if (new RegExp(re, 'u').test(k)) { matched = true; this._v(root, ps, v[k], `${path}/${esc(k)}`, errs); }
        if (!matched && s.additionalProperties !== undefined) {
          if (s.additionalProperties === false) errs.push({ path: `${path}/${esc(k)}`, message: `unknown property "${k}"`, hint: suggest(k, Object.keys(s.properties || {})), schema: s });
          else this._v(root, s.additionalProperties, v[k], `${path}/${esc(k)}`, errs);
        }
      }
    }
    if (t === 'array') {
      if (s.minItems !== undefined && v.length < s.minItems) errs.push({ path, message: `needs at least ${s.minItems} item(s)`, schema: s });
      if (s.maxItems !== undefined && v.length > s.maxItems) errs.push({ path, message: `at most ${s.maxItems} item(s)`, schema: s });
      const pre = s.prefixItems || [];
      v.forEach((x, i) => {
        if (i < pre.length) this._v(root, pre[i], x, `${path}/${i}`, errs);
        else if (s.items !== undefined) this._v(root, s.items, x, `${path}/${i}`, errs);
      });
      if (s.uniqueItems && new Set(v.map((x) => JSON.stringify(x))).size !== v.length) errs.push({ path, message: 'items must be unique', schema: s });
    }
    for (const sub of s.allOf || []) this._v(root, sub, v, path, errs);
    if (s.anyOf && !s.anyOf.some((sub) => this._ok(root, sub, v))) errs.push({ path, message: `${short(JSON.stringify(v) || '')} matches none of the allowed forms (${forms(s.anyOf)})`, hint: enumHint(v, s.anyOf) || s.description, schema: s });
    if (s.oneOf) {
      const n = s.oneOf.filter((sub) => this._ok(root, sub, v)).length;
      if (n !== 1) errs.push({ path, message: n ? 'matches more than one allowed form' : `matches none of the allowed forms (${forms(s.oneOf)})`, hint: enumHint(v, s.oneOf) || s.description, schema: s });
    }
    if (s.not && this._ok(root, s.not, v)) errs.push({ path, message: 'matches a form that is not allowed', schema: s });
    if (s.if) {
      if (this._ok(root, s.if, v)) { if (s.then) this._v(root, s.then, v, path, errs); } else if (s.else) this._v(root, s.else, v, path, errs);
    }
  }

  _ok(root, s, v) { const e = []; this._v(root, s, v, '', e); return !e.length; }
}

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}
const esc = (k) => String(k).replace(/~/g, '~0').replace(/\//g, '~1');
const short = (s) => (s.length > 40 ? s.slice(0, 37) + '...' : s);
const enumHint = (v, subs) => { const e = subs.flatMap((x) => x.enum || []); return e.length ? suggest(v, e) : undefined; };
const forms = (subs) => subs.map((x) => x.description || x.type || (x.$ref || '').split('/').pop()).filter(Boolean).join(' | ');

function lev(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

/** "did you mean" for enum misses */
export function suggest(v, options) {
  const strs = options.filter((o) => typeof o === 'string');
  if (typeof v !== 'string' || !strs.length) return undefined;
  const near = strs.map((o) => [lev(v, o) - (o.includes(v) || v.includes(o) ? 2 : 0), o]).sort((a, b) => a[0] - b[0]).slice(0, 3).map((x) => x[1]);
  return `did you mean ${near.map((x) => JSON.stringify(x)).join(', ')}?`;
}
