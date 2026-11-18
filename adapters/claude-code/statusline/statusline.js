#!/usr/bin/env node
/*
 * RespawnPack · adapters/claude-code/statusline/statusline.js — OPT-IN statusline tee.
 *
 * PLACED BY install/install.js (P5-CT-4), but OPT-IN AT THE SETTINGS LEVEL: the installer never writes
 * or overwrites `.claude/settings.json`'s `statusLine` command — see README.md in this directory for
 * wiring it in by hand. `respawnpack.js doctor`'s `host-adapter:claude-statusline` row reports whether
 * the file is placed and loads, and separately whether the settings slot actually names it; neither
 * check is a fired canary, which is still future work, named as such rather than assumed.
 *
 * ⭐ WHAT THIS BUYS. hooks/context-monitor.js's best measurement source without this file is the
 * transcript's own `usage` block — real, but the transcript JSONL format is EXPLICITLY INTERNAL
 * (core/lifecycle/evidence.js SOURCE_CONFIDENCE marks it LOW for exactly that reason). The statusLine
 * command's stdin JSON, by contrast, is a DOCUMENTED contract (code.claude.com/docs/en/statusline) that
 * carries a context-usage block — a `documented-api` source, HIGH confidence, the same tier the SDK
 * supervisor's own measurement gets from the SDK's usage fields. Running this script does not change what
 * the transcript contains; it gives context-monitor.js a documented number to prefer over it.
 *
 * ⛔ THE INPUT SHAPE IS DEFENSIVELY READ, NOT ASSUMED. The published statusline payload has carried
 * context-usage information under more than one key across releases, and this environment cannot execute
 * a live handshake to pin today's exact shape (see adapters/claude-code/sdk-supervisor's own probe, which
 * hits the same wall for a different reason). So this script looks in EVERY plausible location
 * (`context_window`, `current_usage`, and a couple of nested variants) and TEES NOTHING when none of them
 * answers with real numbers — a file with the right timestamp and no real measurement would read as HIGH
 * confidence for a number that was never actually observed, which is worse than staying silent. The
 * brief's own verified fact travels here unembellished: `current_usage` is documented to read `null`
 * immediately after `/compact`, until the next statusline call — which this script treats exactly like
 * "no usage this call", not like a zero.
 *
 * Contract (Claude Code statusLine): stdin = JSON describing the current turn (model, workspace, cost,
 * and a context-usage block under one of the keys above). stdout = ONE LINE of plain text (not JSON) —
 * this is what the UI displays verbatim. Exit 0 always: a broken statusline command shows as a blank or
 * error line in the UI, never a failed turn, so this script never throws past its own try/catch.
 */
'use strict';

const path = require('path');

// core/_io.js is a zero-dependency leaf (fs/path/crypto only — see its own header) — safe to require
// directly without the hooks/_boot.js bootstrap boundary, which is specific to hooks/_*.js's own
// contract registry and does not cover this directory. A missing/broken core/ degrades to "print a
// status line, tee nothing" rather than a blank or crashing statusline.
let io = null;
try { io = require(path.join(__dirname, '..', '..', '..', 'core', '_io.js')); } catch { io = null; }

const FRESH_WINDOW_MS = 60 * 1000; // must match hooks/context-monitor.js's STATUSLINE_FRESH_MS

// The same simple sanitizer hooks/_runtime.js and hooks/context-monitor.js use for a filename segment.
// Not core/_io.js's safeSegment (which also guards Windows reserved device names) — this script writes
// exactly one filename shape, in one fixed directory, so the lighter, dependency-free form is enough and
// keeps this script's own core/ dependency limited to _io.js's atomic-write primitive alone.
const safeId = (id) => String(id || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');

/**
 * Find a usage block wherever the host put it this release. Returns {used_percentage,
 * remaining_percentage, context_window_size} with only the fields that were actually present, or null.
 */
function findUsage(input) {
  const candidates = [
    input && input.context_window,
    input && input.current_usage,
    input && input.usage && input.usage.context_window,
    input && input.cost && input.cost.context_window,
  ];
  for (const c of candidates) {
    if (!c || typeof c !== 'object') continue; // covers the documented `current_usage: null` right after /compact
    if (typeof c.used_percentage !== 'number' || !Number.isFinite(c.used_percentage)) continue;
    return {
      used_percentage: c.used_percentage,
      remaining_percentage: typeof c.remaining_percentage === 'number' ? c.remaining_percentage : (100 - c.used_percentage),
      context_window_size: typeof c.context_window_size === 'number' ? c.context_window_size : null,
    };
  }
  return null;
}

function statusLine(input) {
  const model = (input.model && (input.model.display_name || input.model.id)) || 'unknown model';
  const usage = findUsage(input);
  return usage
    ? `RespawnPack | ${model} | context ${Math.round(usage.used_percentage)}% used`
    : `RespawnPack | ${model} | context usage unavailable this call`;
}

function tee(input, usage) {
  if (!io || !usage) return { teed: false, why: !io ? 'core/_io.js unavailable' : 'no documented usage block this call' };
  const dir = (input.workspace && (input.workspace.project_dir || input.workspace.current_dir)) || input.cwd || process.cwd();
  const sid = String(input.session_id || 'unknown');
  const file = path.join(dir, '.respawnpack', 'runtime', `context-usage-${safeId(sid)}.json`);
  const w = io.writeAtomicJSON(file, {
    used_percentage: usage.used_percentage,
    remaining_percentage: usage.remaining_percentage,
    context_window_size: usage.context_window_size,
    at: new Date().toISOString(),
  });
  return { teed: w.ok, file, why: w.ok ? null : w.detail };
}

// ⛔ THIS SCRIPT IS BOTH AN EXECUTABLE AND A TESTABLE MODULE, AND THE TWO MUST NOT COLLIDE. Requiring
// this file for its exports (findUsage/statusLine/tee, from adapters/claude-code/statusline/
// statusline.test.mjs) must start NOTHING — a module-scope stdin listener with no matching EOF holds
// the event loop open forever, which a unit test does not control and cannot close. Wiring it as a real
// statusLine command DOES need the stdin-reading main to run unconditionally on invocation. `require.main
// === module` is the one guard that satisfies both: true only when this file is the process's own entry
// point (a direct `node statusline.js` or Claude Code's own statusLine command spawn), false whenever
// something else `require()`s it.
if (require.main === module) {
  let raw = '';
  process.stdin.on('data', (d) => { raw += d; });
  process.stdin.on('end', () => {
    let input = {};
    try { input = JSON.parse(raw || '{}') || {}; } catch { input = {}; }
    try {
      const usage = findUsage(input);
      tee(input, usage); // best-effort; the status line prints regardless of whether the tee landed
      process.stdout.write(statusLine(input));
    } catch {
      // Never let a malformed payload or a filesystem error produce a blank/crashed status line.
      process.stdout.write('RespawnPack');
    }
    process.exit(0);
  });
}

module.exports = { findUsage, statusLine, tee, FRESH_WINDOW_MS, safeId };
