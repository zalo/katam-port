// katam describe: compact, model-friendly reference text built from the
// schemas, vocab.json and the semantics registry (whatever is loaded).
//   describe room          top-level room fields and what they mean
//   describe collision     every collision value: name (registry), bits, usage in vanilla
//   describe objects [s]   object types (filter by substring): number, category, params
//   describe music         song names
export function describe(what, filter, { vocab, registry, schemas }) {
  const out = [];
  const f = (s) => !filter || String(s).includes(filter);
  if (what === 'room') {
    const s = schemas.get('katam:schema/room');
    out.push(s.description, '');
    for (const [k, p] of Object.entries(s.properties)) out.push(`${k}${s.required.includes(k) ? ' (required)' : ''}: ${p.description || (p.$ref ? schemas.get('katam:schema/common').$defs[p.$ref.split('/').pop()].description : '')}`);
  } else if (what === 'collision') {
    const named = registry.collisionEnum();
    out.push('value  name                      bits (from gCollisionAttributes)');
    for (const c of vocab.collision) {
      if (c.bits === 'unused' && !named[c.value]) continue;
      const n = named[c.value] ? named[c.value].name : '-';
      if (f(n) || f(c.bits)) out.push(`${String(c.value).padStart(5)}  ${n.padEnd(26)}${c.bits}${named[c.value] && named[c.value].cells !== undefined ? `   (${named[c.value].cells} vanilla cells)` : ''}`);
    }
    if (!Object.keys(named).length) out.push('', '(no semantics registry loaded: use the numbers in legends)');
  } else if (what === 'objects') {
    for (const [name, num] of Object.entries(vocab.objectTypes)) {
      if (!f(name)) continue;
      const t = registry.objectType(num);
      out.push(`${name} (0x${num.toString(16)})${t && t.category ? ` [${t.category}]` : ''}${t && t.description ? ': ' + t.description : ''}`);
      for (const p of (t && t.params) || []) { const n = registry.nameOf(p); out.push(`    ${n ? `params.${n}` : `raw.${p.field}`}${n ? ` (raw.${p.field})` : ''}: ${(p.description || '').slice(0, 160)}`); }
    }
  } else if (what === 'music') {
    for (const n of Object.keys(vocab.songs)) if (n.startsWith('mus_') && f(n)) out.push(n);
  } else {
    return 'describe room | collision | objects [filter] | music [filter]';
  }
  return out.join('\n');
}
