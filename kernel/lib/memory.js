/*
 * RespawnPack · kernel/lib/memory.js — proving the memory engine is actually reachable.
 *
 * ⛔ OVERCLAIMS #4, AND WHY FILE PRESENCE IS NOT THE ANSWER. The README told people to run
 * `claude mcp add respawn-memory -- rmem mcp`, and `rmem` is the bin of a PRIVATE, unpublished package
 * that the installer never placed and never linked. The documented activation path could not resolve in
 * any target, and nothing noticed — because every check anyone had written asked whether files existed.
 * A directory of engine sources is not a running server, and "the engine's own tests pass" is a claim
 * about this repository, not about the machine someone installed onto.
 *
 * ⭐ SO THE PROBE IS THE REAL PROTOCOL. It spawns the recorded entry point exactly as an MCP client
 * would, speaks newline-delimited JSON-RPC over stdio, completes the `initialize` handshake, lists the
 * tools, then performs a WRITE and reads it back through `tools/call`. Three distinct things can fail
 * and they are reported as three distinct things: the process would not start, the handshake did not
 * complete, or the round trip did not return what was written.
 *
 * ⛔ AND IT NEVER WRITES INTO THE USER'S MEMORY. The engine resolves its store from the working
 * directory, so the probe runs in a disposable temporary root: it exercises the same entry point, the
 * same protocol and the same code path, and the only thing it can damage is a directory it created and
 * deletes. Proving a system works by writing junk into the thing it is supposed to protect would be a
 * strange way to earn trust.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { OUTCOME, result } = require('./outcome.js');

/** Where `install.js --with-memory` places the engine and records how to run it. */
const ENGINE_REL = path.join('.claude', 'respawnpack', 'memory', 'engine');
const ENTRY_REL = path.join(ENGINE_REL, 'src', 'cli.mjs');
const MCP_CONFIG_REL = '.mcp.json';
const SERVER_NAME = 'respawn-memory';
const PROBE_TIMEOUT_MS = Number(process.env.RESPAWNPACK_MEMORY_PROBE_TIMEOUT_MS) || 60000;

const readJSON = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };

/**
 * What this target records about its memory distribution.
 * Returns { mode: 'file' | 'engine', entry, node, registered, detail }.
 *
 * ⭐ `file` IS NOT A DEGRADED STATE. Markdown-and-grep memory is the zero-setup DEFAULT and works with
 * no npm, no MCP registration and no external service. The engine is one explicit opt-in on top of it.
 */
function distribution(dir) {
  const cfg = readJSON(path.join(dir, 'respawnpack.config.json')) || {};
  const rec = (cfg.memory && cfg.memory.engine) || null;
  const entryAbs = path.join(dir, ENTRY_REL);
  const present = fs.existsSync(entryAbs);
  const mcp = readJSON(path.join(dir, MCP_CONFIG_REL));
  const registered = Boolean(mcp && mcp.mcpServers && mcp.mcpServers[SERVER_NAME]);

  if (!present && !registered && !rec) {
    return { mode: 'file', entry: null, node: null, registered: false, detail: 'file-backed memory (memory/graph + grep) — the zero-setup default, no engine installed' };
  }
  return {
    mode: 'engine',
    entry: present ? entryAbs : null,
    // The absolute Node the installer resolved. Falling back to the CURRENT interpreter is honest for a
    // probe, but the recorded value is what an MCP client will actually use, so it is reported.
    node: (rec && rec.node) || null,
    registered,
    record: rec,
    detail: `engine distribution: entry ${present ? 'present' : 'MISSING'}, MCP registration ${registered ? 'present' : 'MISSING'}`,
  };
}

// --- the probe --------------------------------------------------------------------------------------

/**
 * One newline-delimited JSON-RPC conversation with a stdio MCP server.
 *
 * ⛔ SYNCHRONOUS, AND THEREFORE AT MOST ONE `tools/call` PER CONVERSATION. `doctor` is a synchronous
 * verb whose exit-code mapping every other check routes through, so the whole conversation is written
 * up front and the replies read from the closed stream.
 *
 * ⛔ THE ASSUMPTION THAT COST A ROUND OF THIS: an MCP server does NOT answer in the order it was asked.
 * The first cut wrote `remember` and `query` into one stream and read the replies back — and the reply
 * ids came back 1, 4, 5, 3. The SDK dispatches concurrently, so the query ran BEFORE the write landed
 * and returned an empty result that looked exactly like a broken engine. Two calls that depend on each
 * other therefore go in two PROCESSES, which makes the ordering a property of the operating system
 * rather than of a hopeful reading of someone's dispatch loop — and, as a bonus, turns the round trip
 * into a genuine persistence claim: what the first process wrote survived its exit.
 */
function speak(command, args, cwd, requests, timeoutMs) {
  const input = requests.map((r) => `${JSON.stringify(r.body)}\n`).join('');
  let r;
  try {
    r = spawnSync(command, args, {
      cwd, input, encoding: 'utf8', timeout: timeoutMs,
      env: { ...process.env, RESPAWN_MEMORY_QUERY_LOG: '0' },
    });
  } catch (e) {
    return { ok: false, stage: 'spawn', why: `could not start the engine (${e.code || e.message})`, responses: [], stderr: '' };
  }
  const stderr = String(r.stderr || '').slice(-2000);
  if (r.error) {
    return { ok: false, stage: 'spawn', why: `could not start the engine (${r.error.code || r.error.message})`, responses: [], stderr };
  }

  // Replies are matched to requests by JSON-RPC id, never by arrival order — a server is free to
  // interleave notifications, and positional matching would silently attribute one reply to another.
  const byId = new Map();
  for (const line of String(r.stdout || '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    let msg;
    try { msg = JSON.parse(t); } catch { continue; } // non-JSON chatter on stdout is not a reply
    if (msg.id === undefined) continue;              // a server-initiated notification
    byId.set(msg.id, msg);
  }
  const responses = requests.filter((q) => q.body.id !== undefined && byId.has(q.body.id))
    .map((q) => ({ stage: q.stage, msg: byId.get(q.body.id) }));

  const expected = requests.filter((q) => q.body.id !== undefined).length;
  return responses.length === expected
    ? { ok: true, stage: 'complete', responses, stderr }
    : { ok: false, stage: 'incomplete', why: `${responses.length} of ${expected} replies came back`, responses, stderr };
}

/**
 * Prove the recorded entry point answers a real MCP handshake AND a real write/retrieve round trip.
 * Returns an outcome-shaped result. Never writes into the project's own memory.
 */
function probe(dir, { timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const dist = distribution(dir);
  if (dist.mode !== 'engine') {
    return result(OUTCOME.NOT_APPLICABLE, 'memory:engine',
      'no engine installed — this project uses file-backed memory, which is the zero-setup default and needs no probe', { checked: 0 });
  }
  if (!dist.entry) {
    return result(OUTCOME.FAIL, 'memory:engine',
      `the memory distribution is recorded but ${ENTRY_REL} is missing — the MCP registration points at nothing. ` +
      'Re-run the installer with --with-memory.', { checked: 0 });
  }

  const node = dist.node && fs.existsSync(dist.node) ? dist.node : process.execPath;
  // ⛔ A DISPOSABLE MEMORY ROOT. The engine resolves its store from cwd, so the probe cannot touch what
  // the project has actually remembered.
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-memory-probe-'));
  const id = 'gotcha:respawnpack-doctor-probe';
  const marker = `probe-${process.pid}-${Math.abs(Date.now() % 1e9)}`;

  const HANDSHAKE = [
    {
      stage: 'initialize',
      body: {
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'respawnpack-doctor', version: '1.0.0' } },
      },
    },
    { stage: 'initialized', body: { jsonrpc: '2.0', method: 'notifications/initialized' } },
  ];
  const converse = (calls) => speak(node, [dist.entry, 'mcp'], sandbox, [...HANDSHAKE, ...calls], timeoutMs);
  const at = (conv, stage) => (conv.responses.find((r) => r.stage === stage) || {}).msg || null;

  try {
    // --- process one: handshake, tool inventory, and the WRITE -------------------------------------
    const first = converse([
      { stage: 'tools/list', body: { jsonrpc: '2.0', id: 2, method: 'tools/list' } },
      {
        stage: 'write',
        body: {
          jsonrpc: '2.0', id: 3, method: 'tools/call',
          params: { name: 'memory_remember', arguments: { id, body: `## Symptom\ndoctor round-trip probe ${marker}\n` } },
        },
      },
    ]);

    const init = at(first, 'initialize');
    if (!init) {
      return result(OUTCOME.FAIL, 'memory:handshake',
        `the engine did not complete an MCP handshake — ${first.why || 'no initialize reply'}. ` +
        (/Cannot find (package|module)/i.test(first.stderr || '')
          ? `Its dependencies are not installed: run \`npm install --omit=dev\` in ${ENGINE_REL}.`
          : `stderr: ${String(first.stderr || '').split(/\r?\n/).filter(Boolean).slice(-2).join(' | ') || '(none)'}`),
        { checked: 0 });
    }
    if (init.error || !init.result || !init.result.serverInfo) {
      return result(OUTCOME.FAIL, 'memory:handshake',
        `the engine answered, but not with a valid MCP initialize result: ${JSON.stringify(init.error || init.result).slice(0, 300)}`, { checked: 1 });
    }

    const tools = at(first, 'tools/list');
    const names = (tools && tools.result && Array.isArray(tools.result.tools) ? tools.result.tools : []).map((t) => t.name);
    for (const required of ['memory_remember', 'memory_query']) {
      if (!names.includes(required)) {
        return result(OUTCOME.FAIL, 'memory:handshake',
          `the server completed a handshake but does not expose ${required} — tools: ${names.join(', ') || '(none)'}`, { checked: names.length });
      }
    }

    const wrote = at(first, 'write');
    if (!wrote || wrote.error || (wrote.result && wrote.result.isError)) {
      return result(OUTCOME.FAIL, 'memory:round-trip',
        `the write half failed: ${JSON.stringify((wrote && (wrote.error || wrote.result)) || null).slice(0, 300)}`, { checked: 1 });
    }

    // --- process two: a SEPARATE server reads it back ----------------------------------------------
    const second = converse([
      { stage: 'retrieve', body: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'memory_query', arguments: { query: marker, k: 5 } } } },
    ]);
    const back = at(second, 'retrieve');
    const backText = JSON.stringify((back && back.result) || {});
    if (!back || back.error || !backText.includes(id)) {
      return result(OUTCOME.FAIL, 'memory:round-trip',
        `what a first server wrote did not come back from a second one: query returned ${backText.slice(0, 300)}`, { checked: 1 });
    }

    return result(OUTCOME.PASS, 'memory:round-trip',
      `real MCP handshake with ${init.result.serverInfo.name} ${init.result.serverInfo.version}, ${names.length} tool(s), ` +
      `and a write/retrieve round trip ACROSS TWO SERVER PROCESSES through ${path.relative(dir, dist.entry)} — so what was ` +
      "written genuinely persisted. Run against a disposable memory root, so this project's own memory was never touched",
      { checked: 2 });
  } finally {
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

/** Is `npm` reachable? Used to give an actionable answer instead of a stack trace. */
function npmAvailable() {
  const r = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['--version'], { stdio: 'ignore', shell: process.platform === 'win32' });
  return r.status === 0;
}

module.exports = {
  distribution, probe, npmAvailable, speak,
  ENGINE_REL, ENTRY_REL, MCP_CONFIG_REL, SERVER_NAME, PROBE_TIMEOUT_MS,
};
