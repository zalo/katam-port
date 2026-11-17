// Object types ("enemies", items, gadgets, bosses...): the per-type descriptor
// gUnk_08351648[type] (pack kind obj_desc) <-> katam-object/1.
//
// What is data today: score, hp, the ability Kirby copies, palette, tile
// budget.  Behaviour (speeds, timers, attack patterns) is code in game/src;
// docs/design/authoring/enemies.md is the migration plan for it.  The two
// pointers (constructor, animation bank) are code/ROM references kept verbatim
// so vanilla round-trips; a new type cannot be created from data alone yet.

export const OBJECT_FORMAT = 'katam-object/1';
const FREE = ['unk0', 'unk1', 'unk2', 'unk4', 'unk8', 'pad0A'];

export function decompileObjectType(rec, ctx) {
  const { vocab, registry: reg } = ctx;
  const name = vocab.objectTypeName[rec.id] ?? `type_${rec.id}`;
  const doc = { format: OBJECT_FORMAT, id: `object:${name}`, bind: { type: rec.id }, constName: rec.name };
  const t = reg.objectType(rec.id);
  if (t && t.category) doc.category = t.category;
  doc.ability = vocab.abilityName[rec.kirbyAbility] ?? rec.kirbyAbility;
  doc.numTiles = rec.numTiles;
  const stats = {}, raw = {};
  for (const f of FREE) {
    const n = reg.semName('obj_desc', f);
    if (n) stats[n] = rec[f]; else raw[f] = rec[f];
  }
  if (Object.keys(stats).length) doc.stats = stats;
  doc.raw = raw;
  doc.code = { constructor: rec.unk10, animation: rec.unk14 };
  return doc;
}

export function compileObjectType(doc, ctx) {
  const { vocab, registry: reg } = ctx;
  const ab = typeof doc.ability === 'number' ? doc.ability : vocab.abilities[doc.ability];
  if (ab === undefined) throw Object.assign(new Error(`unknown ability "${doc.ability}"`), { where: 'ability' });
  const rec = { id: doc.bind.type, name: doc.constName };
  const byName = reg.nameMap('obj_desc');
  for (const f of FREE) rec[f] = f === 'pad0A' ? [0, 0] : 0;
  for (const [k, v] of Object.entries(doc.stats || {})) {
    if (!byName[k]) throw Object.assign(new Error(`unknown stat "${k}"`), { where: `stats.${k}` });
    rec[byName[k]] = v;
  }
  for (const [k, v] of Object.entries(doc.raw || {})) rec[k] = v;
  rec.kirbyAbility = ab;
  rec.numTiles = doc.numTiles;
  rec.unk10 = doc.code.constructor;
  rec.unk14 = doc.code.animation;
  return rec;
}
