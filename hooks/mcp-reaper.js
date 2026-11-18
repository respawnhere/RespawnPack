#!/usr/bin/env node
/**
 * mcp-reaper — stops Docker-MCP-gateway containers when they're no longer needed.
 *
 * Why: container-backed MCP servers boot on every client HANDSHAKE (the protocol
 * must run them just to list their tools), not on use — so enabled servers
 * accumulate as idle containers, some holding docker.sock by design (the sandbox
 * orchestrators). The gateway reaps lazily and only on clean disconnects; a
 * crashed session's containers linger. RespawnPack-original. It acts on exactly two
 * label families and nothing else: the gateway's own `docker-mcp=true` containers, and
 * the `respawnpack.session=<id>` containers the docker-session-tag hook stamps on
 * AI-started `docker run`s (that hook documents the labeling convention).
 *
 * Two firing points (one file, branch on hook_event_name), each sweeping BOTH label families:
 *   SessionEnd   → GATEWAY: stop ALL docker-mcp containers (a concurrent session's next handshake
 *                  transparently respawns what it needs — stateless by design).
 *                  SESSION: stop THIS session's `respawnpack.session=<id>` containers, then `docker rm`
 *                  ONLY those additionally labeled `respawnpack.class=temp` (infra is stopped, never removed).
 *   SessionStart → GATEWAY: stop only STALE docker-mcp containers (default >2h — crash orphans).
 *                  SESSION: stop STALE `respawnpack.session`-labeled orphans, rm only the class=temp ones;
 *                  a fresh sibling session's containers are younger than the cutoff → left alone.
 * `respawnpack.keep=true` containers are never stopped nor removed by ANY path (checked before acting).
 *
 * The hook itself exits instantly: it re-spawns this same file detached with
 * `--reap <mode>` (the stop-savepoint toast pattern) so docker's shutdown grace
 * never eats the hook timeout. Everything is fail-silent: no docker, no
 * containers, any error → exit 0, never a word into the session.
 *
 * Opt-out: `.respawnpack/mcp-reaper.off` in the project dir.
 * Tuning:  RESPAWNPACK_MCP_REAPER_STALE_HOURS (default 2) for the start-time sweep.
 *
 * POSTURE (ADR-003 / P3-T-10c): the whole hook is rule id `mcp-reaper`, `off` under light and active
 * (today's behaviour, unchanged) under standard/strict, and under a config that is absent, invalid or
 * unreadable (all three resolve to strict). It is switchable, unlike docker-session-tag's label, because
 * the SessionEnd gateway sweep above stops ALL docker-mcp=true containers, including a concurrent
 * session's — a cross-session side effect a profile should be able to decline. Resolved once per
 * invocation, beside the `.off` marker check, before the child is ever spawned.
 */
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
/*
 * Booted through _boot.js like every other hook with a shared dependency, and armed ADVISORY: the
 * reaper is a sweeper, not a guard. If the posture reader will not load it says so on stderr and
 * sweeps nothing, which leaves containers running rather than stopping a concurrent session's on a
 * guess; strict's reap is the profile's choice, not a fallback.
 */
const boot = require('./_boot.js');
boot.arm('advisory');
const posture = boot.need('./_posture.js');

const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const OFF_MARKER = path.join(projectDir, '.respawnpack', 'mcp-reaper.off');
const LABEL = 'docker-mcp=true'; // the gateway stamps every container it manages; nothing else matches

// ---- child mode: the actual reap, detached from the hook lifecycle ----------
if (process.argv[2] === '--reap') {
  const mode = process.argv[3] === 'all' ? 'all' : 'stale';
  const sessionId = process.argv[4] || ''; // THIS session's id (for the SessionEnd session-scoped sweep)
  try {
    const docker = (args) => execFileSync('docker', args, { encoding: 'utf8', windowsHide: true, timeout: 20000 });
    const staleHours = Number(process.env.RESPAWNPACK_MCP_REAPER_STALE_HOURS) || 2;
    const cutoff = Date.now() - staleHours * 3600 * 1000;
    const isStale = (id) => {
      try {
        const started = Date.parse(docker(['inspect', '--format', '{{.State.StartedAt}}', id]).trim());
        return Number.isFinite(started) && started < cutoff;
      } catch { return false; } // unreadable container: leave it alone
    };

    // Read a container's labels, or null when they cannot be read. Declared before BOTH sweeps: it is a
    // `const` arrow, so Path 1 calling it while it sat below Path 2 would throw on the temporal dead zone.
    const labelsOf = (id) => {
      try {
        const o = JSON.parse(docker(['inspect', '--format', '{{json .Config.Labels}}', id]).trim());
        return o && typeof o === 'object' ? o : {};
      } catch { return null; } // unreadable → signal "leave alone"
    };

    // --- Path 1: gateway docker-mcp=true containers (SessionEnd all-stop, SessionStart stale-stop). Its own
    //     try/catch so an empty/failed gateway sweep never short-circuits the session sweep below. ---
    //
    // ⛔ "NEVER BY ANY PATH" MEANS THIS PATH TOO. The keep label was read at exactly one place — inside
    // reapSession below — while this sweep read no labels at all. A container carrying BOTH
    // `docker-mcp=true` and `respawnpack.keep=true` was stopped here at SessionEnd, which makes the
    // header's "(checked before acting)" a claim about intent rather than about mechanism. The filter is
    // applied in JS with the same labelsOf() reader Path 2 uses, not via `--filter label!=`, so the
    // guarantee does not depend on a docker version's filter support; an unreadable container is left
    // alone for the same reason it is below.
    try {
      const ids = docker(['ps', '-q', '--filter', `label=${LABEL}`]).split(/\s+/).filter(Boolean);
      if (ids.length) {
        const keepable = ids.filter((id) => { const l = labelsOf(id); return l && String(l['respawnpack.keep']) !== 'true'; });
        const targets = mode === 'all' ? keepable : keepable.filter(isStale);
        if (targets.length) docker(['stop', '-t', '2', ...targets]);
      }
    } catch { /* gateway sweep failed — independent of the session sweep */ }

    // --- Path 2: respawnpack.session=<id> containers. Stop non-keep; `docker rm` ONLY class=temp. Read each
    //     candidate's labels so infra is stopped-not-removed and keep=true is never touched. ---
    const reapSession = (ids) => {
      const toStop = [], toRm = [];
      for (const id of ids) {
        const l = labelsOf(id);
        if (!l) continue;                                        // unreadable → don't risk it
        if (String(l['respawnpack.keep']) === 'true') continue;  // keep=true → never stopped nor removed
        toStop.push(id);
        if (String(l['respawnpack.class']) === 'temp') toRm.push(id); // temp → also removed (after stop)
      }
      if (toStop.length) { try { docker(['stop', '-t', '5', ...toStop]); } catch { /* ignore */ } }
      if (toRm.length) { try { docker(['rm', ...toRm]); } catch { /* ignore */ } }
    };
    try {
      if (mode === 'all') {
        // SessionEnd: only THIS session's containers (a live sibling's carry a different id → untouched).
        if (sessionId) {
          const mine = docker(['ps', '-aq', '--filter', `label=respawnpack.session=${sessionId}`]).split(/\s+/).filter(Boolean);
          reapSession(mine);
        }
      } else {
        // SessionStart: any respawnpack.session-labeled container older than the stale cutoff (crash orphans);
        // a fresh sibling session's containers are younger than the cutoff → left alone.
        const anySession = docker(['ps', '-aq', '--filter', 'label=respawnpack.session']).split(/\s+/).filter(Boolean);
        reapSession(anySession.filter(isStale));
      }
    } catch { /* session sweep failed — silent */ }
  } catch { /* no docker on PATH, daemon down, races — all fine, all silent */ }
  process.exit(0);
}

// ---- hook mode: read the event, decide, hand off, exit ----------------------
let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  try {
    if (fs.existsSync(OFF_MARKER)) process.exit(0);
    // `mcp-reaper` (ADR-003): off under light, deny (active) under standard/strict — see the header.
    // Anything other than `off` proceeds exactly as today; the table only ever carries off/deny for
    // this id, but a mis-wired consult must tighten (reap), never loosen (leave a container unreaped).
    const resolved = posture.resolve(projectDir);
    if (posture.verdict(resolved, 'mcp-reaper') === 'off') process.exit(0);
    let evt = {};
    try { evt = JSON.parse(input); } catch { /* malformed stdin: still safe to sweep stale */ }
    // SessionEnd sweeps everything; any other wiring (SessionStart) only takes orphans.
    const mode = evt.hook_event_name === 'SessionEnd' ? 'all' : 'stale';
    // Pass THIS session's id so the child can target respawnpack.session=<id> on SessionEnd (may be '').
    const sessionId = String(evt.session_id || '');
    const child = spawn(process.execPath, [__filename, '--reap', mode, sessionId], {
      detached: true, stdio: 'ignore', windowsHide: true,
      env: process.env, cwd: projectDir,
    });
    child.unref();
  } catch { /* never block a session over cleanup */ }
  process.exit(0);
});
