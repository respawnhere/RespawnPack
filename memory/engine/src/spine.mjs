// Spine-aware memory: read the docs spine's removals register (DECISIONS.md) and mirror each
// ⛔ removal into memory as a NEGATIVE entity, so recall surfaces "deliberately killed — do not
// reintroduce." This is the bridge the file/grep and MCP backends can't do — gbrain has no
// equivalent. Markdown stays the source of truth; these are derived, re-imported by sync.
import { readFileSync, existsSync } from 'node:fs';
import { assertInsideRoot } from './config.mjs';

const slugify = (s) => String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

/** Parse DECISIONS.md into removal records. @param {string} text */
export function parseRemovals(text) {
  const out = [];
  const entries = text.split(/\n(?=###\s)/);
  for (const e of entries) {
    const head = /^###\s+(.+)$/m.exec(e);
    if (!head) continue;
    const title = head[1].trim();
    const removal = /-\s*⛔\s*Removal:\s*(.+)/i.exec(e);
    const isRemoval = removal || /⛔\s*removal/i.test(title);
    if (!isRemoval) continue;
    const idm = /\bD-?(\d+)\b/i.exec(title);
    const decision = /-\s*Decision:\s*(.+)/i.exec(e);
    out.push({
      dId: idm ? `D-${idm[1]}` : '',
      title: title.replace(/\s*·.*$/, '').trim(), // drop the · date · status tail
      rationale: removal ? removal[1].trim() : (decision ? decision[1].trim() : title),
      decision: decision ? decision[1].trim() : '',
    });
  }
  return out;
}

/** Import DECISIONS.md removals into the engine as negative entities. `imported` reflects
 * removals that were actually NEW or CHANGED this run (body grew) — not every processed record,
 * so re-running spine-sync on an unchanged DECISIONS.md correctly reports 0 rather than the
 * misleading "re-imported N" on a pure no-op. @param {object} engine @param {string} [decisionsPath] */
export async function importRemovals(engine, decisionsPath) {
  if (decisionsPath) assertInsideRoot(engine.cfg.root, decisionsPath, 'spine path');
  const path = decisionsPath || `${engine.cfg.root}/docs/DECISIONS.md`;
  if (!existsSync(path)) return { imported: 0, path, found: false };
  const removals = parseRemovals(readFileSync(path, 'utf8'));
  let imported = 0;
  for (const r of removals) {
    const slug = slugify(r.title) || (r.dId ? r.dId.toLowerCase() : 'removal');
    const id = `decision:${slug}`;
    const before = await engine.get(id);
    const merged = await engine.remember({
      id,
      type: 'decision',
      negative: true,
      confidence: 1.0,
      aliases: r.dId ? [r.dId] : [],
      body: `## ⛔ Removed: ${r.title}\n${r.decision ? `## Decision\n${r.decision}\n` : ''}## Why it must not return\n${r.rationale}`,
    });
    // remember() always bumps updated_at (it's itself an "update" per the merge contract), so
    // compare content — body is the union-merged, monotonically-growing field — to tell a
    // genuinely new/changed entity from a pure re-run of already-imported content.
    if (!before || before.body !== merged.body) imported++;
  }
  return { imported, path, found: true };
}
