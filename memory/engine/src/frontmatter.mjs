// Minimal YAML frontmatter parse/serialize for RespawnPack memory entities.
// Deliberately tiny (no yaml dependency): scalars (string/number/bool) + inline string lists
// `key: [a, b]` with quote-aware splitting. SUPPORTED SUBSET: single-line values only (the
// writer never emits multi-line/block values); a hand-edited continuation line is ignored.

/** @typedef {Record<string, string|number|boolean|string[]>} Frontmatter */

const NUMERIC_KEYS = new Set(['confidence']); // only these coerce to Number, so '007'/ids stay strings

/** Split an inline list body (without the [ ]) respecting quotes, so quoted commas survive. */
function splitList(s) {
  const out = [];
  let cur = '', q = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '\\' && s[i + 1] === q) { cur += q; i++; }
      else if (ch === q) { q = null; }
      else cur += ch;
    } else if (ch === '"' || ch === "'") { q = ch; }
    else if (ch === ',') { out.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.filter(Boolean);
}

/** @param {string} text @returns {{ data: Frontmatter, body: string }} */
export function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { data: {}, body: (text || '').trim() };
  /** @type {Frontmatter} */
  const data = {};
  for (const line of m[1].split(/\r?\n/)) {
    const mm = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!mm) continue; // single-line subset: continuation lines are not supported
    const key = mm[1];
    const val = mm[2].trim();
    if (val === '') { data[key] = ''; continue; }
    if (/^\[.*\]$/.test(val)) data[key] = splitList(val.slice(1, -1));
    else if (val === 'true' || val === 'false') data[key] = val === 'true';
    else if (NUMERIC_KEYS.has(key) && /^-?\d+(\.\d+)?$/.test(val)) data[key] = Number(val);
    else data[key] = val.replace(/^["']|["']$/g, '');
  }
  return { data, body: (m[2] || '').trim() };
}

const quoteItem = (s) => (/[,"\[\]]/.test(String(s)) ? `"${String(s).replace(/"/g, '\\"')}"` : String(s));

/** @param {Frontmatter} data @param {string} body @returns {string} */
export function serializeFrontmatter(data, body) {
  const lines = ['---'];
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) lines.push(`${k}: [${v.map(quoteItem).join(', ')}]`);
    else lines.push(`${k}: ${v}`);
  }
  lines.push('---', '', (body || '').trim(), '');
  return lines.join('\n');
}
