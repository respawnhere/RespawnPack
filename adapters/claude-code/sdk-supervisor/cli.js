/*
 * RespawnPack · adapters/claude-code/sdk-supervisor/cli.js — the process surface: which binary, which
 * flags, and how one headless turn is run and captured.
 *
 * ⭐ WHY THE CLI AND NOT THE npm SDK. Recorded here because it is a decision, not a preference:
 *
 *   1. THE PACK HAS NO DEPENDENCIES AND INSTALLS BY COPYING FILES. There is no root package.json by
 *      design; a supervisor that required `@anthropic-ai/claude-agent-sdk` would need a node_modules
 *      tree on every target, which is not something a file-copy installer can honestly promise.
 *   2. THE SDK DRIVES THIS EXACT PROTOCOL. Its transport is `claude --print --output-format stream-json
 *      --verbose` over a pipe. The fixtures under fixtures/captured/ were recorded THROUGH the SDK and
 *      are byte-for-byte the CLI's own stream — there is no second protocol to learn.
 *   3. THE SDK SHIPS ITS OWN BINARY, AND IN THIS ENVIRONMENT IT IS A DIFFERENT CREDENTIAL CONTEXT.
 *      Measured: the SDK spawned its bundled claude 2.1.223 ("OAuth session expired and could not be
 *      refreshed") while the PATH claude is 2.1.205 — the one the operator authenticated. Depending on
 *      the SDK would mean depending on whichever binary it bundles this week.
 *   4. `pathToClaudeCodeExecutable` HAS AN EXACT EQUIVALENT HERE: `claudePath` / the
 *      RESPAWNPACK_CLAUDE_PATH environment variable, which is the same override applied one layer down.
 *
 * ⛔ THE PROMPT TRAVELS ON STDIN, NOT IN argv. A rollover prompt carries an injected handoff, and a
 * Windows command line dies at ~32767 characters — silently truncating the one message whose whole job
 * is to be complete. `--input-format text` (the default) reads the prompt from stdin, so the length
 * limit is the pipe's, and no shell quoting ever touches the text.
 *
 * ⛔ AND A TIMEOUT IS NOT AN OUTCOME. When the deadline passes the child is killed and the turn is
 * returned with `timedOut:true` and whatever lines had arrived. It is never converted into a verdict;
 * stream.js will report UNOBSERVED because no signal arrived, which is the true statement.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;   // a real turn can be long; the deadline exists to bound a HANG
const PROBE_TIMEOUT_MS = 60 * 1000;

/**
 * Find the claude executable WITHOUT a shell.
 *
 * Order: explicit option → RESPAWNPACK_CLAUDE_PATH → PATH scan. On Windows the scan honours PATHEXT and
 * PREFERS .exe/.com: a .cmd or .bat cannot be spawned directly by modern Node, and reaching for a shell
 * to run one re-introduces the quoting problem this module avoids everywhere else.
 *
 * @returns {{ok:true, path, source, needsShell:boolean, note:string|null}|{ok:false, why, searched}}
 */
function resolveExecutable({ claudePath = null, env = process.env, platform = process.platform } = {}) {
  const explicit = claudePath || env.RESPAWNPACK_CLAUDE_PATH || null;
  if (explicit) {
    if (!fs.existsSync(explicit)) {
      return { ok: false, why: `the configured claude executable does not exist: ${explicit}`, searched: [explicit] };
    }
    return { ok: true, path: explicit, source: claudePath ? 'option' : 'RESPAWNPACK_CLAUDE_PATH', ...shellNeed(explicit, platform) };
  }

  const isWin = platform === 'win32';
  const exts = isWin
    ? String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];
  // .exe/.com first, then everything else — the preference is what keeps `shell:true` off the hot path.
  const ordered = isWin
    ? [...exts.filter((e) => /^\.(exe|com)$/i.test(e)), ...exts.filter((e) => !/^\.(exe|com)$/i.test(e))]
    : exts;

  const dirs = String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
  const searched = [];
  for (const dir of dirs) {
    for (const ext of ordered) {
      const candidate = path.join(dir, `claude${ext}`);
      searched.push(candidate);
      try {
        if (fs.statSync(candidate).isFile()) {
          return { ok: true, path: candidate, source: 'PATH', ...shellNeed(candidate, platform) };
        }
      } catch { /* not there; that is what a PATH scan is */ }
    }
  }
  return {
    ok: false,
    why: 'no `claude` executable was found on PATH. Set RESPAWNPACK_CLAUDE_PATH, or pass claudePath.',
    searched: searched.slice(0, 40),
  };
}

function shellNeed(file, platform) {
  const needsShell = platform === 'win32' && /\.(cmd|bat)$/i.test(file);
  return {
    needsShell,
    note: needsShell
      ? 'this is a .cmd/.bat shim, which Node cannot spawn directly — a shell is used for it, and arguments are quoted here rather than by the shell'
      : null,
  };
}

/**
 * Verify a `cwd` override names an existing directory BEFORE it is handed to spawn().
 *
 * ⭐ WHY THIS EXISTS (P1-CT-5). On Windows, spawning with a `cwd` that does not exist fails with
 * libuv errno -4058 (ENOENT) — the SAME code a genuinely missing executable produces. Left
 * unchecked, `runVersion` reported `claude --version exited -4058` and `runTurn` reported an ENOENT
 * `spawnError` naming the executable path — both blaming the binary, which is actively misleading:
 * the identical invocation against an existing `cwd` succeeds cleanly. Checking here, before any
 * process is spawned, keeps the two failures distinguishable.
 *
 * `cwd === undefined`/`null` (no override) is NOT checked — spawn() then falls back to
 * `process.cwd()`, which always exists.
 *
 * @returns {{ok:true}|{ok:false, why:string}}
 */
function checkCwd(cwd) {
  if (cwd === undefined || cwd === null) return { ok: true };
  let stat;
  try {
    stat = fs.statSync(cwd);
  } catch {
    return { ok: false, why: `the project directory does not exist: ${cwd}` };
  }
  if (!stat.isDirectory()) {
    return { ok: false, why: `the project directory is not a directory: ${cwd}` };
  }
  return { ok: true };
}

/**
 * The exact argv for one headless turn. PURE, and exported so a test can assert the invocation rather
 * than trusting a comment about it.
 *
 * `--verbose` is not decoration: without it the stream-json output is summarised and the control-flow
 * messages this supervisor depends on (status, compact_boundary) are what get summarised away.
 */
function buildTurnArgs({
  sessionId = null,
  prompt = null,
  promptVia = 'stdin',
  model = null,
  tools = null,            // string|null — "" disables all tools, "default" restores them
  allowedTools = null,     // string[]|null
  permissionMode = null,
  extraArgs = [],
} = {}) {
  const args = ['--print', '--output-format', 'stream-json', '--verbose'];
  if (sessionId) args.push('--resume', sessionId);
  if (model) args.push('--model', model);
  if (tools !== null && tools !== undefined) args.push('--tools', String(tools));
  if (Array.isArray(allowedTools) && allowedTools.length) args.push('--allowedTools', allowedTools.join(','));
  if (permissionMode) args.push('--permission-mode', permissionMode);
  for (const a of extraArgs) args.push(String(a));
  if (promptVia === 'argv' && typeof prompt === 'string') args.push(prompt);
  return args;
}

/** Windows shell quoting for the .cmd shim case. Only reached when needsShell is true. */
const quote = (a) => `"${String(a).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;

/**
 * Run one turn and capture it.
 *
 * @returns {Promise<{ok, code, signal, timedOut, spawnError, stdoutLines, stdout, stderr, argv, exePath,
 *                    startedAt, endedAt, durationMs}>}
 *
 * `stdoutLines` are the protocol lines VERBATIM — only the line terminator is removed. Everything the
 * evidence records carry comes from these strings, unmodified.
 */
function runTurn(opts = {}) {
  const {
    cwd,
    claudePath = null,
    env = process.env,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    prompt = '',
    promptVia = 'stdin',
    onLine = null,
  } = opts;

  const exe = resolveExecutable({ claudePath, env });
  if (!exe.ok) {
    return Promise.resolve({
      ok: false, code: null, signal: null, timedOut: false,
      spawnError: exe.why, stdoutLines: [], stdout: '', stderr: '', argv: [], exePath: null,
      startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), durationMs: 0,
      searched: exe.searched,
    });
  }

  const cwdCheck = checkCwd(cwd);
  if (!cwdCheck.ok) {
    return Promise.resolve({
      ok: false, code: null, signal: null, timedOut: false,
      spawnError: cwdCheck.why, stdoutLines: [], stdout: '', stderr: '',
      argv: [exe.path], exePath: exe.path, exeSource: exe.source, exeNote: exe.note,
      startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), durationMs: 0,
    });
  }

  const args = buildTurnArgs({ ...opts, promptVia });
  const startedAt = new Date().toISOString();
  const t0 = Date.now();

  return new Promise((resolve) => {
    let child;
    const spawnOpts = { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] };
    try {
      child = exe.needsShell
        ? spawn(`${quote(exe.path)} ${args.map(quote).join(' ')}`, { ...spawnOpts, shell: true })
        : spawn(exe.path, args, spawnOpts);
    } catch (e) {
      resolve({
        ok: false, code: null, signal: null, timedOut: false,
        spawnError: `${(e && e.code) || 'UNKNOWN'}: ${e && e.message}`,
        stdoutLines: [], stdout: '', stderr: '', argv: [exe.path, ...args], exePath: exe.path,
        startedAt, endedAt: new Date().toISOString(), durationMs: Date.now() - t0,
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    let pending = '';
    const stdoutLines = [];
    let timedOut = false;
    let spawnError = null;

    const timer = timeoutMs > 0 ? setTimeout(() => {
      timedOut = true;
      try { child.kill(); } catch { /* already gone */ }
    }, timeoutMs) : null;

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      pending += chunk;
      let nl = pending.indexOf('\n');
      while (nl >= 0) {
        const line = pending.slice(0, nl).replace(/\r$/, '');
        pending = pending.slice(nl + 1);
        if (line.length) {
          stdoutLines.push(line);
          if (onLine) { try { onLine(line); } catch { /* a reporter must not break the turn */ } }
        }
        nl = pending.indexOf('\n');
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });

    child.on('error', (e) => { spawnError = `${(e && e.code) || 'UNKNOWN'}: ${e && e.message}`; });

    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      // A last line with no trailing newline is still a line the host wrote.
      const tail = pending.replace(/\r$/, '');
      if (tail.length) stdoutLines.push(tail);
      resolve({
        ok: !spawnError && !timedOut && code === 0,
        code, signal, timedOut, spawnError,
        stdoutLines, stdout, stderr,
        argv: [exe.path, ...args], exePath: exe.path, exeSource: exe.source, exeNote: exe.note,
        startedAt, endedAt: new Date().toISOString(), durationMs: Date.now() - t0,
      });
    });

    if (promptVia === 'stdin') {
      try { child.stdin.end(typeof prompt === 'string' ? prompt : ''); }
      catch (e) { spawnError = `stdin: ${e && e.message}`; }
    } else {
      // Even in argv mode stdin is CLOSED. Left open, `claude --print` waits on it forever.
      try { child.stdin.end(); } catch { /* the child may already have exited */ }
    }
  });
}

/** `claude --version` — no session, no model call, no cost. */
function runVersion({ claudePath = null, env = process.env, cwd = undefined, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const exe = resolveExecutable({ claudePath, env });
  if (!exe.ok) return Promise.resolve({ ok: false, version: null, stdout: '', stderr: '', why: exe.why, searched: exe.searched, exePath: null });

  const cwdCheck = checkCwd(cwd);
  if (!cwdCheck.ok) {
    return Promise.resolve({
      ok: false, version: null, stdout: '', stderr: '', why: cwdCheck.why,
      exePath: exe.path, exeSource: exe.source, exeNote: exe.note,
    });
  }

  return new Promise((resolve) => {
    let child;
    try {
      child = exe.needsShell
        ? spawn(`${quote(exe.path)} --version`, { cwd, env, windowsHide: true, shell: true })
        : spawn(exe.path, ['--version'], { cwd, env, windowsHide: true });
    } catch (e) {
      resolve({ ok: false, version: null, stdout: '', stderr: '', why: `${(e && e.code) || 'UNKNOWN'}: ${e && e.message}`, exePath: exe.path });
      return;
    }
    let stdout = ''; let stderr = ''; let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { child.kill(); } catch { /* gone */ } }, timeoutMs);
    child.stdout.setEncoding('utf8'); child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.setEncoding('utf8'); child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', (e) => { stderr += `\n${e && e.message}`; });
    child.on('close', (code) => {
      clearTimeout(timer);
      const m = stdout.match(/(\d+\.\d+\.\d+)/);
      resolve({
        ok: code === 0 && !timedOut && Boolean(m),
        version: m ? m[1] : null,
        versionLine: stdout.trim() || null,
        stdout, stderr, code, timedOut,
        exePath: exe.path, exeSource: exe.source, exeNote: exe.note,
        why: code === 0 ? null : `claude --version exited ${code}${timedOut ? ' (killed at the deadline)' : ''}`,
      });
    });
  });
}

/** The real process surface. Tests pass an object of the same shape backed by fixtures. */
const realCli = { runTurn, runVersion, resolveExecutable, buildTurnArgs, kind: 'spawn' };

module.exports = {
  DEFAULT_TIMEOUT_MS, PROBE_TIMEOUT_MS,
  resolveExecutable, buildTurnArgs, runTurn, runVersion, checkCwd, realCli,
};
