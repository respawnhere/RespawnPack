/*
 * RespawnPack · hooks/_runtime.js — the EPHEMERAL session-state kernel shared by the governance hooks.
 *
 * NOT A HOOK. This is the library the hooks require; it is never wired to an event. (The counts fence
 * excludes leading-underscore files for exactly this reason — a shared module is not a governance hook.)
 *
 * WHY IT EXISTS: two dogfood runs failed in opposite directions on the same missing concept. The
 * first, field run A, was nagged five times to close out a session that wrote zero files, because the
 * Stop hook asked `git status --porcelain` — a TREE-state question — when the thing it actually wanted
 * to know was whether THIS SESSION changed anything. The second, field run B, lost its atomic task at compaction
 * because nothing persisted it. Both need the same thing: a cheap, durable-enough record of what the
 * session found when it started, so a later hook can subtract it.
 *
 * SCOPE DISCIPLINE (ADR-001, decision 2): everything here is EPHEMERAL and machine-local. It lives in
 * <project>/.respawnpack/runtime/, which the installer gitignores. Durable project truth belongs in
 * docs/derived/STATE.json and must never be written from here. Confusing the two is the bug field run B
 * kept paying for. That `<project>` is the ONE installed project root `projectRoot` resolves below (the
 * nearest ancestor carrying the pack's install markers, never the shell's cwd), so a cwd in a nested
 * repository or a subdirectory never grows its own runtime tree.
 *
 * FAILURE POSTURE: every function fails OPEN and returns a CANNOT_DETERMINE-shaped result rather than
 * throwing. A hook that cannot read state must go quiet, never crash a turn and never guess. Callers
 * that are load-bearing guards (push-guard, secret-scan) do their own fail-closed handling; the session
 * mechanics here are advisory by nature.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const manifest = require('./_manifest.js');
// The one production acceptance boundary — absent · transiently unavailable · unreadable · malformed ·
// unsupported version · structurally invalid, kept as six distinct answers. The state compiler
// requires this same module across the tree boundary, so the hooks and the kernel cannot develop
// different acceptance rules.
const artifact = require('./_artifact.js');

/*
 * ⛔ AND THE BOUNDARY ITSELF CAN BE BROKEN — A HOOK MUST REPORT THAT, NEVER DIE OF IT.
 *
 * `_artifact.js` can load perfectly while missing an export its readers call; that is the whole reason
 * it now carries a declared contract in modhealth. But a contract makes DOCTOR honest, and doctor is
 * not what runs at SessionStart. Reproduced at 6869874 with `loadRequirements` removed: the kernel died
 * on a TypeError; the same shape one export over would kill every hook on this module at its first
 * invocation, which on a PreToolUse guard means the guard is simply not there.
 *
 * So the three members this file reads are checked ONCE, literally — a `artifact[name]` loop would be a
 * computed access, invisible to the registry drift fence, and writing the repair in the one form the
 * fence cannot see would open a second hole inside the first.
 *
 * The degradation is toward the CONSERVATIVE answer in every case: no durable state, no baseline, no
 * stop record, and collaborate — the mode with the most ceremony, never the one with the most
 * authority. The reason travels with the answer so nothing reads as a fact about the project.
 */
function artifactUnavailable() {
  const bad = [];
  if (typeof artifact.readJSONClassified !== 'function') bad.push('readJSONClassified');
  if (typeof artifact.loadGoalDoc !== 'function') bad.push('loadGoalDoc');
  if (!(artifact.REJECTED instanceof Set)) bad.push('REJECTED');
  return bad.length
    ? `hooks/_artifact.js is present and loads but does not export ${bad.join(', ')} — run \`doctor\`, which reports hook-lib:_artifact.js as BROKEN`
    : null;
}

const RUNTIME_SUBDIR = path.join('.respawnpack', 'runtime');

/*
 * ⛔ ONE ON-DISK SPELLING, SO TWO FORMS OF THE SAME DIRECTORY NEVER READ AS TWO ROOTS. Windows hands the
 * same directory back under two spellings: an 8.3 short name (C:\Users\RUNNER~1\...) from one caller and
 * the long name (C:\Users\runneradmin\...) from git's own `--path-format=absolute`. A raw string compare
 * of a `path.resolve`'d cwd against a git-derived root then sees the SAME directory as two different roots
 * — which split the shared wave counter and, worse, made runtimeRefusal refuse a legitimate write at the
 * real repository root. Every root this module COMPARES goes through here first: realpathSync.native
 * expands the short name (and resolves links) to the single on-disk spelling, and a path that does not
 * exist yet falls back to path.resolve — fail-open, the posture of this whole file.
 */
function canonicalDir(p) {
  const resolved = path.resolve(p);
  try { return fs.realpathSync.native(resolved); } catch { return resolved; }
}

/*
 * ⛔ ONE STALENESS WINDOW FOR THE SPAWN COUNTER, SHARED BY ITS WRITER AND ITS READERS. spawn-guard
 * treats a counter older than this as zero — a parent killed mid-wave must never wedge a future
 * session — and index-guard had no such check, so a resumed session met a self-healed count of 0 and
 * an index-guard that still refused every broad staging operation, citing subagents that had exited an
 * hour earlier. One file read two ways is two counters wearing a disguise. It lives HERE rather than
 * being exported by spawn-guard because a hook that requires another hook inherits its stdin listener
 * and its process.exit — which is a far louder failure than the drift it was meant to fix.
 */
const SPAWN_STALE_MS = 30 * 60 * 1000;

// The pack's own scratch directory must never count as session work: the act of writing a baseline
// would otherwise register as a change and make every session look dirty to itself.
const SELF_PREFIX = '.respawnpack';

// The pack's own install markers on a target, in two accepted shapes — EITHER is a real install:
//   A. the founder config beside the kernel: `respawnpack.config.json` with `.claude/respawnpack/respawnpack.js`
//      on an installed target, or `kernel/respawnpack.js` in the pack's own dev checkout. `hooks/pre-push`
//      tests the INSTALLED pairing (config + `.claude/respawnpack/respawnpack.js`) before it runs the
//      kernel; the `kernel/` pairing is the dev checkout's equivalent, which pre-push does not test.
//   B. the host wiring beside the pack's own hooks: `.claude/settings.json` with `.claude/hooks/_runtime.js`.
//      An old-layout install that never wrote the config (the July/August strict installs the field leak
//      came from), or one whose owner deleted it, still carries this pair, so it is still recognised rather
//      than falling silently to the git answer. `.respawnpack/` is deliberately NOT a marker: it is
//      gitignored and runtime-created, so it is absent from a fresh clone AND from a worktree checkout.
const INSTALL_CONFIG = 'respawnpack.config.json';
const INSTALL_KERNELS = [path.join('.claude', 'respawnpack', 'respawnpack.js'), path.join('kernel', 'respawnpack.js')];
const INSTALL_SETTINGS = path.join('.claude', 'settings.json');
const INSTALL_HOOK = path.join('.claude', 'hooks', '_runtime.js');

// Does `dir` itself carry the install markers (either shape)? A few `existsSync` calls, no git — this is
// what tells an installed project apart from a nested repository or a plain subdirectory inside one.
function hasInstallMarkers(dir) {
  if (fs.existsSync(path.join(dir, INSTALL_CONFIG)) && INSTALL_KERNELS.some((rel) => fs.existsSync(path.join(dir, rel)))) return true;
  return fs.existsSync(path.join(dir, INSTALL_SETTINGS)) && fs.existsSync(path.join(dir, INSTALL_HOOK));
}

// The top of the git repository that contains `dir`, as a runtime anchor. For a linked worktree the
// COMMON git dir's parent is the main checkout (the axis Scenario M cares about) — but that parent is only
// a real checkout when the common dir is an actual `.git` DIRECTORY. A submodule's common dir is
// `<super>/.git/modules/<name>`, whose parent is INSIDE `.git` and not a working tree, so the common-dir
// parent is taken only when its basename is `.git`; otherwise, and for an older git, `--show-toplevel`
// gives the working tree's own top (the right answer for a submodule or a plain cwd). Null when not a repo.
function repoTopOf(dir) {
  try {
    const common = path.resolve(git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim());
    if (common && path.basename(common) === '.git') {
      const parent = path.dirname(common);
      if (parent && parent !== common) return parent;
    }
  } catch { /* older git, or not a repository */ }
  try {
    const top = git(dir, ['rev-parse', '--show-toplevel']).trim();
    if (top) return path.resolve(top);
  } catch { /* not a repository */ }
  return null;
}

// If `dir` is a LINKED git worktree, the directory its control plane belongs to: the main checkout. A
// linked worktree AND a submodule both have a `.git` FILE, so the `statSync` is only a cheap pre-check
// (a `.git` DIRECTORY is a main checkout or a standalone repo, answered with no git call). They are told
// apart by git: a worktree's own git dir is SEPARATE from the common dir
// (`<main>/.git/worktrees/<name>` vs `<main>/.git`), while a submodule's two are EQUAL
// (`<super>/.git/modules/<name>`). A worktree resolves to the common dir's parent (the main checkout);
// a submodule is NOT a worktree and anchors to itself, so it returns null here (it would otherwise leak
// to the superproject). Null whenever `dir` is not a linked worktree.
function mainCheckoutIfWorktree(dir) {
  let st;
  try { st = fs.statSync(path.join(dir, '.git')); } catch { return null; }
  if (!st.isFile()) return null;
  let gitDir;
  let commonDir;
  try {
    gitDir = path.resolve(git(dir, ['rev-parse', '--path-format=absolute', '--git-dir']).trim());
    commonDir = path.resolve(git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim());
  } catch { return null; } // a git too old for `--path-format`: treat as not-a-worktree, anchor to itself
  if (!gitDir || !commonDir || gitDir === commonDir) return null; // submodule or indeterminate: not a worktree
  const parent = path.dirname(commonDir);
  return parent && parent !== commonDir ? parent : null;
}

/*
 * ⛔ THE ONE PROJECT ROOT — for every hook that keys state per session OR writes under .respawnpack/runtime.
 *
 * Two field incidents, one cause: runtime state anchored to the shell's cwd, not the installed project. A
 * Bash cwd inside a nested team repository made the Stop and SessionStart hooks build a
 * `<nested>/.respawnpack/runtime/` tree that then travelled with that repository, and a cwd in a plain
 * subdirectory left a stray runtime tree there; separately a subagent in a linked worktree read a
 * different interaction contract than its orchestrator because the runtime resolved from its own cwd.
 * There is now ONE resolver (the earlier `projectDir`, cwd-first, is gone so no hook can pick the wrong one).
 *
 * Resolution order, most authoritative first:
 *   1. CLAUDE_PROJECT_DIR — the host's own declaration of which project this session is. Honoured even
 *      WITHOUT the markers: the host is authoritative, and a session told "this IS the project" must not
 *      be overruled by a directory walk.
 *   2. the nearest ancestor of the cwd that carries the pack's install markers. A marker hit on a LINKED
 *      WORKTREE resolves to its MAIN CHECKOUT instead: the worktree checks out the committed markers too,
 *      so anchoring there would split the spawn/index wave counter from the orchestrator at the root (the
 *      Scenario M split this used to prevent by taking the common-dir parent first). A main checkout or a
 *      standalone nested install anchors to itself.
 *   3. the repository's COMMON git dir parent (a linked worktree resolves to its main checkout, which is
 *      why index-guard and spawn-guard key their one counter here rather than on `input.cwd`), then
 *   4. the git top level, then
 *   5. the working directory, when none of the above can answer.
 */
function projectRoot(input) {
  const env = process.env.CLAUDE_PROJECT_DIR;
  if (env) return path.resolve(env);
  const start = path.resolve((input && input.cwd) || process.cwd());
  for (let cur = start; ;) {
    if (hasInstallMarkers(cur)) {
      const main = mainCheckoutIfWorktree(cur);
      if (!main) return cur;                     // a main checkout or a standalone nested install: its own root
      if (hasInstallMarkers(main)) return main;  // a linked worktree: anchor on the main checkout
      cur = main;                                // worktree whose main checkout lacks markers: keep walking from it
    }
    const parent = path.dirname(cur);
    if (parent === cur) break; // reached the filesystem root with no markers
    cur = parent;
  }
  return repoTopOf(start) || start;
}

/*
 * ⛔ THE BELT TO projectRoot's BRACES — defence in depth, NOT reachable through a hook payload. projectRoot
 * always returns a host-declared root, a marked install, a repository top, or (last) the cwd, and
 * runtimeRefusal yields null for every one of those; the only way to reach the refusal is a direct call
 * handing a writer a raw subdirectory, which is how the suite pins it. It is kept because a future caller
 * could do exactly that: a runtime tree must sit at the resolved root, never inside a DIFFERENT repository
 * that merely contains the cwd (the nested-repository leak above), so such a write is refused on stderr
 * and nothing is written. On a NON-markered git target this costs a second `rev-parse` pass (projectRoot
 * already ran one); a markered target short-circuits on the marker check and pays nothing.
 */
function runtimeRefusal(dir) {
  const resolved = canonicalDir(dir);
  const env = process.env.CLAUDE_PROJECT_DIR;
  if (env && canonicalDir(env) === resolved) return null; // the host said this exact directory IS the project
  if (hasInstallMarkers(resolved)) return null;           // a marked install anchors its own runtime tree
  const top = repoTopOf(resolved);
  // Compared through canonicalDir on BOTH sides: git returns the long name and the caller may hand a short
  // one (or vice versa), and the repository root itself must never read as a different root than itself.
  if (top && canonicalDir(top) !== resolved) {
    return `RespawnPack: refusing to write runtime state under ${resolved}; it sits inside repository ${canonicalDir(top)}, a different root than this session resolved.`;
  }
  return null;
}

function noteRuntimeRefusal(why) {
  try { process.stderr.write(`${why}\n`); } catch { /* stderr is gone */ }
}

function runtimeDir(dir) { return path.join(dir, RUNTIME_SUBDIR); }

function sha(text) { return crypto.createHash('sha256').update(text).digest('hex').slice(0, 32); }

// ⛔ maxBuffer is load-bearing (see secret-scan.js for the full account). perFileDiffDigests reads the
// WHOLE working-tree or staged diff through this runner; at Node's 1 MiB default a 2 MiB edit overflowed
// with ENOBUFS, the catch returned an empty map, and the Stop hook read a large session as "no change".
// Bounded rather than Infinity so a hostile tree exhausts the buffer, not the heap.
const GIT_MAX_BUFFER = 256 * 1024 * 1024;
function git(dir, args) {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', maxBuffer: GIT_MAX_BUFFER, stdio: ['ignore', 'pipe', 'ignore'] });
}

function isRepo(dir) {
  try { git(dir, ['rev-parse', '--git-dir']); return true; } catch { return false; }
}

/*
 * ⛔ THE HOOK TREE'S TWIN OF kernel/lib/state.js `writeAtomic`, HARDENED IN LOCKSTEP WITH IT.
 *
 * One function would be better than two. It is not available: `hooks/` cannot require `kernel/`,
 * because the kernel sits at `kernel/lib/` in this repository and at `.claude/respawnpack/lib/` on an
 * installed target while the hooks sit at `.claude/hooks/` — the two trees do not resolve each other
 * identically, which is the same constraint that put `_manifest.js` under `hooks/` rather than in the
 * kernel. So the fix is applied HERE as well, and `kernel/concurrency.test.mjs` fences both spellings
 * together. "The lesson was applied where it was found rather than everywhere it holds" is a failure
 * shape this program has now caught six times; it does not get a seventh here.
 *
 * Guarantees, identical to the kernel's and stated for the same reason: atomic replacement ·
 * last-completed-writer wins · a failure before replacement preserves the prior target byte-for-byte
 * and leaves no temporary · NOT a merge (read-modify-write callers need `withLock` too — the spawn
 * counter is exactly that caller) · NOT a transactional multi-file update.
 */
const REPLACE_CONTENTION_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const REPLACE_DEADLINE_MS = 2000;
let tmpSeq = 0;

function atomicWriteJSON(file, obj) {
  let tmp = null;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Per-CALL, not per-process: a pid-derived name is a function of the process, so anything sharing
    // one shares the buffer and two writers publish a mixture.
    tmp = `${file}.${process.pid}.${(tmpSeq += 1)}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    // Windows reports a momentarily-open destination as EPERM — the same signal `_index-lease.js`
    // already retries for lock creation. Treating the first one as fatal loses an ordinary write.
    const deadline = Date.now() + REPLACE_DEADLINE_MS;
    for (;;) {
      try { fs.renameSync(tmp, file); break; }
      catch (e) {
        const code = (e && e.code) || 'UNKNOWN';
        if (!REPLACE_CONTENTION_CODES.has(code) || Date.now() > deadline) throw e;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3);
      }
    }
    return true;
  } catch {
    // The caller's contract here is boolean, not throwing — but a failed write must still not leave
    // its temporary in the runtime directory, one per attempt, forever.
    if (tmp) { try { fs.unlinkSync(tmp); } catch { /* already gone, or unremovable */ } }
    return false;
  }
}

/*
 * ⛔ EVERY READ OF AN ATOMICALLY-REPLACED ARTIFACT GOES THROUGH THE RETRYING BOUNDARY.
 *
 * On Windows a reader can observe the target of an in-flight replacement as momentarily ABSENT or
 * locked — measured here at four ENOENT failures in ~770 reads while ~2000 replacements landed. A bare
 *  turns that sub-millisecond race into a fact about the project: no baseline,
 * no stop record, no contract. Retrying is what separates 'not there' from 'not there YET'.
 */
function readJSON(file) {
  // A boundary that cannot answer is not a record that says "nothing" — but every caller of this
  // function already treats null as "no usable record" and redoes the work, which is the safe side.
  if (artifactUnavailable()) return null;
  const r = artifact.readJSONClassified(file);
  return r.status === 'OK' ? r.doc : null;
}

/**
 * An exclusive file lock with bounded spinning, for read-modify-write state (the spawn counter).
 * `wx` is the portable compare-and-swap primitive: it either creates the lock or fails, atomically.
 * A lock older than STALE_LOCK_MS is broken — a hook killed mid-update must never wedge the next one.
 */
const STALE_LOCK_MS = 5000;
/*
 * ⛔ ONE LOCK IMPLEMENTATION, and it is the hardened one. This function used to have its own copy with
 * three defects the index lease had already been corrected for: it ran the critical section UNLOCKED
 * when the lock could not be created, it BROKE A FRESH LOCK once the caller timed out, and its catch
 * also swallowed exceptions from `fn` itself. Under genuine 12-way contention that produced lost
 * updates — the exact failure the spawn counter's concurrency test claimed to disprove, on a fixture
 * that was never actually concurrent. Delegating removes the second copy rather than fixing it twice.
 *
 * Returns {locked:true, value} or {locked:false, why}; callers must decide what an unestablished lock
 * means for them, and none may treat it as success.
 */
function withLock(file, fn) {
  return require('./_index-lease.js').withLock(file, fn);
}

// --- tree state -----------------------------------------------------------------------------------

function isSelfPath(p) { return p === SELF_PREFIX || p.startsWith(`${SELF_PREFIX}/`) || p.startsWith(`${SELF_PREFIX}\\`); }

/**
 * Per-file digests from ONE `git diff` call, by splitting on the `diff --git` headers.
 *
 * Per-file granularity is the whole point, and it is what a name-list cannot give you: the hard case
 * from field run A is a file that was ALREADY dirty at boot and got edited again
 * during the session. Its name is in both lists; only its content digest moves.
 */
function perFileDiffDigests(dir, cached) {
  const map = {};
  let out;
  try { out = git(dir, ['diff', ...(cached ? ['--cached'] : []), '--no-color', '--no-ext-diff']); } catch { return map; }
  for (const chunk of out.split(/^diff --git /m)) {
    if (!chunk.trim()) continue;
    const m = /^a\/(.+?) b\/(.+?)$/m.exec(chunk);
    const p = m ? m[2] : null;
    if (!p || isSelfPath(p)) continue;
    map[p] = sha(chunk);
  }
  return map;
}

const MAX_HASH_BYTES = 1024 * 1024; // hash at most 1 MB of any one file; size is folded in below

/*
 * ⛔ THE UNTRACKED CONTENT-DIGEST CAP. A session can sit on top of tens of thousands of untracked files
 * (a vendored tree, a build output a founder never gitignored), and reading every one of them at Stop
 * and at SessionStart is part of what put those hooks in the seconds on a large target. Past this many
 * untracked paths a path carries its NAME (which is its key) and its SIZE (one `statSync`, never a
 * read) instead of a content digest, and a wholly untracked directory is carried as one entry with its
 * child count rather than walked at all.
 *
 * What that buys and what it costs, stated plainly because it is a real blind spot: beyond the cap a
 * SIZE change is still caught, but a content change that keeps the SAME size is NOT. The cap applies to
 * untracked paths only (a tracked dirty path is always read, never capped), and 500 is far above any
 * real editing session, so the files that lose content digests are the ones a session was never
 * plausibly editing by hand.
 */
const UNTRACKED_DIGEST_CAP = 500;

function fileDigest(abs) {
  try {
    const st = fs.statSync(abs);
    if (st.isDirectory()) return null;
    const fd = fs.openSync(abs, 'r');
    try {
      const len = Math.min(st.size, MAX_HASH_BYTES);
      const buf = Buffer.alloc(len);
      if (len) fs.readSync(fd, buf, 0, len, 0);
      // Size participates so that appending past the cap still changes the digest.
      return sha(`${st.size}:${buf.toString('binary')}`);
    } finally { fs.closeSync(fd); }
  } catch { return null; }
}

// Name-and-size identity for an untracked path past the cap: one `statSync`, no read. The `sz:` tag
// keeps it from ever colliding with a content sha, so a path that crosses the cap boundary reads as
// changed rather than silently equal to its own content digest.
function sizeIdentity(abs) {
  try { return `sz:${fs.statSync(abs).size}`; } catch { return null; }
}

/*
 * Does the subtree under `abs` hold more than `budget` entries? Counts with one readdirSync per level
 * (the entry type comes from the readdir itself, so there is no stat per file) and STOPS the moment it
 * passes the budget, and never follows a symlink. So "6,000 files behind one build/" costs one readdir
 * and a bounded count, never a stat per file. An unreadable directory is treated as too big to walk.
 */
function dirExceeds(abs, budget) {
  let count = 0;
  const stack = [abs];
  while (stack.length) {
    const cur = stack.pop();
    let ents;
    try { ents = fs.readdirSync(cur, { withFileTypes: true }); } catch { return true; }
    for (const e of ents) {
      if (++count > budget) return true;
      if (e.isDirectory()) stack.push(path.join(cur, e.name));
    }
  }
  return false;
}

// The cheap identity for a wholly untracked directory carried whole (too big to walk, or past the cap):
// its immediate entry count. Adding or removing a top-level entry moves it, so the directory still reads
// as changed; a change deep inside it does not, which is the coarse signal the cap trades the walk for.
function dirIdentity(abs) {
  try { return `dir:${fs.readdirSync(abs).length}`; } catch { return null; }
}

/**
 * Untracked paths and a content identity for each, bounded by an expected FILE count, not a root count.
 *
 * A collapsed `git status --porcelain --no-renames` (the default `-unormal`, which reports a WHOLLY
 * untracked directory as one entry rather than every file inside it) is the cheap first pass. The full
 * per-file `-uall` walk is run only when there is a directory to expand, the roots are below the cap,
 * and NO untracked directory would itself blow the cap (dirExceeds decides with a bounded readdir, no
 * stat per file). A directory too big to walk is carried as one `dir/` entry, so a build output of tens
 * of thousands of untracked files is never enumerated file by file. One wholly untracked directory used
 * to pass a roots-only gate and trigger a full walk; counting files is what closes that.
 *
 * Then at most UNTRACKED_DIGEST_CAP paths get a content digest (a read); the rest carry name and size,
 * and a carried directory its entry count. The list is sorted so the same tree always digests the same
 * first N paths. At the cap boundary an add or remove elsewhere can shift which path crosses from a
 * content digest to a size marker, adding a spurious name to the delta; it never fabricates a delta from
 * an unchanged tree.
 */
function untrackedDigests(dir) {
  const out = {};
  let roots;
  try { roots = untrackedPaths(git(dir, ['status', '--porcelain', '--no-renames'])); }
  catch { return out; } // status unavailable: the diff digests still carry most of the signal

  const dirRoots = roots.filter((p) => p.endsWith('/'));
  const affordable = dirRoots.length > 0
    && roots.length <= UNTRACKED_DIGEST_CAP
    && !dirRoots.some((d) => dirExceeds(path.join(dir, d.replace(/\/$/, '')), UNTRACKED_DIGEST_CAP));

  let paths = roots;
  if (affordable) {
    try { paths = untrackedPaths(git(dir, ['status', '--porcelain', '-uall', '--no-renames'])); }
    catch { paths = roots; }
  }

  paths.sort();
  for (let i = 0; i < paths.length; i++) {
    const p = paths[i];
    const abs = path.join(dir, p.replace(/\/$/, ''));
    let d;
    if (p.endsWith('/')) d = dirIdentity(abs);                       // carried whole, never read or walked
    else d = i < UNTRACKED_DIGEST_CAP ? fileDigest(abs) : sizeIdentity(abs);
    if (d) out[p] = d;
  }
  return out;
}

function untrackedPaths(porcelain) {
  const out = [];
  for (const line of porcelain.split(/\r?\n/)) {
    if (!line.startsWith('?? ')) continue;
    const p = line.slice(3).replace(/^"(.*)"$/, '$1');
    if (isSelfPath(p)) continue;
    out.push(p);
  }
  return out;
}

/**
 * A content-addressed snapshot of everything a session could plausibly change.
 * Returns null when the directory is not a git repo — the caller decides what that means for it.
 */
function treeState(dir) {
  if (!isRepo(dir)) return null;
  let headRev = null;
  try { headRev = git(dir, ['rev-parse', 'HEAD']).trim(); } catch { headRev = null; } // no commits yet — legal

  /*
   * ⛔ ORDER IS THE INDEX WARM-UP, not an explicit refresh. On a cold index (a fresh worktree, a
   * `read-tree`, or any stale stat cache) the first command here that stat-checks the whole tree pays
   * ONE full hash (measured about 3 s on the fixture) and WRITES THE INDEX BACK; every command after it
   * runs against the warm index at about 0.1 s. On the target git (2.51.0.windows.2) both `git status`
   * and `git diff` do this (verified by re-cooling and timing: collapsed status 2.7 s then the diffs
   * 0.1 s each). So the cheap move is to let the collapsed `git status` warm it, since untrackedDigests
   * runs that status anyway for the untracked listing and the affordability gate. It is therefore called
   * FIRST, before the two diffs, which then ride the warm index. An explicit `git update-index --refresh`
   * would warm it at the same cold cost but add about 140 ms of stat-walk on an already-warm tree for
   * nothing, so ordering is used instead. (If a later git ever stops writing the index back from
   * `status --porcelain`, the cold diffs return and an explicit refresh is the fix.)
   */
  const untracked = untrackedDigests(dir); // its collapsed `git status` is the first index-touching call

  const files = {};
  for (const [p, d] of Object.entries(perFileDiffDigests(dir, false))) files[`W:${p}`] = d;
  for (const [p, d] of Object.entries(perFileDiffDigests(dir, true))) files[`S:${p}`] = d;
  // Untracked paths: `git diff` cannot see them at all, so they carry their own content digests (capped,
  // with the full walk gated on that collapsed status; see untrackedDigests).
  for (const [p, d] of Object.entries(untracked)) files[`U:${p}`] = d;

  /*
   * ⛔ AND A CONTENT DIGEST PER PATH, BECAUSE THE THREE BUCKETS ABOVE ARE NOT COMPARABLE TO EACH OTHER.
   *
   * `W:`/`S:` hold digests of a DIFF; `U:` holds a digest of the FILE. They answer different questions,
   * so a path that moves between buckets changes its recorded digest even when not one byte of it did.
   * `git add` on an untracked file does exactly that: `U:<p>` (content digest) disappears and `S:<p>`
   * (diff digest) appears, and any comparison over these keys reports a modification that never
   * happened. the 2026-08-07 field run §4 measured it at 563 files — `legacy-docs/*.docx` and `.pdf` reported as
   * "changed" when "those files were never modified — they were untracked, then tracked". A nag whose
   * evidence is visibly wrong gets dismissed along with the ones that were right.
   *
   * `C:<path>` is the one key that means the same thing in every bucket: the bytes on disk right now.
   * It is what diffStates compares. The bucket keys are KEPT — they are what distinguishes a staged
   * edit from an unstaged one, and dropping them to fix this would trade a false positive for a blind
   * spot. Cost is bounded: a digest per path that already appears in some bucket, not a repo walk,
   * and ONE digest per path, because an untracked path already has its identity from the `U:` pass
   * above (identical bytes, identical function) and reuses it rather than reading the file a second
   * time. A tracked dirty path is read here, once, and is never subject to the untracked cap.
   */
  for (const p of new Set(Object.keys(files).map(pathOf))) {
    if (Object.hasOwn(untracked, p)) { files[`C:${p}`] = untracked[p]; continue; }
    const d = fileDigest(path.join(dir, p));
    if (d) files[`C:${p}`] = d; // absent for a deleted path — diffStates falls back to the bucket keys
  }

  return { head: headRev, files, capturedAt: new Date().toISOString() };
}

// ⭐ THE ONE SPELLING OF THE BUCKET-KEY-TO-PATH RULE. Every derivation of a path list from a
// treeState() key set goes through here — inside this file and, since it is exported, outside it too.
function pathOf(key) { return key.slice(2); }

/*
 * ⛔ A FILE'S GIT STATUS CHANGING IS NOT THE FILE CHANGING — AND THE OLD COMPARISON COULD NOT TELL.
 * See treeState's `C:` block for the mechanism and the field measurement (field run §4, 563 files).
 *
 * The identity of a path is its CONTENT digest when there is one, and only otherwise the bucket
 * digests. That ordering is the whole fix: `C:` means the same thing in every bucket, so a
 * `U:` → `S:` move with identical bytes compares equal, while an edit — staged or not — does not.
 *
 * ⛔ THE FALLBACK IS NOT A CONVENIENCE. A DELETED path has no content to digest, so it has no `C:` key
 * and lands here with its `W:`/`S:` deletion diff. Comparing the bucket digests keeps a deletion
 * visible; skipping a path with no `C:` key would make `rm` the one edit the Stop hook never notices.
 */
function contentIdentity(state) {
  const byPath = new Map();
  for (const [k, v] of Object.entries(state.files)) {
    const p = pathOf(k);
    if (!byPath.has(p)) byPath.set(p, { content: null, buckets: new Set() });
    if (k.startsWith('C:')) byPath.get(p).content = v;
    else byPath.get(p).buckets.add(v);
  }
  // Sorted so two equal sets always render to the same string regardless of insertion order.
  return new Map([...byPath].map(([p, rec]) => [p, rec.content !== null ? `C:${rec.content}` : `B:${[...rec.buckets].sort().join('|')}`]));
}

/**
 * Compare a snapshot against the session baseline.
 * Outcomes are explicit: CHANGED / UNCHANGED / CANNOT_DETERMINE. There is deliberately no fourth
 * "probably fine" — a check that cannot tell must say so rather than pick the quiet answer.
 */
function diffStates(baseline, current) {
  if (!baseline || !current) return { status: 'CANNOT_DETERMINE', files: [], headMoved: false, reason: 'no baseline for this session' };
  const headMoved = Boolean(baseline.head !== current.head);
  const changed = new Set();

  const before = contentIdentity(baseline);
  const after = contentIdentity(current);
  for (const [p, id] of after) if (before.get(p) !== id) changed.add(p);
  for (const p of before.keys()) if (!after.has(p)) changed.add(p);

  const files = [...changed].sort();
  return {
    status: files.length || headMoved ? 'CHANGED' : 'UNCHANGED',
    files,
    headMoved,
    baselineHead: baseline.head,
    currentHead: current.head,
  };
}

// --- session baseline -----------------------------------------------------------------------------

const safeId = (id) => String(id || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');

function baselinePath(dir, sessionId) { return path.join(runtimeDir(dir), `session-${safeId(sessionId)}.json`); }

/**
 * Record what the tree looked like when the session started. Idempotent per session: SessionStart
 * fires on startup, resume, clear AND compact, and re-baselining after a compaction would erase the
 * session's own accumulated work from the comparison — exactly the state loss the baseline exists to
 * prevent.
 */
function captureBaseline(dir, sessionId) {
  const refusal = runtimeRefusal(dir);
  if (refusal) { noteRuntimeRefusal(refusal); return null; }
  const file = baselinePath(dir, sessionId);
  const existing = readJSON(file);
  if (existing && existing.head !== undefined) return existing;
  const state = treeState(dir);
  if (!state) return null;

  /*
   * ⛔ NO STAGED SNAPSHOT IS TAKEN HERE, deliberately. An earlier version recorded the index contents
   * at SessionStart and treated that as "the human's work" — which missed anything staged AFTERWARDS,
   * and could not see a staged deletion at all (a tombstone has no index entry to snapshot). Staged
   * ownership is now computed LIVE by index-guard from positively-confirmed agent operations, so
   * anything the session cannot account for is foreign whenever it appeared. Only the index identity
   * is recorded, for diagnostics.
   */
  let indexPath = null;
  try { indexPath = require('./_index-lease.js').indexIdentity(dir); } catch { /* diagnostics only */ }

  const record = {
    sessionId: String(sessionId || 'unknown'), ...state,
    workingDigest: sha(JSON.stringify(state.files)), stagedDigest: sha(String(state.head)),
    indexPath,
  };
  atomicWriteJSON(file, record);
  return record;
}

function readBaseline(dir, sessionId) { return readJSON(baselinePath(dir, sessionId)); }

/**
 * What changed since this session started.
 *
 * ⭐ `current` IS OPTIONAL, FOR A CALLER THAT ALREADY HAS ONE (audit BUG-4 / task T-03).
 * `treeState(dir)` is five git subprocesses (isRepo, rev-parse HEAD, one collapsed status, two diffs),
 * plus a sixth `status -uall` only when a wholly untracked directory is small enough to expand (roots
 * below the cap and no directory over it). Omitting `current` keeps every existing caller's behaviour;
 * it is computed fresh here, exactly as
 * before. A caller that already computed `treeState(dir)` moments earlier for its own purposes (nothing
 * runs between the two calls that could change the tree) passes that same value instead of paying for a
 * second, identical five-call snapshot. `undefined` is the only value that triggers the fresh computation
 * — a caller that has already resolved `dir` to a non-repo passes `null` through unchanged, exactly what a
 * second `treeState(dir)` call would have answered anyway.
 */
function sessionDelta(dir, sessionId, current) {
  return diffStates(readBaseline(dir, sessionId), current !== undefined ? current : treeState(dir));
}

// --- stop decision records ------------------------------------------------------------------------

function stopRecordPath(dir, sessionId) { return path.join(runtimeDir(dir), `stop-${safeId(sessionId)}.json`); }

/**
 * The loop guard R-8 asks for. `stop_hook_active` only covers ONE turn; an agent that reasons for a
 * turn and then tries to stop again arrives with the flag cleared and gets blocked a second time on
 * identical state. Keying the record on (session, head, delta digest) means an unchanged retry is
 * accepted, while genuinely new work re-arms the nudge.
 */
function deltaFingerprint(delta) { return sha(`${delta.currentHead || ''}|${delta.files.join(',')}`); }

function alreadyStoppedOn(dir, sessionId, delta) {
  const rec = readJSON(stopRecordPath(dir, sessionId));
  return Boolean(rec && rec.fingerprint === deltaFingerprint(delta));
}

/*
 * The savepoint receipt (field run §4). Written by the kernel on EVERY savepoint run — see
 * `recordSavepointAttempt` in kernel/respawnpack.js for why a blocked run is the important case. Read
 * here so a Stop hook can tell "nobody has tried" from "it was tried and it could not finish", which
 * were previously the same observation.
 *
 * ⛔ NOT A CROSS-TREE REQUIRE. The hooks cannot load the kernel (hooks/_manifest.js documents the one
 * module that spans both); this is a plain JSON file at a path both sides spell independently. The
 * shape is therefore validated rather than trusted: anything unreadable, unparseable, or missing its
 * digest reads as "no attempt on record", which degrades to the ordinary nag — the conservative answer,
 * since the failure mode of guessing wrong here is a savepoint nobody is reminded to run.
 */
function savepointAttemptPath(dir) { return path.join(runtimeDir(dir), 'savepoint-attempt.json'); }

function readSavepointAttempt(dir) {
  const rec = readJSON(savepointAttemptPath(dir));
  if (!rec || typeof rec.blockerDigest !== 'string' || typeof rec.exitCode !== 'number') return null;
  // The source the run verified. Shape-checked like everything else here: anything but a full hash
  // reads as "unrecorded", which is what an older kernel's receipt carries, and which never qualifies
  // as a committed closeout — the Stop hook's conservative direction.
  const revision = typeof rec.sourceRevision === 'string' && /^[0-9a-f]{40}$/.test(rec.sourceRevision) ? rec.sourceRevision : null;
  return {
    at: rec.at || null,
    outcome: rec.outcome || null,
    exitCode: rec.exitCode,
    blockerDigest: rec.blockerDigest,
    blockers: Array.isArray(rec.blockers) ? rec.blockers : [],
    sourceRevision: revision,
  };
}

function recordStop(dir, sessionId, delta, branch) {
  const refusal = runtimeRefusal(dir);
  if (refusal) { noteRuntimeRefusal(refusal); return; }
  atomicWriteJSON(stopRecordPath(dir, sessionId), {
    sessionId: String(sessionId || 'unknown'),
    fingerprint: deltaFingerprint(delta),
    head: delta.currentHead || null,
    files: delta.files,
    branch: branch || 'blocked-for-closeout',
    at: new Date().toISOString(),
  });
}

// --- interaction contract -------------------------------------------------------------------------

const VALID_MODES = new Set(['collaborate', 'delegate', 'goal']);

/**
 * The active interaction contract (ADR-001, decision 1). Absent file ⇒ collaborate, always.
 * Goal mode is NEVER inferred — it exists only because someone wrote it down, which is the whole
 * protection against a hard task quietly acquiring autonomous semantics.
 *
 * Runtime holds only the POINTER (mode + activeGoalId + suspendedGoalId; `goalId` is the legacy alias
 * for activeGoalId and is still resolved). The goal itself — criteria,
 * constraints, authority, forbidden actions — is durable project truth in
 * docs/derived/state/goal.json, so suspending a goal to collaborate for a minute cannot destroy it and
 * a fresh clone still carries the contract.
 */
function readContract(dir) {
  // ⛔ Collaborate is the conservative answer — the most ceremony, the least authority — so degrading
  // here cannot GRANT anything. It is reported as `unavailable`, never as `default`: a session told the
  // contract could not be read is in a different position from one told there is no contract.
  const boundary = artifactUnavailable();
  if (boundary) return { mode: 'collaborate', source: 'unavailable', contractUnreadable: boundary };
  const c = readJSON(path.join(runtimeDir(dir), 'contract.json'));
  if (!c || !VALID_MODES.has(c.mode)) return { mode: 'collaborate', source: 'default' };
  const resolved = { ...c, source: 'file' };
  /*
   * ⛔ THE GOAL IS RESOLVED THROUGH THE SAME ACCEPTANCE BOUNDARY THE COMPILER USES.
   *
   * This reader used to call `readJSON` and take whatever came back. Reproduced on a real installed
   * target: a `goal.json` declaring `schemaVersion: "999.0.0"` was ACTIVATED here — goal text,
   * completion criteria, constraints, authority and forbidden actions all assigned from a document
   * nothing had agreed to accept. And a `constraints` of `"not an array"` was passed straight through
   * to a session, where a string spreads into single characters.
   *
   * Worse than either: on a transient read failure — which Windows produces while STATE.json or
   * goal.json is being atomically replaced — the old code silently assigned NOTHING and returned a
   * goal-mode contract with no constraints and no forbidden actions. Safety context vanished from a
   * race, and the session had no way to know.
   *
   * So a refusal is now REPORTED on the contract itself. Callers must surface it; they may not treat
   * a refused goal as a goal with no restrictions.
   */
  // ⛔ NEW SPELLING FIRST, LEGACY SECOND. The runtime pointer was renamed `goalId` → `activeGoalId`
  // when the durable/runtime boundary was restored, and this reader was left resolving only the old
  // name. Nothing failed — the hooks still reported mode=goal — while the goal text, completion
  // criteria, constraints, authority and FORBIDDEN ACTIONS silently stopped reaching the session.
  // Both spellings are honored so a machine holding a pre-rename runtime file does not go dark.
  const id = c.activeGoalId || c.goalId;
  if (id) {
    const r = artifact.loadGoalDoc(path.join(dir, 'docs', 'derived', 'state', 'goal.json'));
    if (artifact.REJECTED.has(r.status)) {
      resolved.goalContractRefused = r.detail || `goal.json was refused (${r.status})`;
    } else if (r.status === 'ABSENT') {
      resolved.goalContractRefused = `the runtime points at goal ${id}, but docs/derived/state/goal.json is not present — the contract this session is operating under cannot be read`;
    } else {
      const doc = r.doc;
      const g = (doc.goals && doc.goals[id]) || (typeof doc.goal === 'string' ? { goal: doc.goal } : null);
      if (g) Object.assign(resolved, { goal: g.goal, completion: g.completion, constraints: g.constraints, forbidden: g.forbidden, authority: g.authority });
      else resolved.goalContractRefused = `the runtime points at goal ${JSON.stringify(id)}, which does not exist in goal.json`;
    }
  }
  return resolved;
}

// --- durable state, read-only from the hook side --------------------------------------------------

/**
 * Read the generated durable state and say whether it can be trusted.
 *
 * ⛔ A hook must NEVER present a state file as current without checking it, and the check is
 * TWO-PART. `docs/derived/STATE.json` is a projection of a revision AND of a set of input files:
 *   • revision — if HEAD moved past it by anything other than the commit of the savepoint's own
 *     output, its numbers describe a project that no longer exists (the equivalence is defined once,
 *     in hooks/_manifest.js sourceRevisions — see the ⛔ note at the comparison below);
 *   • content  — every compiler input (requirements, the goal contract, evidence, the validator
 *     declarations) is a file someone edits BEFORE committing. A revision-only check calls the
 *     projection current while its own source has already changed underneath it, and the session then
 *     boots on a count that is provably wrong.
 * Both must agree for CURRENT. Anything unverifiable is CANNOT_DETERMINE, never a quiet pass.
 */
function readDurableState(dir) {
  // The boundary that decides what "readable" means cannot itself be unreadable and leave this a pass.
  const boundary = artifactUnavailable();
  if (boundary) return { status: 'CANNOT_DETERMINE', state: null, detail: boundary };
  /*
   * ⛔ ABSENT MUST MEAN ABSENT. This read used to be `readJSON`, which returns null for a file that is
   * not there AND for one that could not be opened at that instant — and on Windows a reader can
   * observe the target of an in-flight atomic replacement as momentarily missing. Measured: four of
   * ~770 reads returned ENOENT while ~2000 replacements landed. Every one of those would have told the
   * session "this project has no compiled state", which is a sentence about the PROJECT, derived from
   * a race lasting under a millisecond.
   */
  const r = artifact.readJSONClassified(path.join(dir, 'docs', 'derived', 'STATE.json'));
  if (r.status === 'ABSENT') return { status: 'ABSENT', state: null };
  if (r.status !== 'OK') {
    return {
      status: 'CANNOT_DETERMINE', state: null,
      detail: `docs/derived/STATE.json EXISTS and could not be read: ${r.detail}. This is NOT the same as a project with no compiled state.`,
    };
  }
  const state = r.doc;
  if (!isRepo(dir)) return { status: 'CANNOT_DETERMINE', state, detail: 'not a git repository — the state revision cannot be checked' };

  /*
   * ⛔ "THE REVISION" IS AN EQUIVALENCE CLASS, NOT A STRING. The documented closeout commits the
   * regenerated derived docs ON TOP of the work they describe, so HEAD is one savepoint-only commit past
   * `sourceRevision` at every subsequent boot — and `sourceRevision !== HEAD` announced that state as
   * STALE and withheld every count, every session, on a real target (2026-08-23). The class is defined
   * once, in hooks/_manifest.js: HEAD plus every ancestor reached through commits that touch only the
   * savepoint's own outputs. Anything else HEAD did is still STALE, exactly as before. The chain travels
   * out on the result so the Stop hook can ask the same question of the savepoint receipt.
   */
  const revisions = manifest.sourceRevisions(dir);
  const headRev = revisions.head;
  if (!state.sourceRevision || !headRev) return { status: 'CANNOT_DETERMINE', state, revisions, detail: 'no revision to compare against' };
  if (!revisions.chain.includes(state.sourceRevision)) {
    return {
      status: 'STALE', state, headRev, revisions,
      detail: `STATE.json describes ${state.sourceRevision.slice(0, 7)}, HEAD is ${headRev.slice(0, 7)}${revisions.head !== revisions.effective ? ` (source ${String(revisions.effective).slice(0, 7)})` : ''} — and the difference is not only a savepoint commit`,
    };
  }

  const m = manifest.compareManifest(state.sourceManifest, dir);
  if (m.status !== 'CURRENT') return { status: m.status, state: withCorpusFreshness(state, dir), headRev, revisions, detail: m.detail, changed: m.changed };

  return { status: 'CURRENT', state: withCorpusFreshness(state, dir), headRev, revisions };
}

/*
 * ⛔ THE KILLED-FEATURE VERDICT HAS ITS OWN FRESHNESS, AND MUST NOT BORROW STATE'S (Scenario L).
 *
 * `sourceManifest` covers the COMPILER inputs. The removal verdict is a function of the scanned live
 * content, which is not one of them — so a doc edit that reintroduces a retired feature leaves
 * STATE.json perfectly CURRENT while its "clear" verdict has silently stopped being true. That is the
 * confident-stale-claim failure this program exists to end, relocated into the safety half where it
 * would cost more. The corpus digests recorded by the scan are recomputed here, and a moved corpus
 * downgrades the verdict to STALE rather than repeating it.
 *
 * Fails OPEN in the sense that matters: if the comparison itself cannot run, the answer is
 * CANNOT_DETERMINE, never CURRENT.
 */
function withCorpusFreshness(state, dir) {
  if (!state || !state.removals) return state;
  // B3: the corpus manifest moved out of STATE.json to docs/derived/state/corpus.json. It is a savepoint
  // output, read here through the classified boundary (readJSON) so an absent, locked or malformed file
  // is CANNOT_DETERMINE, never a stale CURRENT — the one direction a freshness check must never guess.
  const corpus = readJSON(path.join(dir, 'docs', 'derived', 'state', 'corpus.json'));
  const rec = corpus && corpus.corpusManifest;
  if (!rec) return { ...state, removals: { ...state.removals, corpusFreshness: 'CANNOT_DETERMINE' } };
  let cmp;
  try { cmp = manifest.compareDigestMap(rec, dir); }
  catch (e) { cmp = { status: 'CANNOT_DETERMINE', detail: e.message }; }
  return { ...state, removals: { ...state.removals, corpusFreshness: cmp.status, corpusFreshnessDetail: cmp.detail || null } };
}

// --- compaction handoff ---------------------------------------------------------------------------

function precompactPath(dir, sessionId) { return path.join(runtimeDir(dir), `precompact-${safeId(sessionId)}.json`); }

/**
 * Read a compaction handoff written for this session and not yet consumed.
 *
 * ⛔ Writing a verified handoff that nothing ever reads converts "a message on a dead channel" into
 * "a message in an unread mailbox" — a quieter failure of the same kind. SessionStart consumes it, and
 * marking it consumed is what stops the same stale handoff being re-injected on every later boot.
 */
function takePrecompactHandoff(dir, sessionId) {
  const file = precompactPath(dir, sessionId);
  const rec = readJSON(file);
  if (!rec || rec.consumedAt) return null;
  if (rec.readBackVerified !== true) return { ...rec, unverified: true };
  return rec;
}

function markPrecompactConsumed(dir, sessionId) {
  const refusal = runtimeRefusal(dir);
  if (refusal) { noteRuntimeRefusal(refusal); return false; }
  const file = precompactPath(dir, sessionId);
  const rec = readJSON(file);
  if (!rec) return false;
  return atomicWriteJSON(file, { ...rec, consumedAt: new Date().toISOString() });
}

// --- catch counter ---------------------------------------------------------------------------------

/*
 * The record of what the pack's guards actually CAUGHT on this machine (review 2026-09-23 §3). The
 * review found the pack kept no trace of a withhold, a refusal or a deny, so an owner could not tell a
 * guard that earns its cost from one that only costs — the field feedback could only say "fired, helped"
 * from incident prose. One line is appended whenever a load-bearing guard withholds, refuses or denies;
 * nothing is recorded on a pass. It joins the other machine-local records under .respawnpack/runtime/
 * (gitignored on a target), and is never read by the hooks themselves — only by `doctor` and `aar`.
 */
function catchesPath(dir) { return path.join(runtimeDir(dir), 'catches.jsonl'); }

/*
 * ⛔ FAIL-CLOSED GUARDS, BEST-EFFORT COUNTERS. The deny, the withhold or the refusal is decided and
 * emitted BEFORE this runs; a counter that cannot be written must never change that verdict, so every
 * failure here is swallowed. Append-only through `fs.appendFileSync`: one JSON line well under 4 KB is a
 * single write that the OS does not interleave with another process's append, which is atomic enough for
 * a record no hook ever reads back — the worst a torn concurrent append can leave is one unparseable
 * line, which `doctor` counts around and names rather than failing on. The reason is normalised to one
 * line and clipped to 160 characters: the caller passes the sentence it already built for the human, and
 * secret-scan's reason names the pattern class, never the matched bytes (confirmed at its call site).
 */
function recordCatch(dir, entry) {
  try {
    const guard = String((entry && entry.guard) || '').trim();
    const event = String((entry && entry.event) || '').trim();
    if (!guard || !event) return false;
    const rec = {
      at: new Date().toISOString(),
      guard,
      event,
      reason: String((entry && entry.reason) || '').replace(/\s+/g, ' ').trim().slice(0, 160),
    };
    if (entry && entry.sessionId) rec.sessionId = String(entry.sessionId);
    if (entry && entry.cycleId) rec.cycleId = String(entry.cycleId);
    const file = catchesPath(dir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(rec)}\n`);
    return true;
  } catch { return false; }
}

/*
 * Read the catch log for a reader that reports it (`doctor`, `aar`). ABSENT is a first-class answer: its
 * absence on another clone proves nothing, exactly the sentence the savepoint receipt uses. A line that
 * does not parse is NAMED by its number while the good lines are still counted — a malformed tail must
 * not erase the record that a guard did fire.
 */
function readCatches(dir) {
  let raw;
  try { raw = fs.readFileSync(catchesPath(dir), 'utf8'); }
  catch (e) {
    if (e && e.code === 'ENOENT') return { status: 'ABSENT', good: 0, totals: {}, bad: [], first: null, last: null };
    return { status: 'UNREADABLE', detail: (e && e.message) || 'could not read', good: 0, totals: {}, bad: [], first: null, last: null };
  }
  const totals = {};
  const bad = [];
  let good = 0;
  let first = null;
  let last = null;
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    let rec;
    try { rec = JSON.parse(lines[i]); } catch { bad.push(i + 1); continue; }
    if (!rec || typeof rec !== 'object' || typeof rec.guard !== 'string' || typeof rec.event !== 'string') { bad.push(i + 1); continue; }
    good += 1;
    totals[rec.guard] = (totals[rec.guard] || 0) + 1;
    if (typeof rec.at === 'string') {
      if (!first || rec.at < first) first = rec.at;
      if (!last || rec.at > last) last = rec.at;
    }
  }
  return { status: 'OK', good, totals, bad, first, last };
}

module.exports = {
  SPAWN_STALE_MS,
  projectRoot, runtimeRefusal, runtimeDir, atomicWriteJSON, readJSON, withLock, sha,
  isRepo, treeState, pathOf, diffStates, captureBaseline, readBaseline, baselinePath, sessionDelta,
  stopRecordPath, alreadyStoppedOn, recordStop, deltaFingerprint,
  savepointAttemptPath, readSavepointAttempt,
  readContract, VALID_MODES, isSelfPath, fileDigest,
  readDurableState, takePrecompactHandoff, markPrecompactConsumed, precompactPath,
  catchesPath, recordCatch, readCatches,
};
