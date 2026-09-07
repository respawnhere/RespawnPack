/*
 * RespawnPack · adapters/claude-code/statusline/statusline.test.mjs — behavioral tests for the opt-in
 * statusline tee: real process runs (stdin in, stdout + a filesystem side effect out), the same style
 * hooks/hooks.test.mjs uses for the hooks it exercises.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'statusline.js');
const require_ = createRequire(import.meta.url);
const { findUsage, statusLine, FRESH_WINDOW_MS } = require_(SCRIPT);

function tmpProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rp-statusline-'));
}
function rm(dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }

function run(input, opts = {}) {
  const res = spawnSync(process.execPath, [SCRIPT], {
    input: typeof input === 'string' ? input : JSON.stringify(input ?? {}),
    encoding: 'utf8', cwd: opts.cwd || HERE, timeout: 15000,
  });
  return { stdout: res.stdout || '', stderr: res.stderr || '', code: res.status };
}

// ---------------------------------------------------------------------------------------------
describe('findUsage · defensive, multi-shape reading', () => {
  test('reads context_window', () => {
    const u = findUsage({ context_window: { used_percentage: 42, remaining_percentage: 58, context_window_size: 200000 } });
    assert.deepEqual(u, { used_percentage: 42, remaining_percentage: 58, context_window_size: 200000 });
  });

  test('reads current_usage, and fills a missing remaining_percentage from the complement', () => {
    const u = findUsage({ current_usage: { used_percentage: 30 } });
    assert.equal(u.used_percentage, 30);
    assert.equal(u.remaining_percentage, 70);
    assert.equal(u.context_window_size, null);
  });

  test('current_usage: null (documented, right after /compact) reads as no usage, never as 0%', () => {
    const u = findUsage({ current_usage: null });
    assert.equal(u, null);
  });

  test('no recognizable usage block anywhere → null, never a fabricated number', () => {
    assert.equal(findUsage({}), null);
    assert.equal(findUsage({ model: { id: 'x' } }), null);
    assert.equal(findUsage(null), null);
  });
});

describe('statusLine · always one line, never JSON, never blank', () => {
  test('with usage', () => {
    const line = statusLine({ model: { display_name: 'Claude' }, context_window: { used_percentage: 55 } });
    assert.match(line, /^RespawnPack \|/);
    assert.match(line, /55% used/);
  });

  test('without usage — still a real line, says so honestly', () => {
    const line = statusLine({ model: { display_name: 'Claude' } });
    assert.match(line, /context usage unavailable/);
  });
});

// ---------------------------------------------------------------------------------------------
describe('the real script · stdin in, one plain-text line out, an atomic tee as a side effect', () => {
  test('a documented usage block produces a status line AND tees the runtime file', () => {
    const dir = tmpProject();
    try {
      const sid = 'sess-tee-1';
      const r = run({
        session_id: sid, workspace: { project_dir: dir },
        model: { display_name: 'Claude Opus' },
        context_window: { used_percentage: 61.2, remaining_percentage: 38.8, context_window_size: 200000 },
      });
      assert.equal(r.code, 0);
      assert.doesNotMatch(r.stdout, /^\s*[{[]/, 'statusLine stdout must be plain text, never JSON');
      assert.match(r.stdout, /61% used/);

      const teePath = path.join(dir, '.respawnpack', 'runtime', `context-usage-${sid}.json`);
      const teed = JSON.parse(fs.readFileSync(teePath, 'utf8'));
      assert.equal(teed.used_percentage, 61.2);
      assert.equal(teed.remaining_percentage, 38.8);
      assert.equal(teed.context_window_size, 200000);
      assert.ok(teed.at, 'the tee must carry a timestamp — that is what makes it freshness-checkable');
      assert.ok(Date.now() - Date.parse(teed.at) < FRESH_WINDOW_MS, 'a tee written just now must read as fresh');
    } finally { rm(dir); }
  });

  test('no usage this call → prints a line but tees NOTHING (no stale-looking file with a fresh timestamp and no data)', () => {
    const dir = tmpProject();
    try {
      const sid = 'sess-tee-2';
      const r = run({ session_id: sid, workspace: { project_dir: dir }, model: { display_name: 'Claude' }, current_usage: null });
      assert.equal(r.code, 0);
      assert.match(r.stdout, /unavailable/);
      const teePath = path.join(dir, '.respawnpack', 'runtime', `context-usage-${sid}.json`);
      assert.equal(fs.existsSync(teePath), false, 'teeing a file for a call with no real measurement would misrepresent it as a HIGH-confidence reading');
    } finally { rm(dir); }
  });

  test('malformed and empty stdin never crash it — always exit 0, always some line', () => {
    for (const bad of ['', '{', 'not json at all', '[]']) {
      const r = run(bad);
      assert.equal(r.code, 0, `stdin ${JSON.stringify(bad)} produced exit ${r.code}`);
      assert.ok(r.stdout.length > 0, 'a broken statusline command shows as blank in the UI — this must always print something');
    }
  });

  test('an unwritable/relative-nonsense project dir degrades to printing the line without teeing, never a crash', () => {
    const r = run({
      session_id: 's', workspace: { project_dir: '\0invalid\0path' }, model: { display_name: 'Claude' },
      context_window: { used_percentage: 10 },
    });
    assert.equal(r.code, 0);
    assert.ok(r.stdout.length > 0);
  });
});
