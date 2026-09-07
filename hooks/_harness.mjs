/*
 * RespawnPack · hooks/_harness.mjs — behavioral test harness for the governance hooks.
 *
 * WHY THIS EXISTS: until now CI syntax-checked the hooks and asserted the installer wired them. That
 * proves a file parses and a settings key exists. It does not prove the hook DOES anything, and three
 * shipped defects survived it for months:
 *   • precompact-ledger-nudge emitted a field PreCompact has no channel for, so its message has never
 *     once been delivered — in any project (DOGFOOD.md DF-002);
 *   • stop-savepoint gated on tree state rather than session delta, firing five times in a session that
 *     wrote zero files (field run A, 2026-08-03, defect 1);
 *   • context-monitor spoke only on `systemMessage`, which the published contract defines as
 *     user-visible — the model it was pacing never saw a word of it.
 * A wiring test cannot catch any of those. This harness feeds each hook realistic stdin in a controlled
 * environment and asserts on exact stdout JSON, exit codes, and on-disk side effects.
 *
 * Cross-platform by construction: hooks are spawned through process.execPath (never a shell), temp repos
 * live under os.tmpdir(), and every path is composed with path.join. The pack claims Windows + Linux
 * parity, so the suite has to be able to prove it on both runners.
 */
import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HOOKS_DIR = path.dirname(fileURLToPath(import.meta.url));

/*
 * THE PUBLISHED OUTPUT CONTRACT (code.claude.com/docs/en/hooks), transcribed rather than remembered.
 *
 * This table is the regression fence for DF-002. The failure there was not a typo — it was a hook
 * written against a channel that does not exist for its event, which no amount of re-reading the hook
 * would reveal. Encoding the contract once, here, means a future hook that invents a channel fails a
 * test instead of silently never speaking.
 */
export const UNIVERSAL_FIELDS = ['continue', 'stopReason', 'suppressOutput', 'systemMessage', 'terminalSequence'];

export const CONTRACT = {
  // event: { additionalContext: bool, topLevelDecision: bool, permissionDecision: bool, extra: [...] }
  SessionStart: { additionalContext: true, topLevelDecision: false, permissionDecision: false, extra: ['initialUserMessage', 'watchPaths', 'sessionTitle', 'reloadSkills'] },
  SubagentStart: { additionalContext: true, topLevelDecision: false, permissionDecision: false, extra: [] },
  UserPromptSubmit: { additionalContext: true, topLevelDecision: true, permissionDecision: false, extra: [] },
  PreToolUse: { additionalContext: true, topLevelDecision: false, permissionDecision: true, extra: ['updatedInput'] },
  PostToolUse: { additionalContext: true, topLevelDecision: true, permissionDecision: false, extra: [] },
  PostToolBatch: { additionalContext: true, topLevelDecision: false, permissionDecision: false, extra: [] },
  Stop: { additionalContext: true, topLevelDecision: true, permissionDecision: false, extra: [] },
  SubagentStop: { additionalContext: true, topLevelDecision: true, permissionDecision: false, extra: [] },
  // ⛔ PreCompact carries NO hookSpecificOutput at all. Top-level decision/reason only. This single
  // row is the whole of DF-002: the hook emitted hookSpecificOutput.additionalContext here for months.
  PreCompact: { additionalContext: false, topLevelDecision: true, permissionDecision: false, extra: [] },
  SessionEnd: { additionalContext: false, topLevelDecision: false, permissionDecision: false, extra: [] },
};

/**
 * Assert a hook's stdout JSON is legal for the event it claims to answer.
 * Returns the parsed object so callers can chain further assertions on it.
 */
export function assertValidHookOutput(event, json, assert) {
  if (json === null) return null; // silent exit is always valid — the hook chose not to speak
  const spec = CONTRACT[event];
  assert.ok(spec, `no published contract recorded for event "${event}" — add it to CONTRACT before asserting`);

  for (const key of Object.keys(json)) {
    const legal = UNIVERSAL_FIELDS.includes(key) || key === 'hookSpecificOutput' ||
      (spec.topLevelDecision && (key === 'decision' || key === 'reason'));
    assert.ok(legal, `${event}: illegal top-level output key "${key}"`);
  }

  const hso = json.hookSpecificOutput;
  if (hso === undefined) return json;

  // An event with no hookSpecificOutput channel must not emit the envelope at all.
  assert.ok(
    spec.additionalContext || spec.permissionDecision || spec.extra.length,
    `${event}: emitted hookSpecificOutput, but the published contract gives this event no such channel`,
  );
  assert.equal(hso.hookEventName, event, `${event}: hookSpecificOutput.hookEventName must echo the event`);

  for (const key of Object.keys(hso)) {
    if (key === 'hookEventName') continue;
    if (key === 'additionalContext') {
      assert.ok(spec.additionalContext, `${event}: additionalContext is not a channel this event supports`);
      continue;
    }
    if (key === 'permissionDecision' || key === 'permissionDecisionReason') {
      assert.ok(spec.permissionDecision, `${event}: permissionDecision is not a channel this event supports`);
      continue;
    }
    assert.ok(spec.extra.includes(key), `${event}: unknown hookSpecificOutput key "${key}"`);
  }
  return json;
}

/**
 * Run a hook with real stdin and capture everything observable about it.
 * `stdin` may be an object (JSON-encoded for you) or a raw string (to test malformed input).
 */
export function runHook(hookFile, stdin, opts = {}) {
  const input = typeof stdin === 'string' ? stdin : JSON.stringify(stdin ?? {});
  const res = spawnSync(process.execPath, [path.join(HOOKS_DIR, hookFile), ...(opts.argv || [])], {
    input,
    encoding: 'utf8',
    cwd: opts.cwd || HOOKS_DIR,
    // A hook must never inherit the developer's ambient config. Tests that want a variable set it
    // explicitly; everything else starts from the parent env minus the pack's own knobs.
    env: { ...process.env, RESPAWNPACK_SAVEPOINT_TOAST: 'off', ...(opts.env || {}) },
    timeout: opts.timeout || 30000,
  });
  let json = null;
  const out = (res.stdout || '').trim();
  if (out) { try { json = JSON.parse(out); } catch { /* left null — callers assert on parseability */ } }
  return { stdout: res.stdout || '', stderr: res.stderr || '', code: res.status, json, rawOut: out };
}

// --- temp git repos -------------------------------------------------------------------------------

const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/**
 * A throwaway git repo with one commit. `git init` alone is not enough: several hooks reason about
 * HEAD, and a repo with no commits has no HEAD to reason about — which is itself a case worth testing,
 * so `commit: false` is available.
 */
export function makeRepo(label, { commit = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `rp-hook-${label}-`));
  git(dir, 'init', '--quiet', '--initial-branch=main');
  git(dir, 'config', 'user.email', 'harness@respawnpack.test');
  git(dir, 'config', 'user.name', 'RespawnPack Harness');
  git(dir, 'config', 'commit.gpgsign', 'false');
  if (commit) {
    fs.writeFileSync(path.join(dir, 'README.md'), '# fixture\n');
    git(dir, 'add', 'README.md');
    git(dir, 'commit', '--quiet', '-m', 'initial');
  }
  return dir;
}

export function repoGit(dir, ...args) { return git(dir, ...args); }
export function head(dir) { return git(dir, 'rev-parse', 'HEAD').trim(); }

export function write(dir, rel, content) {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

export function readJSON(dir, rel) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, rel), 'utf8')); } catch { return null; }
}

export function rm(dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* windows lock — best effort */ } }

/** Standard stdin envelope: the common input fields every hook receives. */
export function stdinFor(event, extra = {}) {
  return {
    session_id: extra.session_id || 'test-session-0001',
    transcript_path: extra.transcript_path || path.join(os.tmpdir(), 'rp-nonexistent-transcript.jsonl'),
    cwd: extra.cwd || process.cwd(),
    permission_mode: 'default',
    hook_event_name: event,
    ...extra,
  };
}
