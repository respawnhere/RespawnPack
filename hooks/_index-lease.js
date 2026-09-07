/*
 * RespawnPack · hooks/_index-lease.js — an EXCLUSIVE writer lease on a git index, plus the semantic
 * staged state the guard protects.
 *
 * NOT A HOOK (leading underscore — the counts fence excludes these).
 *
 * ⛔ WHAT THIS FILE GOT WRONG THE FIRST TIME, and why the correction matters more than the feature.
 * The first cut called itself a lease and was not one:
 *   • `evaluate()` returned allowed:true for ANY main session, even while a different, non-stale main
 *     session held the record — so two sessions in one checkout could both stage and commit;
 *   • a "granted" subagent overwrote whatever holder existed, without looking at it;
 *   • acquisition was read-then-write with nothing atomic between, so even the check it did perform
 *     could be lost to a concurrent writer.
 * A lease that never refuses anyone is a log entry with ambitions. This is now a real one: exactly one
 * non-stale principal per index identity, acquired under an exclusive lock, refreshed by the same
 * principal and refused to any other.
 *
 * ⛔ AND IT IS TAKEN ONLY TO MUTATE. Acquiring on an edit or a read would put ordinary solo work behind
 * a lock for no benefit; the lease exists to arbitrate INDEX MUTATION and is requested at that moment.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
// The one retrying/classifying artifact boundary. The ownership ledger and the lease record are both
// replaced by rename, and a reader can observe either mid-replacement — see readOwnedClassified.
const artifact = require('./_artifact.js');

const LEASE_TTL_MS = Number(process.env.RESPAWNPACK_INDEX_LEASE_TTL_MS) || 15 * 60 * 1000;
const HEARTBEAT_STALE_MS = Number(process.env.RESPAWNPACK_INDEX_LEASE_STALE_MS) || 5 * 60 * 1000;

const sha = (t) => crypto.createHash('sha256').update(t).digest('hex').slice(0, 16);

// ⛔ maxBuffer is load-bearing (see secret-scan.js for the full account). stagedStates reads one raw row
// per staged path through this runner; at Node's 1 MiB default an index of ~10k staged files overflowed
// with ENOBUFS, came back CANNOT_DETERMINE, and index-guard — correctly refusing to call an unreadable
// index clean — denied every mutation of it. Bounded rather than Infinity so a hostile index exhausts the
// buffer, not the heap.
const GIT_MAX_BUFFER = 256 * 1024 * 1024;
function git(dir, args, env) {
  return execFileSync('git', args, {
    cwd: dir, encoding: 'utf8', maxBuffer: GIT_MAX_BUFFER, stdio: ['ignore', 'pipe', 'ignore'],
    env: env ? { ...process.env, ...env } : process.env,
  });
}

/**
 * The canonical absolute path of the index a git command run in `dir` would mutate. This is the lease
 * key: linked worktrees get their own index by construction, so isolated writers never collide.
 *
 * ⭐ MEMOISED PER PROCESS (audit BUG-5 / task T-02). Measured on a one-file fixture: one PreToolUse
 * invocation for `git commit -m wip` asked this question 5 times — index-guard.js calls it directly for
 * `projectDir`, `workDir` and the mutating command's own `dir`, and `foreignStates` below calls it again
 * from each of its own two call sites — and a Bash command with no git in it still asked it twice. Every
 * call is a real ~25 ms `git rev-parse` subprocess on Windows, and within one hook invocation every one of
 * them is the same question about the same directory: nothing this process does can move a repository's
 * index to a different path mid-call, so the answer is a pure function of the resolved directory for the
 * life of the process. Cleared never — a hook invocation is one short-lived process that exits once the
 * event is answered, so no lifetime is long enough for a stale entry to matter, and a fresh invocation
 * starts with an empty cache, never inheriting another call's answer. Keyed on the resolved, lowercased
 * directory plus `env` (paths are case-insensitive on the filesystems this runs on, and no caller passes
 * `env` today, but a future one that passed two different overrides for one directory must not collide).
 */
const indexIdentityCache = new Map();

function indexIdentity(dir, env) {
  const key = `${path.resolve(String(dir))} ${env ? JSON.stringify(env) : ''}`.toLowerCase();
  if (indexIdentityCache.has(key)) return indexIdentityCache.get(key);
  const identity = resolveIndexIdentity(dir, env);
  indexIdentityCache.set(key, identity);
  return identity;
}

function resolveIndexIdentity(dir, env) {
  try {
    const abs = git(dir, ['rev-parse', '--path-format=absolute', '--git-path', 'index'], env).trim();
    if (abs) return path.resolve(abs).replace(/\\/g, '/').toLowerCase();
  } catch { /* older git, or not a repo — try the relative form */ }
  try {
    const rel = git(dir, ['rev-parse', '--git-path', 'index'], env).trim();
    if (!rel) return null;
    const top = git(dir, ['rev-parse', '--show-toplevel'], env).trim() || dir;
    return path.resolve(top, rel).replace(/\\/g, '/').toLowerCase();
  } catch { return null; }
}

/** Who is asking. `agentId` present ⇒ this call came from inside a subagent — a runtime fact, not a claim. */
function principal(input = {}) {
  const sessionId = String(input.session_id || 'unknown');
  const agentId = input.agent_id ? String(input.agent_id) : null;
  return {
    sessionId,
    agentId,
    agentType: input.agent_type ? String(input.agent_type) : null,
    isSubagent: Boolean(agentId),
    key: agentId ? `${sessionId}/${agentId}` : `${sessionId}/main`,
  };
}

// --- semantic staged state ------------------------------------------------------------------------

/*
 * ⛔ STAGED STATE MUST INCLUDE DELETIONS. `ls-files --stage` lists index ENTRIES, so a staged deletion
 * — which removes the entry — is simply invisible to it, and the first version of this guard therefore
 * could not protect a human who had staged `git rm`. `diff --cached --raw` reports the change itself,
 * tombstones included.
 *
 * -z because a path may contain a tab, and this is the one place a parsing shortcut would silently
 * drop exactly the entry someone cares about.
 */
/*
 * ⛔ AND IT RETURNS AN EXPLICIT VERDICT, NEVER A BARE LIST. The first version returned `null` on
 * failure and its one caller turned that into `[]`, which SPELLS "nothing foreign". An inability to
 * inspect the index is not proof that it is clean, and that collapse is how a corrupt or unreadable
 * index authorised every mutation it should have blocked. PASS carries states; CANNOT_DETERMINE
 * carries the reason, and callers must act on the difference.
 */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

function stagedStates(dir) {
  // Run from the top level so `diff.relative` cannot re-base the output: the paths below ARE the
  // canonical repository coordinates that pathspec normalisation and ownership are compared against.
  let from = dir;
  try { from = git(dir, ['rev-parse', '--show-toplevel']).trim() || dir; } catch { /* handled below */ }

  let out;
  try { out = git(from, ['diff', '--cached', '--raw', '-z', '--no-color']); }
  catch (first) {
    // An unborn branch has no HEAD to diff against; the empty tree is the correct comparison there.
    try { out = git(from, ['diff', '--cached', '--raw', '-z', '--no-color', EMPTY_TREE]); }
    catch (second) {
      return {
        status: 'CANNOT_DETERMINE',
        reason: `the staged state could not be read (git diff --cached exited ${second.status ?? first.status ?? 'abnormally'})`,
        states: [],
      };
    }
  }
  // ⛔ ESCAPED, never a literal control byte in source. An earlier revision of this file carried three
  // literal NULs inside a template literal: git treated the module as BINARY, grep skipped it, and the
  // Edit tooling could not match around it. A separator you cannot see is a separator you cannot review.
  const NUL = '\u0000';
  const parts = out.split(NUL);
  const states = [];
  for (let i = 0; i < parts.length; i++) {
    const meta = parts[i];
    if (!meta.startsWith(':')) continue;
    const m = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])(\d*)$/.exec(meta.trim());
    if (!m) continue;
    const status = m[5];
    const p = parts[++i];
    // Renames and copies carry a second path; consume it so it cannot be misread as the next record.
    const p2 = (status === 'R' || status === 'C') ? parts[++i] : null;
    const target = p2 || p;
    if (target === undefined) break;
    states.push({
      path: target, from: p2 ? p : null, status,
      srcMode: m[1], dstMode: m[2], srcOid: m[3], dstOid: m[4],
    });
  }
  return { status: 'PASS', reason: null, states };
}

/** The semantic identity of a staged change: what a commit would record, not how the index stores it. */
const stateKey = (s) => [s.status, s.dstMode, s.dstOid, s.path, s.from || ''].join('|');

// --- ownership ------------------------------------------------------------------------------------

const safeId = (id) => String(id || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
const ownedPath = (projectDir, sessionId) => path.join(projectDir, '.respawnpack', 'runtime', `index-owned-${safeId(sessionId)}.json`);

/**
 * The ownership ledger, CLASSIFIED.
 *
 * ⛔ THIS FILE IS REPLACED BY RENAME AND WAS READ THROUGH `catch { return {} }`, AND THE TWO CALLERS
 * TURN THAT INTO OPPOSITE FAILURES.
 *
 * `foreignStates` merely became pessimistic — everything looked foreign, the guard asked. Harmless.
 * `recordOwned` is a READ-MODIFY-WRITE: it reads this map, edits ONE index identity's bucket, and
 * writes the WHOLE map back through `writeOwned`. So `{}` from a momentarily-unavailable read did not
 * lose the answer, it DESTROYED the record — every other worktree's ownership erased by a rename
 * window. And the window is real here, not theoretical: index-guard keys this file on `sessionId`
 * alone, while subagents share their parent's session id and run as separate hook processes, so two
 * `recordOwned` calls contend for one file by construction.
 *
 * ABSENT is a legitimate answer and means exactly what it says — this session owns nothing yet.
 *
 * @returns {{status:'OK'|'UNREADABLE'|'MALFORMED', map:object|null, detail:string|null}}
 */
function readOwnedClassified(projectDir, sessionId) {
  const file = ownedPath(projectDir, sessionId);
  if (!artifact || typeof artifact.readJSONClassified !== 'function') {
    return { status: 'UNREADABLE', map: null, detail: 'the shared artifact boundary hooks/_artifact.js is unavailable' };
  }
  const r = artifact.readJSONClassified(file);
  if (r.status === 'ABSENT') return { status: 'OK', map: {}, detail: null };
  if (r.status !== 'OK') return { status: r.status, map: null, detail: r.detail || `the ownership ledger is ${r.status.toLowerCase()}` };
  if (!r.doc || typeof r.doc !== 'object' || Array.isArray(r.doc)) {
    return { status: 'MALFORMED', map: null, detail: 'the ownership ledger is not a JSON object' };
  }
  return { status: 'OK', map: r.doc, detail: null };
}

/** The old shape, for callers that treat an unreadable ledger as "owns nothing" — which is SAFE only
 *  for the READ side. Anything that writes the map back must use `readOwnedClassified`. */
function readOwned(projectDir, sessionId) {
  const r = readOwnedClassified(projectDir, sessionId);
  return r.status === 'OK' ? r.map : {};
}

function writeOwned(projectDir, sessionId, map) {
  const file = ownedPath(projectDir, sessionId);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(map, null, 2));
    fs.renameSync(tmp, file);
    return true;
  } catch { return false; }
}

/**
 * Staged changes this session cannot account for.
 *
 * ⭐ Ownership is POSITIVE and semantic: a path is owned only while its current staged state matches
 * the one a confirmed agent operation produced. If a human restages that same path differently, the
 * key changes and it becomes foreign again — which is the property that makes this safe to re-check
 * before every mutation rather than trusting a snapshot taken at session start.
 */
/*
 * ⛔ OWNERSHIP IS KEYED BY INDEX IDENTITY, NOT BY PATH ALONE. The previous ledger was
 * {session → {path → key}}, and PostToolUse always recorded from the session's cwd. That let one
 * index's ownership be claimed from another:
 *     1. a human stages A.txt in the main checkout;
 *     2. the same session runs `git -C <linked-worktree> add -- A.txt`;
 *     3. PostToolUse read the MAIN checkout and recorded its human-staged A.txt as session-owned;
 *     4. a pathless commit in main was then allowed.
 * Identical path, mode and blob OID in two worktrees are still two different facts. The ledger is now
 * {session → {indexIdentity → {path → key}}} and every read and write resolves the target index first.
 */
const bucketOf = (map, identity) => {
  const k = sha(String(identity || 'unknown'));
  if (!map[k]) map[k] = {};
  return map[k];
};

function foreignStates(projectDir, sessionId, dir) {
  const staged = stagedStates(dir);
  if (staged.status !== 'PASS') return { status: staged.status, reason: staged.reason, states: [] };
  const identity = indexIdentity(dir);
  if (!identity) {
    return { status: 'CANNOT_DETERMINE', reason: 'the target index could not be identified, so ownership could not be looked up', states: [] };
  }
  // ⛔ An unreadable ledger is not an empty one. Treating it as empty would flag every staged entry as
  // foreign, which happens to deny — but it denies with the WRONG sentence, telling a human their index
  // contains changes this session cannot account for when the truth is that the ledger could not be
  // read. index-guard already fails closed on a non-PASS verdict, and now it says why.
  const ledger = readOwnedClassified(projectDir, sessionId);
  if (ledger.status !== 'OK') {
    return { status: 'CANNOT_DETERMINE', reason: `the ownership ledger could not be read (${ledger.status}: ${ledger.detail})`, states: [] };
  }
  const owned = bucketOf(ledger.map, identity);
  return { status: 'PASS', reason: null, states: staged.states.filter((s) => owned[s.path] !== stateKey(s)) };
}

/**
 * Record what an agent operation actually produced, verified after the fact, against the index it
 * actually targeted.
 *
 * ⛔ Refuses to claim anything when the target index cannot be resolved: an ownership claim made
 * against an unknown index is exactly the poisoning above with a different cause.
 */
function recordOwned(projectDir, sessionId, dir, paths) {
  const identity = indexIdentity(dir);
  if (!identity) return null;
  // ⛔ Declining on uncertainty is the SAFE direction here: unrecorded ownership makes a later command
  // treat the state as foreign, which costs a question. A claim made from an unreadable index would
  // instead hand the session authority over work it never observed.
  const staged = stagedStates(dir);
  if (staged.status !== 'PASS') return null;
  const states = staged.states;
  // ⛔ AND THE WRITE SIDE REFUSES OUTRIGHT. This function replaces the whole ledger; an unreadable read
  // here would publish a map missing every bucket it failed to see. Declining costs one unrecorded
  // ownership claim — the next command treats that state as foreign and asks — which is the same
  // conservative direction this function already takes for an unresolvable index.
  const ledger = readOwnedClassified(projectDir, sessionId);
  if (ledger.status !== 'OK') return null;
  const map = ledger.map;
  const owned = bucketOf(map, identity);
  const wanted = paths && paths.length ? new Set(paths.map((p) => p.replace(/\\/g, '/'))) : null;
  for (const s of states) {
    if (wanted && !wanted.has(s.path) && !(s.from && wanted.has(s.from))) continue;
    owned[s.path] = stateKey(s);
  }
  // A path no longer staged is no longer owned — otherwise a stale claim would let a later foreign
  // change to that same path pass unnoticed.
  const live = new Set(states.map((s) => s.path));
  for (const p of Object.keys(owned)) if (!live.has(p)) delete owned[p];
  writeOwned(projectDir, sessionId, map);
  return owned;
}

// --- the lease ------------------------------------------------------------------------------------

function leasePath(projectDir, identity) {
  return path.join(projectDir, '.respawnpack', 'runtime', `index-lease-${sha(identity || 'unknown')}.json`);
}

/**
 * Read the lease record. ⛔ Distinguishes ABSENT (null) from UNREADABLE ({error}) — the previous
 * version collapsed both to null, so a corrupt or permission-denied record read as "nobody holds this
 * index", which is the one conclusion it cannot support.
 *
 * ⭐ AND IT IS DELIBERATELY *NOT* ROUTED THROUGH THE RETRYING ARTIFACT BOUNDARY. That looks like the
 * same hole `readOwnedClassified` above just closed, and it is not — the difference is the lock, and
 * the exclusion is proven from the protocol rather than assumed:
 *
 *   every WRITER of this file is `acquire` (rename) and `confirm` (rename); its only deleter is
 *   `release` (unlink). All three run their whole read-decide-write inside `withLock(file, …)`, which
 *   is a `wx` compare-and-swap on `${file}.lock`. Every READ of it in the protocol — acquire's,
 *   confirm's, release's, and acquire's read-back — is inside that same lock.
 *
 * So no reader in the protocol can be concurrent with a replacement of what it is reading: there is no
 * rename window to misclassify, and inside the lock ENOENT means the record genuinely is not there.
 * Retrying here would add latency to the one path that already excludes the race by construction. The
 * OTHER direction is covered too: a non-ENOENT failure is already `{error}`, and every caller maps that
 * to CANNOT_DETERMINE and denies. If a writer is ever added OUTSIDE `withLock`, this reasoning expires
 * with it — and the fence in kernel/schema.test.mjs names this file so that cannot happen silently.
 */
function readLease(projectDir, identity) {
  try { return JSON.parse(fs.readFileSync(leasePath(projectDir, identity), 'utf8')); }
  catch (e) {
    if (e && e.code === 'ENOENT') return null;
    return { error: e.code || (e instanceof SyntaxError ? 'CORRUPT' : 'UNREADABLE') };
  }
}

/**
 * ⭐ ATOMIC ACQUISITION. `wx` is the portable compare-and-swap: the OS either creates the lock file or
 * fails, with no window between. Read-decide-write happens entirely inside it, so twelve simultaneous
 * sessions produce exactly one holder on Windows and POSIX alike — asserted by a fixture that runs
 * twelve real processes, because a race that only reproduces under contention is not proven by a
 * sequential test.
 */
const STALE_LOCK_MS = 5000;

/*
 * ⛔ WINDOWS SIGNALS CONTENTION AS EPERM, NOT ONLY AS EEXIST. A create attempt aimed at a file that
 * another process has just unlinked lands in the "delete pending" window and returns
 * ERROR_ACCESS_DENIED, which Node surfaces as EPERM. Treating anything but EEXIST as a fatal,
 * non-retryable failure therefore turned the most ordinary lock handoff there is — one holder
 * releasing exactly as the next one arrives — into "exclusivity cannot be established".
 *
 * The consequences were not cosmetic, and they were load-dependent enough to read as noise:
 *   • spawn-guard's 12-way concurrency fixture lost one to three increments per run, intermittently,
 *     which is precisely how it presented — a flaky test rather than a defect;
 *   • `acquire()` returned CANNOT_DETERMINE, so index-guard DENIED a perfectly legal staging
 *     operation at random under contention — a false refusal in the multi-writer case Scenario M
 *     exists to serve;
 *   • and with strict spawn mode now refusing on an unestablished count, it would have converted the
 *     same race into a spurious dispatch denial.
 *
 * Retrying does NOT weaken the guarantee: contention still fails closed once the deadline passes, and
 * a genuine permission fault simply fails closed a few seconds later with the same verdict. What
 * changes is only that a transient race is no longer mistaken for a permanent condition.
 */
const LOCK_CONTENTION_CODES = new Set(['EEXIST', 'EPERM', 'EACCES', 'EBUSY']);

/**
 * Run `fn` under an exclusive lock, or report that exclusivity could not be established.
 * Returns {locked:true, value} or {locked:false, why}. ⛔ It never runs `fn` unlocked.
 */
function withLock(file, fn) {
  const lock = `${file}.lock`;
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); }
  catch (e) { return { locked: false, why: `cannot create the runtime directory: ${e.code || e.message}` }; }

  const deadline = Date.now() + 4000;
  const pause = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3);
  let lastCode = 'EEXIST';
  for (;;) {
    let fd;
    try { fd = fs.openSync(lock, 'wx'); }
    catch (e) {
      // ⛔ FAIL CLOSED. The previous version ran the critical section UNLOCKED here — in exactly the
      // situation the lock exists for. If exclusivity cannot be established, say so and let the caller
      // deny; a guard that proceeds when its own guarantee is unavailable is not a guard.
      const code = (e && e.code) || 'UNKNOWN';
      if (!LOCK_CONTENTION_CODES.has(code)) return { locked: false, why: `cannot create the lock file: ${code === 'UNKNOWN' ? (e && e.message) : code}` };
      lastCode = code;
      // The lock vanished or is mid-delete between the failed create and the stat: pure contention.
      let age = null;
      try { age = Date.now() - fs.statSync(lock).mtimeMs; }
      catch {
        if (Date.now() > deadline) return { locked: false, why: `timed out contending for the lock file (last error ${lastCode}) — it may be permission-denied rather than held` };
        pause();
        continue;
      }
      if (age > STALE_LOCK_MS) { try { fs.unlinkSync(lock); } catch { /* raced */ } continue; }
      if (Date.now() > deadline) {
        // ⛔ Do NOT break a FRESH lock because this caller ran out of patience. That hands the index to
        // a second writer while the first is mid-operation — the corruption the lease exists to stop.
        return { locked: false, why: 'timed out waiting for the index lock while it was still fresh — another principal is active' };
      }
      pause();
      continue;
    }
    try { return { locked: true, value: fn() }; } finally {
      fs.closeSync(fd);
      try { fs.unlinkSync(lock); } catch { /* already gone */ }
    }
  }
}

/**
 * A lease is stale when its holder stopped heartbeating. Conservative on purpose: an agent killed
 * mid-wave never releases, so without expiry a crash would wedge the index for every later session —
 * but an aggressive expiry hands the index to a second writer while the first is still working, which
 * is the corruption the lease exists to prevent. Generous window, and a reclaim is always RECORDED.
 */
/*
 * ⛔ A LEASE TAKEN BY A CALL THAT NEVER RAN MUST NOT WEDGE THE INDEX FOR FIFTEEN MINUTES.
 *
 * index-guard releases everything it acquired when IT refuses — but it is not the last hook in the
 * chain. An adversarial gate ran `git add -- B.txt && rm -rf /`: index-guard allowed the staging and
 * took the lease, then shell-guard (ordered after it) denied the whole tool call, and the index stayed
 * held by a session that had mutated nothing. A second session was refused for the full TTL.
 *
 * A PreToolUse hook cannot know what a later hook will decide, so the lease is taken PROVISIONALLY and
 * CONFIRMED by PostToolUse — which only fires if the call actually ran. An unconfirmed lease older than
 * this window is reclaimable. It does not weaken exclusivity for a real writer: PostToolUse confirms
 * within milliseconds of the command, and a confirmed lease keeps the full TTL.
 */
const PROVISIONAL_MS = Number(process.env.RESPAWNPACK_INDEX_LEASE_PROVISIONAL_MS) || 90 * 1000;

function isStale(rec, now = Date.now()) {
  if (!rec) return true;
  const beat = Date.parse(rec.heartbeatAt || rec.acquiredAt || 0) || 0;
  const born = Date.parse(rec.acquiredAt || 0) || 0;
  if (rec.provisional && (now - born) > PROVISIONAL_MS) return true;
  return (now - beat) > HEARTBEAT_STALE_MS || (now - born) > LEASE_TTL_MS;
}

/** PostToolUse ran, so the call this lease was taken for actually executed. */
function confirm(projectDir, identity, who) {
  const file = leasePath(projectDir, identity);
  const outcome = withLock(file, () => {
    const rec = readLease(projectDir, identity);
    if (!rec || rec.error || rec.holderKey !== who.key || !rec.provisional) return false;
    try {
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ ...rec, provisional: false, confirmedAt: new Date().toISOString() }, null, 2));
      fs.renameSync(tmp, file);
      return true;
    } catch { return false; }
  });
  return outcome.locked ? outcome.value : false;
}

/**
 * Take or refresh the exclusive writer lease for one index identity.
 * Returns {ok, holder, reclaimedFrom?, reason}. `ok:false` means someone else holds it, and the caller
 * must refuse the mutation rather than proceed.
 */
function acquire(projectDir, identity, who) {
  const file = leasePath(projectDir, identity);
  const outcome = withLock(file, () => {
    const rec = readLease(projectDir, identity);

    // ⛔ Unreadable is NOT absent. A corrupt or permission-denied lease record could be anyone's; the
    // one thing it cannot be is proof that nobody holds this index.
    if (rec && rec.error) {
      return { ok: false, status: 'CANNOT_DETERMINE', holder: 'unknown', reason: `the lease record is unreadable (${rec.error}) — exclusivity cannot be verified` };
    }
    if (rec && rec.holderKey !== who.key && !isStale(rec)) {
      return { ok: false, status: 'HELD', holder: rec.holderKey, since: rec.acquiredAt, reason: 'another principal holds this index' };
    }

    const reclaimedFrom = rec && rec.holderKey !== who.key ? rec.holderKey : undefined;
    const alreadyHeld = Boolean(rec && rec.holderKey === who.key);
    const next = {
      holderKey: who.key, sessionId: who.sessionId, agentId: who.agentId, agentType: who.agentType,
      indexPath: identity,
      acquiredAt: alreadyHeld ? rec.acquiredAt : new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      // Provisional until PostToolUse confirms the call actually ran — see PROVISIONAL_MS.
      provisional: alreadyHeld ? Boolean(rec.provisional) : true,
      ...(reclaimedFrom ? { reclaimedFrom } : {}),
    };
    try {
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
      fs.renameSync(tmp, file);
    } catch (e) {
      // ⛔ The old code returned ok:true here — claiming ownership it had failed to record. An
      // unrecorded lease is invisible to every other principal, which is worse than no lease at all.
      return { ok: false, status: 'CANNOT_DETERMINE', holder: 'unknown', reason: `the lease could not be persisted (${e.code || e.message})` };
    }

    // Read back: a write that did not land is not an acquisition.
    const back = readLease(projectDir, identity);
    if (!back || back.error || back.holderKey !== who.key) {
      return { ok: false, status: 'CANNOT_DETERMINE', holder: 'unknown', reason: 'the lease did not read back as held by this principal' };
    }
    return { ok: true, status: 'ACQUIRED', holder: who.key, reclaimedFrom, alreadyHeld, reason: reclaimedFrom ? 'reclaimed a stale lease' : 'acquired' };
  });

  if (!outcome.locked) {
    return { ok: false, status: 'CANNOT_DETERMINE', holder: 'unknown', reason: outcome.why };
  }
  return outcome.value;
}

function release(projectDir, identity, who) {
  const file = leasePath(projectDir, identity);
  const outcome = withLock(file, () => {
    const rec = readLease(projectDir, identity);
    if (!rec || rec.error || rec.holderKey !== who.key) return false;
    try { fs.unlinkSync(file); return true; } catch { return false; }
  });
  return outcome.locked ? outcome.value : false;
}

/**
 * Release every lease this session holds, wherever its index lives.
 * SessionEnd arrives with one cwd, but a session may have staged into several worktrees; releasing
 * only the index under that cwd leaves the others wedged until they go stale.
 */
function releaseAll(projectDir, who) {
  const dir = path.join(projectDir, '.respawnpack', 'runtime');
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => /^index-lease-[0-9a-f]+\.json$/.test(n)); } catch { return 0; }
  let freed = 0;
  for (const n of names) {
    const file = path.join(dir, n);
    /*
     * This ONE read is outside the lock, and it is a filter, not a decision: nothing is deleted on its
     * word. `release` below re-reads the record UNDER the lock and refuses unless this principal still
     * holds it. So a transient failure here skips a release — the lease then expires on its own clock —
     * which is a missed cleanup in the conservative direction, never a lease handed to the wrong
     * principal and never a deletion of someone else's record.
     */
    let rec = null;
    try { rec = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
    if (!rec || rec.holderKey !== who.key) continue;
    if (release(projectDir, rec.indexPath, who)) freed++;
  }
  return freed;
}

module.exports = {
  indexIdentity, principal,
  stagedStates, stateKey, foreignStates, recordOwned, readOwned, readOwnedClassified, writeOwned, ownedPath,
  leasePath, readLease, isStale, acquire, confirm, release, releaseAll, withLock,
  PROVISIONAL_MS,
  LEASE_TTL_MS, HEARTBEAT_STALE_MS,
};
