import { readFileSync, existsSync } from 'node:fs';
import { resolve, sep } from 'node:path';

/** A config-supplied path must stay within the project root (no absolute / ../ escapes). */
export function assertInsideRoot(root, p, label) {
  const base = resolve(root);
  const full = resolve(root, p);
  if (full !== base && !full.startsWith(base + sep)) throw new Error(`${label} escapes the project root: ${p}`);
}

// The knowledge-graph vocabulary (memory/knowledge-graph.md) — shared by every backend.
export const ENTITY_TYPES = ['gotcha', 'infra', 'compat', 'decision', 'hyp'];
// The 5 knowledge-graph verbs + `applies-to` (links a lesson to the skill it informs).
export const RELATION_VERBS = ['depends-on', 'causes', 'fixed-by', 'supersedes', 'relates-to', 'applies-to'];

// Pluggable by config — no hard cloud default. The `local` embedder is a zero-config OFFLINE
// fallback (hashed bag-of-tokens, not semantic) so the engine runs with no API key; configure
// `ollama` or `openai` in respawn-memory.config.json for real recall quality.
export const DEFAULTS = {
  memoryDir: 'memory/graph', // entity markdown source of truth (memory/graph/<type>/<slug>.md)
  dataDir: 'memory/.index',  // PGLite data dir; 'memory:' for an ephemeral in-memory index
  chunkChars: 1200,
  queryLog: true, // fail-silent JSONL of every search()/recall() call under dataDir; `false` or
                   // env RESPAWN_MEMORY_QUERY_LOG=0 disables (also off for the 'memory:' ephemeral dataDir)
  embeddings: { provider: 'local', model: 'hash-256', dim: 256, baseUrl: '', apiKeyEnv: '' },
};

/** @param {string} root @param {object} [overrides] */
export function loadConfig(root = process.cwd(), overrides = {}) {
  let file = {};
  const p = resolve(root, 'respawn-memory.config.json');
  if (existsSync(p)) { try { file = JSON.parse(readFileSync(p, 'utf8')); } catch { /* ignore malformed config */ } }
  const cfg = { ...DEFAULTS, ...file, ...overrides };
  cfg.embeddings = { ...DEFAULTS.embeddings, ...(file.embeddings || {}), ...(overrides.embeddings || {}) };
  cfg.root = root;
  if (cfg.dataDir !== 'memory:') assertInsideRoot(root, cfg.dataDir, 'dataDir');
  assertInsideRoot(root, cfg.memoryDir, 'memoryDir');
  return cfg;
}
