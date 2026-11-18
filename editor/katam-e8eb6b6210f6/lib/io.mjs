// File access behind a tiny synchronous interface, so the library runs in node
// (nodeIO) and in a browser editor (memoryIO over files it loaded from OPFS,
// a zip, or fetch).  Paths are '/'-separated.
export function memoryIO(files = new Map()) {
  const norm = (p) => p.replace(/\/+/g, '/').replace(/\/$/, '');
  return {
    files,
    exists: (p) => { p = norm(p); if (files.has(p)) return true; for (const k of files.keys()) if (k.startsWith(p + '/')) return true; return false; },
    isDir: (p) => { p = norm(p); for (const k of files.keys()) if (k.startsWith(p + '/')) return true; return false; },
    readText: (p) => { const v = files.get(norm(p)); if (v === undefined) throw new Error(`no such file: ${p}`); return typeof v === 'string' ? v : new TextDecoder().decode(v); },
    readBytes: (p) => { const v = files.get(norm(p)); if (v === undefined) throw new Error(`no such file: ${p}`); return typeof v === 'string' ? new TextEncoder().encode(v) : v; },
    writeText: (p, s) => files.set(norm(p), s),
    writeBytes: (p, b) => files.set(norm(p), b),
    list: (dir) => { dir = norm(dir); return [...files.keys()].filter((k) => k.startsWith(dir + '/')).sort(); },
  };
}

export async function nodeIO() {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const list = (dir) => {
    const out = [];
    const rec = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = d + '/' + e.name;
        if (e.isDirectory()) rec(p); else out.push(p);
      }
    };
    if (fs.existsSync(dir)) rec(dir.replace(/\/$/, ''));
    return out.sort();
  };
  const mk = (p) => fs.mkdirSync(path.dirname(p), { recursive: true });
  return {
    exists: (p) => fs.existsSync(p),
    isDir: (p) => fs.existsSync(p) && fs.statSync(p).isDirectory(),
    readText: (p) => fs.readFileSync(p, 'utf8'),
    readBytes: (p) => new Uint8Array(fs.readFileSync(p)),
    writeText: (p, s) => { mk(p); fs.writeFileSync(p, s); },
    writeBytes: (p, b) => { mk(p); fs.writeFileSync(p, b); },
    list,
  };
}
