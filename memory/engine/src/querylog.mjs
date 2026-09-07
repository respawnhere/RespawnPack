// Lesson 1: query logging. A fail-silent JSONL append of every search()/recall() call, so query
// patterns are observable after the fact (what gets asked, what it hits, how long it takes) —
// their querylog.py pattern, cut down to a single append-only file (no rotation/analytics here).
// Wired from engine.mjs's query()/recall() methods, NOT retrieve.mjs's search()/recall()
// functions — recall() calls search() internally to seed, and logging at the lower layer would
// double-log a single m.recall() call as both a "search" and a "recall" entry.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

/** Whether query logging is active for this cfg: needs a real (non-ephemeral) dataDir, and is
 * not turned off by config or the env var. @param {object} cfg */
export function queryLogEnabled(cfg) {
  if (!cfg || cfg.dataDir === 'memory:') return false; // no on-disk dir to log into
  if (cfg.queryLog === false) return false;
  if (process.env.RESPAWN_MEMORY_QUERY_LOG === '0') return false;
  return true;
}

function queryLogPath(cfg) {
  return join(resolve(cfg.root, cfg.dataDir), 'query-log.jsonl');
}

/**
 * Append one JSONL entry. Wrapped so this can NEVER throw into a query — any failure (disk full,
 * permissions, a bad path) is swallowed silently; logging is a side channel, not part of the
 * query's contract. @param {object} cfg @param {{kind:'search'|'recall', query:string, k:number,
 *   hit_ids:string[], duration_ms:number}} entry
 */
export function logQuery(cfg, entry) {
  try {
    if (!queryLogEnabled(cfg)) return;
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
    appendFileSync(queryLogPath(cfg), line);
  } catch { /* logging must never break a query */ }
}

/** Read back the query log, most-recent-last (its natural append order); [] if absent, disabled,
 * or unreadable. @param {object} cfg @param {{limit?:number}} [opts] */
export function readQueryLog(cfg, opts = {}) {
  try {
    const path = queryLogPath(cfg);
    if (!existsSync(path)) return [];
    const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
    const limited = opts.limit ? lines.slice(-opts.limit) : lines;
    return limited.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}
