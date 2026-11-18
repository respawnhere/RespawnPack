/*
 * RespawnPack · kernel/lib/memory.js — what distribution of memory this target carries.
 *
 * ⭐ ONE BACKEND. File-backed memory (memory/graph + grep) is the zero-setup DEFAULT and the only
 * backend the pack ships. The optional memory engine and its MCP probe were retired with `--with-memory`
 * (decision 33, 2026-10-09): the engine returned an empty recall after every reinstall until a manual
 * sync, and every upgrade had to be followed by `install.js --with-memory`. The host's own auto memory
 * now carries the mirror of each promoted lesson, written at `memory candidates promote` time, so there
 * is no second store to keep in sync and no server process to prove reachable. `doctor`'s memory row
 * reports the file backend directly, with no probe.
 */

/**
 * What this target records about its memory distribution. Always the file backend now.
 * Returns { mode: 'file', detail }.
 *
 * ⭐ `file` IS NOT A DEGRADED STATE. Markdown-and-grep memory works with no npm, no MCP registration
 * and no external service. It is the one backend, not a fallback.
 */
function distribution(_dir) {
  return {
    mode: 'file',
    detail: 'file-backed memory (memory/graph + grep) — the zero-setup default and the one backend the pack ships',
  };
}

module.exports = { distribution };
