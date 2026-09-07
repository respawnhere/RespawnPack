/*
 * RespawnPack · hooks/_git-effect.js — what a git subcommand would do to the index, in REPOSITORY
 * coordinates.
 *
 * NOT A HOOK (leading underscore — the counts fence excludes these).
 *
 * ⛔ THE MISCLASSIFICATION THIS REPLACES. An earlier guard treated every non-option token as a
 * pathspec, so it read these as narrowly scoped and let them through while foreign staged work sat in
 * the index:
 *     git reset HEAD~1                  → "HEAD~1" is a REVISION; this rewrites the whole index
 *     git checkout -f otherbranch       → a branch name; -f discards everything
 *     git switch --discard-changes b    → same
 *     git apply --cached patch.diff     → a PATCH FILE; it may touch any path in the repo
 * A revision, a branch name and a patch filename are not owned project paths. Where git itself is
 * ambiguous about which it received, the only safe reading is SWEEPING — and the `--` separator is
 * how a caller proves otherwise, because it is how git itself resolves the same ambiguity.
 *
 * ⛔ AND THE REPRESENTATION BOUNDARY THIS CLOSES. Even once a token was known to be a pathspec, it was
 * compared RAW against the repo-root paths `git diff --cached` reports. Those are two coordinate
 * systems, and every one of these therefore read as "no overlap" against a foreign staged `sub/A.txt`:
 *     (run in sub/)  git add -- A.txt        → compared "A.txt" with "sub/A.txt"
 *     git -C sub add -- A.txt                → resolved against the wrong directory entirely
 *     git add -- '*.txt' · ':/A.txt' · ':(top)A.txt' · ':(glob)*.txt' · ':!not-A.txt'
 *                                            → pathspec magic and globs match paths they do not spell
 * One canonical representation — repository-root-relative, forward slashes — is used for the
 * PreToolUse intersection and for PostToolUse ownership alike, and anything that cannot be resolved
 * into exactly one such path is SWEEPING.
 *
 * ⭐ Unknown subcommands and aliases are mutating and sweeping. An alias is arbitrary configured
 * behavior; "I don't recognise it" must never resolve to "it's probably fine".
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

/*
 * Git subcommands that DO NOT TOUCH THE INDEX, by name alone.
 *
 * ⛔ "TOUCHES THE INDEX" IS THE ONLY QUESTION THIS FILE ANSWERS, and M.1c had to say so out loud. The
 * classifier used to return `mutates: true` for `git config user.name x` and `git remote add …`,
 * conflating "this is not a read-only command" with "this would change the index". They are different
 * claims: those two change repository CONFIGURATION, cannot sweep a staged entry, and were only ever
 * refused here as a side effect of the shared-checkout Bash allowance that M.1c removed. Keeping them
 * classified as index mutations meant a `git config` took the exclusive INDEX writer lease and could
 * falsely refuse a second session's staging — a cost paid in the exact multi-writer case Scenario M
 * exists to serve. Policing what `git config` can do is a real concern and a DIFFERENT hook's job;
 * quietly annexing it here is how a git-index guard becomes a general shell-security product.
 *
 * `symbolic-ref` in a SETTING form stays an index mutation, because repointing HEAD changes what every
 * staged entry means when it is committed. Its single-argument query form does not.
 */
const READONLY_SUBS = new Set([
  'status', 'log', 'diff', 'show', 'ls-files', 'ls-tree', 'ls-remote', 'rev-parse', 'rev-list',
  'cat-file', 'blame', 'describe', 'shortlog', 'grep', 'var', 'help', 'version', 'whatchanged',
  'for-each-ref', 'merge-base', 'name-rev', 'count-objects', 'verify-pack', 'check-ignore',
  'config', 'remote',
  /*
   * ⛔ AND THE REF/OBJECT/TRANSPORT SURFACE, ADDED AFTER AN ADVERSARIAL PROBE MEASURED THE COST OF THE
   * "unknown ⇒ sweeping" DEFAULT. With one file staged — the ordinary case, because a human staged
   * something — the guard refused `git fetch`, `git push`, `git branch`, `git tag`, `git worktree add`,
   * `git reflog`, `git gc` and `git submodule status`, each with the message "would sweep 1 staged
   * change(s) this session did not create". None of them touches the index, so every one of those
   * refusals was both a false denial AND a false statement — including `git worktree add`, which is the
   * remedy this hook's own denial text recommends.
   *
   * Fail-closed remains the default for anything NOT listed; this is a transcribed, closed list of
   * subcommands that move refs, objects or remote state, in the same discipline as the wrapper grammars.
   */
  'fetch', 'push', 'branch', 'tag', 'worktree', 'reflog', 'notes', 'gc', 'fsck', 'prune',
  'repack', 'pack-refs', 'bundle', 'archive', 'range-diff', 'cherry', 'patch-id',
  // ⛔ `bisect` is NOT here: `bisect start` DETACHES HEAD, which changes the commit every staged entry
  // would be recorded against — the same rationale that keeps `symbolic-ref` in setting form a mutation.
  // Measured: it moved the orchestrator's HEAD from a branch to a detached commit, from a subagent.
  'diff-tree', 'diff-index', 'diff-files', 'format-patch', 'request-pull', 'send-email',
  'maintenance', 'show-ref', 'show-branch', 'verify-commit', 'verify-tag', 'credential',
  /*
   * ⛔ `update-ref` IS NOT HERE, though it sat beside `branch` and `tag` for one round. Unlike them it
   * bypasses git's checked-out-branch protection, so `git update-ref refs/heads/<current> HEAD~1` is
   * `git reset --soft` by another name: verified against real git, it destroyed a commit and made an
   * entry the session never staged appear in the staged set. It falls to the unknown-subcommand
   * default — mutating and sweeping — which is where a ref-mover that redefines what the index means
   * belongs, for the same reason `symbolic-ref` in setting form does.
   */
  // `clean` deletes UNTRACKED files. That is destructive and it is not an index change, so denying it
  // here with "would sweep N staged changes" was false. The gap is recorded rather than papered over:
  // nothing in this pack guards `git clean -fd`, and this hook is not the place to start.
  'clean',
]);

/*
 * Subcommands whose index effect depends on their FIRST ARGUMENT. `git stash list` is a query and
 * `git stash push` rewrites the index; `git submodule status` is a query and `git submodule add` stages.
 */
const ARG_SCOPED_SUBS = {
  stash: { readOnly: new Set(['list', 'show']), defaultReadOnly: false },
  // ⛔ `foreach` is NOT a query: it runs an ARBITRARY SHELL COMMAND in every submodule, and
  // `git submodule foreach "cd ../.. && git commit -a -m x"` swept the superproject's index clean while
  // classified "submodule foreach is a query". A submodule is an ordinary layout; no planted state needed.
  submodule: { readOnly: new Set(['status', 'summary', 'init', 'sync', 'update', 'set-url', 'set-branch', 'deinit']), defaultReadOnly: true },
};

// ⛔ A BARE `-` IS NOT AN OPTION. `git checkout -` means the previous position; treating it as a flag
// left the positional list empty, so the command read as "creates a branch at HEAD". Measured: it
// detached HEAD and emptied the staged set. Kept after M.2 because `-` is still a positional for every
// other subcommand's pathspec resolution, even though checkout/switch no longer inspect their targets.
const isOpt = (t) => t.startsWith('-') && t !== '-';

/*
 * ⛔ OPTIONS THAT CONSUME THE NEXT TOKEN. Without this, `git commit -m "sweep"` reads the MESSAGE as a
 * pathspec: the operation then looks narrowly scoped to a file called "sweep", the foreign-state check
 * finds no intersection, and a commit that would publish someone else's staged work is allowed. The
 * union across subcommands is used deliberately — a value mistaken for a path is the dangerous
 * direction, and treating one extra token as an option value only ever makes a command look broader.
 */
const VALUE_OPTS = new Set([
  '-m', '--message', '-F', '--file', '-C', '--reuse-message', '-c', '--reedit-message',
  '--author', '--date', '--cleanup', '-t', '--template', '--trailer', '--fixup', '--squash',
  '--pathspec-from-file', '--chmod', '-S', '--gpg-sign', '-u', '--untracked-files',
  '-b', '-B', '--orphan', '--track', '--conflict', '--source', '-s', '--strategy', '--exclude',
  '--exclude-per-directory', '--directory', '-p', '--unidiff-zero', '--build-fake-ancestor',
]);

/*
 * ⛔ COMBINED SHORT OPTIONS. `-qm` is `-q -m`, and its FOLLOWING token is the message. Matching only
 * the standalone `-m` made `git commit -qm "sweep"` look like a commit of a path called "sweep".
 * Only the LAST character of a cluster can consume the next token — a value-taking option earlier in
 * the cluster would take the REST OF THE CLUSTER as its value, which introduces no pathspec either way.
 */
const SHORT_VALUE = new Set([...VALUE_OPTS].filter((o) => /^-[A-Za-z]$/.test(o)).map((o) => o[1]));

/**
 * Positional (non-option) TOKENS, with option values removed.
 *
 * ⛔ Returns tokens, not strings. A pathspec's `dynamic` flag decides whether it may be treated as the
 * path it spells at all, and stripping it here is how `git add -- "$FILE"` was compared against a file
 * literally named `$FILE`.
 */
function positionals(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const t = args[i].value;
    if (isOpt(t)) {
      if (t.includes('=')) continue;
      if (VALUE_OPTS.has(t)) { i += 1; continue; }
      const cluster = /^-([A-Za-z]{2,})$/.exec(t);
      if (cluster && SHORT_VALUE.has(cluster[1].slice(-1))) i += 1;
      continue;
    }
    out.push(args[i]);
  }
  return out;
}

/** Does a short-option cluster or a long option carry this letter/name? `-qim` contains `-i`. */
function hasShort(flags, letter) {
  return flags.some((f) => /^-[A-Za-z]+$/.test(f) && f.slice(1).includes(letter));
}

/**
 * Options that are genuinely OPTIONS — with the tokens consumed as option VALUES removed.
 *
 * ⛔ `flagsOf()` RETURNS EVERY TOKEN STARTING WITH `-`, INCLUDING VALUES. Git's option parser accepts a
 * value that begins with a dash, so `git commit -m --dry-run` is a commit whose MESSAGE is the string
 * `--dry-run` — and the dry-run exemption read that value as a flag, classified the command as changing
 * nothing, and let it commit the human's staged work with no lease, no foreign-state check, no wave
 * check and no ownership record. From a worktree it reached the orchestrator's index the same way,
 * because `mutates:false` returns before the subagent boundary is even consulted.
 *
 * Any flag whose meaning changes an operation's SCOPE must be read from here, never from `flagsOf`.
 */
function realFlags(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const t = args[i].value;
    if (t === '--') break;                       // everything after is a pathspec
    if (!isOpt(t)) continue;
    out.push(t);
    if (t.includes('=')) continue;
    if (VALUE_OPTS.has(t)) { i += 1; continue; } // skip the VALUE, whatever it looks like
    const cluster = /^-([A-Za-z]{2,})$/.exec(t);
    if (cluster && SHORT_VALUE.has(cluster[1].slice(-1))) i += 1;
  }
  return out;
}

/**
 * Split arguments at the `--` boundary. Only what follows it is a pathspec beyond doubt; that is
 * precisely why the sweeping rules below demand it.
 */
function atDoubleDash(args) {
  const values = args.map((a) => a.value);
  const dd = values.indexOf('--');
  return {
    hasDoubleDash: dd >= 0,
    before: dd >= 0 ? args.slice(0, dd) : args,
    after: dd >= 0 ? args.slice(dd + 1) : [],
  };
}

const nonOptions = (args) => positionals(args);
const flagsOf = (args) => args.filter((a) => isOpt(a.value)).map((a) => a.value);

// --- repository coordinates -----------------------------------------------------------------------

const rootCache = new Map();

/** The absolute top level of the working tree a command run in `dir` belongs to, or null. */
function repoRootOf(dir) {
  const key = String(dir || '.');
  if (rootCache.has(key)) return rootCache.get(key);
  let root = null;
  try {
    const out = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: key, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (out) root = path.resolve(out);
  } catch { /* not a repository, or git unavailable */ }
  rootCache.set(key, root);
  return root;
}

const posix = (p) => String(p).replace(/\\/g, '/');

/*
 * Canonicalise the part of a path the filesystem can currently prove, while preserving an absent
 * suffix. This is not cosmetic on Windows: os.tmpdir() may spell the caller's cwd through an 8.3
 * alias (`RUNNER~1`) while Git reports the same worktree through its long name (`runneradmin`). A
 * lexical `path.relative(longRoot, shortCwd/file)` then says an in-repository file is outside.
 *
 * The nearest-existing-ancestor rule also keeps the correction fail-closed. Canonicalising only the
 * cwd would allow `inside/symlink-to-outside/new.txt` to retain its innocent lexical spelling when the
 * final file does not exist. The literal walker below refuses that non-portable intermediate link
 * before appending the missing suffix.
 */
function canonicalNearest(candidate) {
  let probe = path.resolve(candidate);
  const missing = [];
  for (;;) {
    try {
      const real = fs.realpathSync.native ? fs.realpathSync.native(probe) : fs.realpathSync(probe);
      return path.resolve(real, ...missing.reverse());
    } catch {
      // If the path exists but realpath cannot resolve it (permission fault, dangling intermediate
      // link, transient filesystem error), climbing above it would turn uncertainty into containment.
      try { fs.lstatSync(probe); return null; }
      catch (e) {
        if (!e || !['ENOENT', 'ENOTDIR'].includes(e.code)) return null;
      }
      const parent = path.dirname(probe);
      if (parent === probe) return null;
      missing.push(path.basename(probe));
      probe = parent;
    }
  }
}

/* Return the directory-entry spelling for `probe` without following a final symlink. An identity match
 * maps a Windows 8.3 basename back to the long name Git records. Ambiguous hard-link identities fail
 * closed rather than selecting an unrelated entry. */
function canonicalEntry(probe, st) {
  const parent = path.dirname(probe);
  const raw = path.basename(probe);
  let names;
  try { names = fs.readdirSync(parent); } catch { return null; }
  const bySpelling = names.filter((name) => process.platform === 'win32'
    ? name.toLowerCase() === raw.toLowerCase()
    : name === raw);
  if (bySpelling.length === 1) return path.join(parent, bySpelling[0]);
  const byIdentity = names.filter((name) => {
    try {
      const candidate = fs.lstatSync(path.join(parent, name));
      return candidate.dev === st.dev && candidate.ino === st.ino;
    } catch { return false; }
  });
  return byIdentity.length === 1 ? path.join(parent, byIdentity[0]) : null;
}

/* Git's index is the authority for a path absent from disk. A vanished tracked directory still names
 * every tracked descendant (`git add -- gone` stages all their deletions), so it is sweeping. Read the
 * index once per hook process, both to avoid one subprocess per absent path and to compare literal
 * strings: feeding a normalized filename like `:(top)gone` back through Git's pathspec parser would
 * reinterpret a real name as magic and could falsely report no descendants. */
const trackedCache = new Map();
// ⛔ maxBuffer is load-bearing (see secret-scan.js for the full account). This is the whole tracked-path
// list; at Node's 1 MiB default a repository of ~15k files overflowed with ENOBUFS, and every absent
// pathspec in it classified as sweeping because "Git could not establish" what it named. Bounded rather
// than Infinity so a hostile index exhausts the buffer, not the heap.
const GIT_MAX_BUFFER = 256 * 1024 * 1024;
function trackedPaths(root) {
  if (trackedCache.has(root)) return trackedCache.get(root);
  let result;
  try {
    const out = execFileSync('git', ['ls-files', '-z'], {
      cwd: root, encoding: 'utf8', maxBuffer: GIT_MAX_BUFFER, stdio: ['ignore', 'pipe', 'ignore'],
    });
    result = { ok: true, paths: out.split('\u0000').filter(Boolean).map(posix) };
  } catch { result = { ok: false, paths: [] }; }
  trackedCache.set(root, result);
  return result;
}
function classifyAbsentInIndex(root, rel) {
  const tracked = trackedPaths(root);
  if (!tracked.ok) return null;
  const literal = posix(rel).replace(/\/$/, '');
  const fold = (p) => process.platform === 'win32' ? p.toLowerCase() : p;
  const wanted = fold(literal);
  const exact = tracked.paths.filter((p) => fold(p) === wanted);
  const prefix = `${wanted}/`;
  return {
    exact: exact.length === 1 ? exact[0] : null,
    ambiguous: exact.length > 1,
    descendants: tracked.paths.some((p) => fold(p).startsWith(prefix)),
  };
}

/*
 * Git stages a final symlink as the named index entry; it does not stage that link's target. Walk the
 * literal one component at a time so normal components get their canonical long spelling without
 * translating a link into its target's DIFFERENT index coordinate. A link with descendants is
 * conservatively sweeping: Git-for-Windows junction traversal and POSIX symlink rejection do not share
 * one portable pathspec meaning. Missing outputs preserve their suffix below the proven parent.
 */
function canonicalLiteral(candidate) {
  const abs = path.resolve(candidate);
  const parsed = path.parse(abs);
  const parts = abs.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root;
  for (let i = 0; i < parts.length; i++) {
    const probe = path.join(current, parts[i]);
    let st;
    try { st = fs.lstatSync(probe); }
    catch (e) {
      if (!e || !['ENOENT', 'ENOTDIR'].includes(e.code)) return { why: `"${candidate}" could not be canonicalized through an existing ancestor` };
      return { path: path.resolve(current, ...parts.slice(i)) };
    }
    if (st.isSymbolicLink()) {
      const entry = canonicalEntry(probe, st);
      if (!entry) return { why: `"${candidate}" has an ambiguous final filesystem entry` };
      if (i !== parts.length - 1) return { why: `"${candidate}" traverses a symbolic link or junction, whose Git index coordinate is not portable` };
      return { path: entry };
    }
    current = canonicalNearest(probe);
    if (!current) return { why: `"${candidate}" could not be canonicalized through an existing ancestor` };
  }
  return { path: current };
}

/**
 * Resolve ONE literal pathspec, written relative to `dir`, into a repository-root-relative path.
 * Returns {path} for an exact single file, or {sweeping, why} for anything that can match more than
 * the one thing it spells.
 */
function normalizePathspec(dir, root, spec) {
  const s = String(spec);
  if (!root) return { sweeping: true, why: 'the repository root could not be resolved, so the path could not be placed' };
  if (s === '') return { sweeping: true, why: 'an empty pathspec matches everything' };
  if (s === '-') return { sweeping: true, why: 'a "-" pathspec reads paths from stdin, which is not visible here' };
  // ⛔ Pathspec MAGIC re-bases or negates the match: `:/x` is root-relative, `:(top)x` likewise,
  // `:(glob)*.x` globs, `:!x` and `:^x` EXCLUDE and therefore select everything else.
  if (s.startsWith(':')) return { sweeping: true, why: `pathspec magic ("${s}") selects by rule rather than by name` };
  if (/[*?[\]]/.test(s)) return { sweeping: true, why: `a wildcard pathspec ("${s}") matches paths it does not spell` };

  // Compare canonical filesystem spellings, not aliases. The target itself may be absent, so resolve
  // through its nearest existing ancestor rather than silently falling back to lexical containment.
  const canonicalRoot = canonicalNearest(root);
  const canonicalDir = canonicalNearest(dir);
  if (!canonicalRoot || !canonicalDir) return { sweeping: true, why: 'the repository or working directory could not be canonicalized' };
  const literal = canonicalLiteral(path.resolve(canonicalDir, s));
  if (!literal.path) return { sweeping: true, why: literal.why };
  const abs = literal.path;
  const rel = posix(path.relative(canonicalRoot, abs));
  if (rel === '') return { sweeping: true, why: 'the repository root itself is a directory pathspec' };
  if (rel.startsWith('../') || rel === '..' || path.isAbsolute(rel)) return { sweeping: true, why: `"${s}" resolves outside the repository` };
  if (/\/$/.test(s) || s === '.' || s === './') return { sweeping: true, why: `"${s}" is a directory, and a directory pathspec stages everything beneath it` };
  let coordinate = rel;
  try {
    const st = fs.lstatSync(abs);
    if (st.isDirectory()) return { sweeping: true, why: `"${s}" is a directory, and a directory pathspec stages everything beneath it` };
    if (st.isSymbolicLink()) {
      // Windows junctions are directory pathspecs even though lstat exposes their reparse/link bit.
      // stat follows only for this type check; canonical coordinates above never adopt the target path.
      try {
        if (fs.statSync(abs).isDirectory()) return { sweeping: true, why: `"${s}" is a directory junction, and a directory pathspec stages everything beneath it` };
      } catch {
        // POSIX Git stages a dangling final symlink as one link entry. Windows exposes several reparse
        // types through the same API, so an uninspectable final link cannot prove it is not a junction.
        if (process.platform === 'win32') return { sweeping: true, why: `"${s}" is an uninspectable Windows link or junction` };
      }
    }
  } catch (e) {
    if (!e || !['ENOENT', 'ENOTDIR'].includes(e.code)) return { sweeping: true, why: `"${s}" could not be inspected to determine whether it is a directory pathspec` };
    const tracked = classifyAbsentInIndex(canonicalRoot, rel);
    if (tracked === null) return { sweeping: true, why: `"${s}" is absent and Git could not establish whether it names tracked entries` };
    if (tracked.ambiguous) return { sweeping: true, why: `"${s}" ambiguously matches more than one tracked path` };
    if (tracked.descendants) return { sweeping: true, why: `"${s}" is an absent tracked directory, and the pathspec stages every deletion beneath it` };
    // Git for Windows preserves the index's long/case spelling when an absent tracked file is named
    // through an alias. Compare foreign ownership in that same coordinate, not the caller's spelling.
    if (tracked.exact) coordinate = tracked.exact;
  }
  return { path: coordinate };
}

/**
 * Resolve every pathspec, or report the first one that sweeps.
 *
 * ⛔ A DYNAMIC PATHSPEC IS SWEEPING, not a file with a funny name. `git add -- "$FILE"`,
 * `git add -- {A,B}.txt` and `git add -- ~/notes.md` all name something decided after this hook has
 * finished; conservatively assuming they may touch anything is the only reading that cannot be wrong
 * in the dangerous direction. On a clean index this costs nothing — sweeping only refuses when there
 * is foreign staged state to protect or a wave in flight.
 */
function resolveSpecs(cmd, specs) {
  /*
   * ⛔ A PATHSPEC-MODE GLOBAL MAKES EVERY PATHSPEC MATCH BY A DIFFERENT RULE. `--icase-pathspecs` turns
   * a literal-looking `a.txt` into a case-insensitive match that finds a foreign staged `A.txt`, and
   * `--glob-pathspecs` turns every spec into a wildcard. The magic spellings (`:(icase)`, `:(glob)`)
   * were already refused; the global spellings reached the same behavior through an option this parser
   * skipped. Any mode other than the default — or an explicit `--literal-pathspecs`, which IS the
   * default — means the names below are not the paths this command will touch.
   */
  if (cmd.pathspecMode && cmd.pathspecMode !== 'literal-pathspecs') {
    return { sweeping: true, paths: [], why: `git --${cmd.pathspecMode} changes how EVERY pathspec matches, so a named path is not the path it will touch` };
  }
  const root = repoRootOf(cmd.dir);
  const out = [];
  for (const s of specs) {
    if (s && s.dynamic) {
      return { sweeping: true, paths: [], why: `the pathspec "${s.value}" is expanded at run time, so which paths it names is not knowable here` };
    }
    const r = normalizePathspec(cmd.dir, root, s && s.value !== undefined ? s.value : s);
    if (r.sweeping) return { sweeping: true, paths: [], why: r.why };
    out.push(r.path);
  }
  return { sweeping: false, paths: out, why: null };
}

/** `--pathspec-from-file` (either spelling) hands git a list this parser never sees. */
const readsPathspecFile = (flags) => flags.some((f) => /^--pathspec-from-file(=|$)/.test(f) || f === '--pathspec-file-nul');

// --- classification -------------------------------------------------------------------------------

/**
 * Classify one parsed git command.
 * Returns { mutates, sweeping, paths, why } — `mutates` means "would change the index, or change what
 * the index means", `paths` are repository-root-relative, and `sweeping` means the operation may touch
 * paths it did not name, so a foreign-state check must consider EVERY staged entry rather than an
 * intersection.
 */
/*
 * ⛔ `classify` TAKES NO REPOSITORY LOOKUP ANY MORE (M.2). It used to accept `opts.resolvesToHead`
 * so index-guard could try to prove a particular checkout/switch transition neutral. Six rounds of
 * adversarial review, plus an independent external gate, established that the proof is not available
 * from a command line — every version of it was true for the spellings its author imagined and false
 * for the next one. The optimization is gone rather than refined; see the checkout/switch block.
 */
function classify(cmd) {
  const sub = cmd.gitSub;
  if (!sub) return { mutates: false, sweeping: false, paths: [], why: 'no subcommand' };

  if (sub === 'symbolic-ref') {
    const flags = flagsOf(cmd.args);
    const pos = nonOptions(cmd.args);
    const deletes = flags.some((f) => f === '-d' || f === '--delete');
    const query = !deletes && pos.length <= 1;
    return {
      mutates: !query,
      // Repointing HEAD does not edit an index entry; it changes the commit every staged entry would be
      // recorded against, which is a whole-index effect and cannot be scoped to a path.
      sweeping: !query, paths: [],
      why: query ? 'symbolic-ref query' : 'symbolic-ref SETS or DELETES the ref every staged entry is measured against',
    };
  }

  if (READONLY_SUBS.has(sub)) return { mutates: false, sweeping: false, paths: [], why: 'does not touch the index' };

  if (ARG_SCOPED_SUBS[sub]) {
    const spec = ARG_SCOPED_SUBS[sub];
    const pos = nonOptions(cmd.args);
    const first = pos.length && !pos[0].dynamic ? pos[0].value : null;
    const readOnly = first === null ? spec.defaultReadOnly && pos.length === 0 : spec.readOnly.has(first);
    if (readOnly) return { mutates: false, sweeping: false, paths: [], why: `${sub} ${first || ''} is a query` };
    return { mutates: true, sweeping: true, paths: [], why: `${sub} ${first || ''} may rewrite index state wholesale` };
  }

  /*
   * ⛔ A DRY RUN CHANGES NOTHING — BUT `-n` IS NOT ALWAYS `--dry-run`, AND ON `commit` IT IS
   * `--no-verify`. The first cut of this exemption accepted `-n` for commit/add/rm/mv alike, so
   * `git commit -n -m x` was classified as changing nothing: it took no lease, ran no foreign-state
   * check, skipped the wave check, recorded no ownership — and then committed the human's staged work.
   * A worktree subagent could aim it at the orchestrator's index with `git -C <main> commit -n`, which
   * the same classification waved through as harmless. The short spelling is honoured only where git
   * actually means it, and the long form is honoured everywhere.
   */
  const dryRunFlags = realFlags(cmd.args);
  const isDryRun = dryRunFlags.includes('--dry-run')
    || (sub !== 'commit' && (dryRunFlags.includes('-n') || hasShort(dryRunFlags, 'n')));
  if (isDryRun && (sub === 'commit' || sub === 'add' || sub === 'rm' || sub === 'mv')) {
    return { mutates: false, sweeping: false, paths: [], why: `${sub} --dry-run reports what it would do and changes nothing` };
  }

  const { hasDoubleDash, before, after } = atDoubleDash(cmd.args);
  const flags = flagsOf(cmd.args);
  const beforePaths = nonOptions(before);
  const fromFile = readsPathspecFile(flags);

  if (sub === 'add') {
    // `git add` takes only pathspecs — no revision ambiguity — so tokens on either side count.
    const specs = [...beforePaths, ...after];
    const broadFlag = flags.some((f) => /^--(all|update)$/.test(f) || /^-[A-Za-z]*[Au]/.test(f));
    if (broadFlag || fromFile || specs.length === 0) {
      return {
        mutates: true, sweeping: true, paths: [],
        why: fromFile ? 'the pathspec list is read from a file this parser never sees' : 'stages beyond named paths',
      };
    }
    const r = resolveSpecs(cmd, specs);
    return { mutates: true, sweeping: r.sweeping, paths: r.paths, why: r.sweeping ? `stages beyond named paths: ${r.why}` : 'stages named paths' };
  }

  if (sub === 'rm' || sub === 'mv') {
    // mv's SOURCE and DESTINATION both touch the index, so both are protected paths.
    const specs = [...beforePaths, ...after];
    if (fromFile || specs.length === 0) return { mutates: true, sweeping: true, paths: [], why: `${sub} with no resolvable pathspec list` };
    const r = resolveSpecs(cmd, specs);
    return { mutates: true, sweeping: r.sweeping, paths: r.paths, why: r.sweeping ? `${sub} beyond named paths: ${r.why}` : `${sub} rewrites the named index entries` };
  }

  if (sub === 'commit') {
    const specs = [...beforePaths, ...after];
    const all = flags.some((f) => f === '--all') || hasShort(flags, 'a');
    /*
     * ⛔ `--include` / `-i` MEANS "THESE PATHS *IN ADDITION TO* WHAT IS ALREADY STAGED". It looks like
     * the scoped form and is its opposite: a pathspec commit normally publishes only the named paths,
     * while `git commit --include -- B.txt` publishes B AND every other staged entry. Confirmed against
     * real git in a disposable repository: with a human's `A.txt` staged, that command committed
     * A.txt and B.txt both. Classifying it by its pathspec was a scoped reading of a sweeping command —
     * the single most dangerous direction for this whole file to be wrong in.
     *
     * `--only` / `-o` is the genuinely scoped spelling and stays scoped.
     */
    const includes = flags.some((f) => f === '--include') || hasShort(flags, 'i');
    /*
     * ⛔ AND SO DO `-p` / `--patch` / `--interactive`, WHICH THE `--include` FIX MISSED. They open the
     * interactive staging UI; with stdin at EOF — which is every agent invocation — git falls through
     * and commits THE WHOLE INDEX, pathspec or no pathspec. Verified against real git: with a human's
     * `A.txt` staged, `git commit -m x --interactive -- B.txt` committed A.txt and left B untouched.
     * `-p` was doubly invisible: it sits in VALUE_OPTS (for `git apply -p<n>`) so it silently ate the
     * following token as well. Same "looks scoped, acts sweeping" family, same dangerous direction.
     */
    const interactive = flags.some((f) => f === '--patch' || f === '--interactive') || hasShort(flags, 'p');
    if (all || includes || interactive || fromFile || specs.length === 0) {
      return {
        mutates: true, sweeping: true, paths: [],
        why: all ? 'commits every tracked change, staged or not'
          : includes ? '--include/-i commits the named paths IN ADDITION TO everything already staged'
            : interactive ? '--patch/-p/--interactive opens interactive staging, and with stdin at EOF git commits the WHOLE index regardless of any pathspec'
              : 'commits everything staged',
      };
    }
    const r = resolveSpecs(cmd, specs);
    return { mutates: true, sweeping: r.sweeping, paths: r.paths, why: r.sweeping ? `commits beyond named paths: ${r.why}` : 'commits named paths only' };
  }

  /*
   * ⛔ THE AMBIGUOUS FAMILY. Each of these accepts a revision OR a pathspec in the same position, and
   * git resolves it by trying the revision first. So a bare token is NOT a path we can protect, and
   * only an explicit `--` boundary proves pathspec mode. Without one: sweeping.
   */
  if (sub === 'reset' || sub === 'restore' || sub === 'checkout' || sub === 'switch') {
    const discards = flags.some((f) => /^(-f|--force|--hard|--discard-changes|--merge|-m|--theirs|--ours)$/.test(f));

    /*
     * ⛔ THE NEUTRALITY OPTIMIZATION IS DELETED. THIS IS M.2, AND IT IS A SUBTRACTION.
     *
     * Six rounds tried to prove a particular checkout/switch transition harmless, each proxy closer
     * than the last, each defeated by a spelling nobody had thought of:
     *
     *   M.1e  "creating or moving to a branch does not rewrite the index"  → -B/-C/--orphan
     *   M.1g  does the token LOOK like a revision (a regex)                → a tag is spelled like a branch
     *   M.1h  does it RESOLVE to a local branch (a repository lookup)      → a branch switch does the harm too
     *   M.1i  does HEAD's commit move AND stay attached                    → still an enumeration underneath
     *
     * An independent external gate then reproduced four NEW false allows through the real hook, in one
     * pass, against a 216-test green suite — from a worktree subagent aimed at the orchestrator:
     *     git -C <main> checkout --orphan=evil     git -C <main> switch -d
     *     git -C <main> switch   --orphan=evil     git -C <main> switch -d main
     * Measured before this was written: git ACCEPTS `--orphan=<name>`; it unparents HEAD and stages the
     * entire tree (`git diff --cached` went from empty to the whole worktree). `switch -d` succeeds and
     * leaves HEAD detached. The suite was green because it covered `--orphan <name>` and `--detach` —
     * the two spellings someone happened to write down.
     *
     * ⭐ SO THE RULE IS STRUCTURAL, AND THERE IS NOTHING LEFT TO SPELL AROUND. Every `git checkout` or
     * `git switch` WITHOUT an explicit `-- <pathspec>` is HEAD/index-affecting and sweeping. Branch
     * switches, branch creation, detach forms, orphan forms, tracking forms, `-`, dynamic targets,
     * option abbreviations, attached option values, and any option git adds after this was written —
     * all one case. The classifier no longer asks what the transition is, because six rounds of
     * evidence say that question cannot be answered from a command line, and each attempt to answer it
     * shipped a guarantee that was false for inputs its author had not imagined.
     *
     * ⛔ THE ERROR DIRECTION IS NOW CHOSEN ON PURPOSE, and "sweeping" is not "denied". It costs a
     * refusal only where protected state or concurrency actually exists:
     *   · clean index, no wave                    → allowed (takes the lease, like any mutation)
     *   · staged work this session owns           → allowed
     *   · an agent's own worktree                 → allowed, under that worktree's lease
     *   · SOMEONE ELSE'S staged work             → refused
     *   · during an active parallel wave          → refused as sweeping
     *   · a subagent aiming at another index      → refused
     *   · `git checkout HEAD -- src/a.ts`         → path-scoped, unchanged
     * `restore` and `reset` keep their separately tested path semantics below; only the HEAD-transition
     * family loses its exemption, because only that family was where the exemption was unsound.
     */
    if ((sub === 'checkout' || sub === 'switch') && !hasDoubleDash) {
      return {
        mutates: true,
        sweeping: true,
        paths: [],
        why: `${sub} without an explicit "-- <path>" is a HEAD transition, which changes what every staged entry means`,
      };
    }
    // `git restore --staged <path>` names its paths without `--` and unstages exactly those. Treating
    // it as sweeping refused an everyday correction of the session's OWN staging.
    if (sub === 'restore' && !hasDoubleDash && !discards && !fromFile && beforePaths.length) {
      const r0 = resolveSpecs(cmd, beforePaths);
      if (!r0.sweeping) {
        return { mutates: true, sweeping: false, paths: r0.paths, why: 'restore scoped to the paths it names' };
      }
    }
    /*
     * ⛔ `git checkout <rev> -- <path>` IS A PATHSPEC OPERATION, NOT A BRANCH SWITCH. An earlier rule
     * declared any checkout/switch with tokens before `--` sweeping "because a branch-changing checkout
     * sweeps regardless of a trailing pathspec" — but git itself never switches branches when a
     * pathspec is present, so `git checkout HEAD -- seed.txt` was refused as though it rewrote the whole
     * index. With `--` and paths after it, the leading token is a REVISION and the operation is scoped.
     */
    const scoped = hasDoubleDash && after.length > 0 && !discards && !fromFile;
    const r = scoped ? resolveSpecs(cmd, after) : { sweeping: true, paths: [], why: null };
    return {
      mutates: true,
      sweeping: !scoped || r.sweeping,
      paths: scoped && !r.sweeping ? r.paths : [],
      why: scoped && !r.sweeping
        ? `${sub} scoped by an explicit -- pathspec`
        : `${sub} may rewrite the whole index: ${r.why || (discards ? 'a discard/force flag is present' : 'no explicit -- pathspec boundary, so a revision or branch cannot be told from a path')}`,
    };
  }

  if (sub === 'apply') {
    const touchesIndex = flags.some((f) => f === '--cached' || f === '--index' || f === '-3' || f === '--3way');
    return {
      mutates: touchesIndex,
      sweeping: touchesIndex, // the patch names its own paths; we do not parse it, so assume any
      paths: [],
      why: touchesIndex ? 'a patch may touch any path; its contents are not parsed' : 'apply to the working tree only',
    };
  }

  if (sub === 'merge' || sub === 'rebase' || sub === 'cherry-pick' || sub === 'revert' || sub === 'am' || sub === 'pull') {
    return { mutates: true, sweeping: true, paths: [], why: `${sub} rewrites index state wholesale` };
  }

  // Unknown subcommand or alias — arbitrary configured behavior.
  return { mutates: true, sweeping: true, paths: [], why: `"${sub}" is not a known read-only subcommand; an unrecognised subcommand or alias is never assumed harmless` };
}

/**
 * ⭐ THE ONE INTERSECTION. Both the PreToolUse policy pass and the recheck taken under the writer lease
 * call this. They used to carry separate expressions, and the second was narrower — it compared exact
 * paths only, so a rename source or a directory prefix that the first pass had caught could slip
 * through the second. Two spellings of one rule is one rule that is sometimes not enforced.
 */
function intersectForeign(foreign, cls) {
  const states = foreign || [];
  if (cls.sweeping) return states;
  const named = new Set((cls.paths || []).map(posix));
  if (!named.size) return [];
  const prefixes = [...named].map((n) => `${n.replace(/\/+$/, '')}/`);
  return states.filter((f) => named.has(f.path)
    || (f.from && named.has(f.from))
    || prefixes.some((p) => f.path.startsWith(p) || (f.from && f.from.startsWith(p))));
}

/*
 * ⛔ `sharedReadOnlyGit()` USED TO LIVE HERE AND IS DELETED, NOT DEPRECATED. It answered "is this git
 * command safe for a subagent sharing the orchestrator's checkout", which was only ever askable because
 * such a subagent could run Bash at all. M.1c removed that allowance (see index-guard.js), so the
 * function had no caller — and a validator with no caller, still exercised by tests, is precisely the
 * "dead code standing in for enforcement" shape this pack has shipped before. The boundary it guarded
 * is now structural: no shell, no question.
 */

module.exports = {
  classify, intersectForeign, normalizePathspec, repoRootOf, positionals, hasShort,
  READONLY_SUBS, ARG_SCOPED_SUBS, atDoubleDash,
};
