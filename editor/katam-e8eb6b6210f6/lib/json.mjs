// Canonical authoring JSON: 2-space indent, LF, keys in insertion order, and
// any value whose one-line form fits in WIDTH characters written on one line.
// Rows of a grid are long strings, so each lands on its own line: a one-cell
// edit is a one-line diff.
const WIDTH = 100;

export function stringify(v, indent = '') {
  const flat = JSON.stringify(v);
  if (flat === undefined) return 'null';
  if (v === null || typeof v !== 'object') return flat;
  if (flat.length + indent.length <= WIDTH && !hasLongString(v)) return spaced(v);
  const ni = indent + '  ';
  if (Array.isArray(v)) {
    if (!v.length) return '[]';
    return '[\n' + v.map((x) => ni + stringify(x, ni)).join(',\n') + '\n' + indent + ']';
  }
  const keys = Object.keys(v).filter((k) => v[k] !== undefined);
  if (!keys.length) return '{}';
  return '{\n' + keys.map((k) => ni + JSON.stringify(k) + ': ' + stringify(v[k], ni)).join(',\n') + '\n' + indent + '}';
}

function hasLongString(v) {
  return Object.values(v).some((x) => typeof x === 'string' && x.length > 60);
}

// {"a": 1, "b": [1, 2]} with a space after ':' and ',' (JSON.stringify has none)
function spaced(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(spaced).join(', ') + ']';
  return '{' + Object.keys(v).filter((k) => v[k] !== undefined).map((k) => JSON.stringify(k) + ': ' + spaced(v[k])).join(', ') + '}';
}

export const writeJson = (v) => stringify(v) + '\n';
