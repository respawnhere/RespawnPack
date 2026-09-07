/*
 * RespawnPack · hooks/_manifest.js — the source-input manifest shared by the state compiler (writer)
 * and the boot path (reader), and — for the same reason, in the same place — the one definition of
 * which revisions describe the same source (`sourceRevisions`, at the bottom of this file).
 *
 * NOT A HOOK (leading underscore — the counts fence excludes these).
 *
 * ⛔ WHY CONTENT DIGESTS AND NOT JUST A REVISION. `sourceRevision === HEAD` answers "has anyone
 * committed since this was compiled?" — which is not the question. Every input to this compiler is a
 * file a person edits BEFORE committing: requirements.json, the goal contract, evidence artifacts, the
 * validator declarations. A projection can therefore be declared CURRENT while its own source has
 * already changed underneath it, and then a session boots on a count that is provably wrong. That is
 * the confident-stale-number failure this whole program exists to end, wearing a new hat.
 *
 * ⛔ WHY IT LIVES HERE, OF ALL PLACES. The writer is kernel/lib/state.js and the reader is
 * hooks/_runtime.js — two different directories in the pack AND two different directories once
 * installed (.claude/respawnpack/lib/ and .claude/hooks/). Duplicating the digest logic would let the
 * two halves drift, and a freshness check whose halves disagree is worse than none. This path is the
 * one location both resolve identically:
 *     pack:      kernel/lib/state.js            → ../../hooks/_manifest.js
 *     installed: .claude/respawnpack/lib/state.js → ../../hooks/_manifest.js
 * One module, one definition of "changed".
 *
 * ABSENCE IS PART OF THE MANIFEST. A missing input records the literal string 'ABSENT' rather than
 * being skipped, so *adding* requirements.json to a project that had none is itself a change. A file
 * that exists but cannot be read records 'UNREADABLE', which the comparison treats as undecidable —
 * never as "same as before".
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ABSENT = 'ABSENT';
const UNREADABLE = 'UNREADABLE';

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const posix = (p) => String(p).replace(/\\/g, '/');
const portableAbsolute = (p) => path.isAbsolute(p) || /^[A-Za-z]:[\\/]/.test(p) || /^[\\/]/.test(p);
const inside = (root, candidate) => {
  const rel = path.relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
};
function containedResolution(projectDir, candidate) {
  const project = path.resolve(projectDir);
  const abs = path.resolve(candidate);
  if (!inside(project, abs)) return false;
  let realProject;
  try { realProject = fs.realpathSync(project); } catch { return false; }
  let probe = abs;
  for (;;) {
    try { fs.lstatSync(probe); break; }
    catch (e) {
      if (!e || e.code !== 'ENOENT') return false;
      const parent = path.dirname(probe);
      if (parent === probe) return false;
      probe = parent;
    }
  }
  let realProbe;
  try { realProbe = fs.realpathSync(probe); } catch { return false; }
  return inside(realProject, path.resolve(realProbe, path.relative(probe, abs)));
}

/*
 * Named once because three things now have to agree on it: the input list below, the v2 digest rule
 * further down, and `compareManifest`'s v1 clause. Two of those decide whether a target reads CURRENT.
 */
const CONFIG_REL = 'respawnpack.config.json';

/** Every file whose contents can change the compiled result. Order is irrelevant; keys are sorted. */
const INPUT_FILES = [
  path.join('docs', 'derived', 'state', 'requirements.json'),
  path.join('docs', 'derived', 'state', 'goal.json'),
  // The killed-feature registry (Scenario L). Editing a removal changes what the compiled state asserts
  // about the project's negative knowledge, so it is revision- AND content-bound like every other input.
  // The SCANNED CORPUS is deliberately not here: it has its own manifest inside the removal verdict, so
  // editing a doc invalidates that verdict without invalidating the row counts beside it.
  path.join('docs', 'derived', 'state', 'removals.json'),
  // The provenance declaration (Class D). Editing a source or a derivation changes what the compiled
  // state asserts about where this project's copies came from, so it is revision- AND content-bound
  // like every other input. The DERIVED FILES it names are deliberately not here, for the reason the
  // removal corpus is not: they have their own verification inside the verdict, and editing one must
  // not invalidate the counts beside it.
  path.join('docs', 'derived', 'state', 'lineage.json'),
  CONFIG_REL, // carries the validator adapter declarations the savepoint run executes
];
const INPUT_DIRS = [path.join('docs', 'derived', 'state', 'evidence')];

function digestFile(abs) {
  try { return sha256(fs.readFileSync(abs)); }
  catch (e) { return e && e.code === 'ENOENT' ? ABSENT : UNREADABLE; }
}

/**
 * A directory's digest folds in each entry's NAME and CONTENT, sorted. Name inclusion is what makes an
 * added or removed artifact register: two evidence files that swap contents, or one that vanishes,
 * must not produce the same digest as before.
 */
function digestDir(abs) {
  let names;
  try { names = fs.readdirSync(abs).filter((n) => !n.startsWith('.')).sort(); }
  catch (e) { return e && e.code === 'ENOENT' ? ABSENT : UNREADABLE; }
  const lines = [];
  for (const n of names) {
    const d = digestFile(path.join(abs, n));
    if (d === UNREADABLE) return UNREADABLE;
    lines.push(`${n}:${d}`);
  }
  return sha256(lines.join('\n'));
}

/** Deterministic manifest of every compiler input, relative-path keyed with forward slashes. */
/*
 * ⛔ THE REGISTRY PATH IS CONFIGURABLE, SO THE FIXED ENTRY ABOVE IS NOT ENOUGH ON ITS OWN.
 * `state.removals.registry` may point anywhere — the schema says so and `readConfig` honours it — but
 * this manifest hashed only the DEFAULT path. A project using a custom registry therefore edited its
 * killed-feature rows with the freshness check still reporting CURRENT, so boot presented stale
 * negative knowledge as verified. Read the declared path out of the config and hash THAT too; the
 * default stays in the list so a target that has both is bound to both, and a config that is missing
 * or unparseable simply contributes nothing rather than throwing inside a digest routine.
 */
function configuredRegistryRel(dir) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'respawnpack.config.json'), 'utf8'));
    const removals = ((cfg || {}).state || {}).removals;
    const p = removals && typeof removals.registry === 'string' ? removals.registry.trim() : '';
    if (!p || portableAbsolute(p) || posix(p).split('/').includes('..')) return null;
    const project = path.resolve(dir);
    const abs = path.resolve(project, ...posix(p).split('/'));
    const lexical = path.relative(project, abs);
    if (!containedResolution(project, abs)) return null;
    return lexical.replace(/\\/g, '/');
  } catch { return null; }
}

/*
 * ⛔ ONE KEY IN THAT CONFIG IS NOT A COMPILER INPUT, AND EXACTLY ONE (ADR-003).
 * `posture` decides how loudly a rule speaks — which outcome a check returns — and nothing else. No
 * count, no gate verdict, no rendered line moves when it flips. Digesting it made every profile
 * declaration mark STATE.json STALE and withhold every number at the next boot, which punished the
 * founder for a decision the compiler never read. Every OTHER key here IS a compiler input: the
 * validator adapters the savepoint run executes, the registry path resolved above, the quality gate.
 * So this is a fixed list of one name rather than a prefix or a predicate — widening it has to be an
 * argued edit written down here, not something that falls out of a pattern. The nearest bypass is
 * fenced in both suites: a config changing `posture` AND `qualityGate` still digests differently.
 */
const MANIFEST_EXCLUDED = ['posture'];
const MANIFEST_VERSION = 2;

/*
 * ⛔ AND SO THE CONFIG IS DIGESTED CANONICALLY, NOT BY ITS BYTES. Removing a key means re-serializing
 * what is left, and that serialization has to be stable or the digest moves when nothing did: keys
 * sorted at every depth, no whitespace, arrays left in their own order because array order is content.
 * Reformatting the file therefore no longer makes the state stale — a real behaviour change, and the
 * reason the manifest now carries a version rather than quietly changing meaning under recorded ones.
 */
function canonicalJSON(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value === undefined ? null : value);
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJSON(value[k])}`).join(',')}}`;
}

/** The config as an object, or null when it is missing, unreadable, malformed, or not an object. */
function parseConfig(abs) {
  try {
    const cfg = JSON.parse(fs.readFileSync(abs, 'utf8'));
    return cfg && typeof cfg === 'object' && !Array.isArray(cfg) ? cfg : null;
  } catch { return null; }
}

/*
 * v2's digest of respawnpack.config.json.
 *
 * ⛔ AN UNPARSEABLE CONFIG FALLS BACK TO THE RAW BYTES — not to ABSENT, not to a constant. A file no
 * one can parse still has to count as CHANGED the moment somebody edits it: a broken config is exactly
 * the moment a projection must not be able to claim it is fresh. ABSENT and UNREADABLE keep their own
 * meanings from digestFile, so adding the config to a project that had none is still a change and an
 * unreadable one is still undecidable.
 */
function digestConfigFile(abs) {
  const raw = digestFile(abs);
  if (raw === ABSENT || raw === UNREADABLE) return raw;
  const cfg = parseConfig(abs);
  if (!cfg) return raw;
  for (const key of MANIFEST_EXCLUDED) delete cfg[key];
  return sha256(canonicalJSON(cfg));
}

function sourceManifest(dir) {
  const inputs = {};
  for (const rel of INPUT_FILES) {
    const key = rel.replace(/\\/g, '/');
    inputs[key] = key === CONFIG_REL ? digestConfigFile(path.join(dir, rel)) : digestFile(path.join(dir, rel));
  }
  const custom = configuredRegistryRel(dir);
  if (custom && !(custom in inputs)) inputs[custom] = digestFile(path.join(dir, custom));
  for (const rel of INPUT_DIRS) inputs[`${rel.replace(/\\/g, '/')}/`] = digestDir(path.join(dir, rel));
  return { algorithm: 'sha256', manifestVersion: MANIFEST_VERSION, inputs };
}

/**
 * Compare a recorded manifest against the tree now.
 * Three outcomes, deliberately — "I could not check" must never collapse into "unchanged".
 */
function compareManifest(recorded, dir) {
  if (!recorded || typeof recorded !== 'object' || !recorded.inputs || typeof recorded.inputs !== 'object') {
    return { status: 'CANNOT_DETERMINE', detail: 'STATE.json carries no usable sourceManifest — its freshness against the compiler inputs cannot be established' };
  }
  if (recorded.algorithm !== 'sha256') {
    return { status: 'CANNOT_DETERMINE', detail: `unknown manifest algorithm ${JSON.stringify(recorded.algorithm)}` };
  }
  // Same shape as the algorithm guard, and for the same reason: a manifest written by a rule this code
  // does not implement is undecidable, never "unchanged". Absent means v1, which IS implemented below.
  if (recorded.manifestVersion !== undefined && recorded.manifestVersion !== MANIFEST_VERSION) {
    return { status: 'CANNOT_DETERMINE', detail: `unknown manifest version ${JSON.stringify(recorded.manifestVersion)}` };
  }

  const now = sourceManifest(dir);
  /*
   * ⛔ THE v1 COMPATIBILITY CLAUSE, WHICH IS THE ENTIRE REASON THE VERSION FIELD EXISTS.
   *
   * v1 digested the config's RAW BYTES; v2 digests a canonical serialization with MANIFEST_EXCLUDED
   * removed, and those two numbers are never equal — not even for a config that never carried a
   * `posture` key and was never reformatted. Shipping v2 without this clause would therefore re-base
   * every manifest already recorded in the field: at its next boot every installed target would read
   * STALE on respawnpack.config.json, withhold every count, and none of it would describe a change
   * anybody made. So a manifest recorded WITHOUT a version is compared under v1's rule for that one
   * file, and only that file — every other input's rule is identical in both versions. A target keeps
   * today's verdict until its own next `savepoint --write` re-stamps the record at v2.
   */
  if (recorded.manifestVersion === undefined && CONFIG_REL in now.inputs) {
    now.inputs[CONFIG_REL] = digestFile(path.join(dir, CONFIG_REL));
  }
  const unreadable = Object.entries(now.inputs).filter(([, v]) => v === UNREADABLE).map(([k]) => k);
  if (unreadable.length) {
    return { status: 'CANNOT_DETERMINE', detail: `could not read compiler input(s): ${unreadable.join(', ')}` };
  }

  /*
   * ⛔ AN INPUT THIS KERNEL ADDED, THAT THE PROJECT DOES NOT HAVE, IS NOT A CHANGE ANYBODY MADE.
   *
   * The comparison is over the UNION of both key sets, which is what makes an input APPEARING count as
   * a change — the property `ABSENT` exists for. But that same union makes every input this pack adds
   * LATER retroactively stale on every installed target: `docs/derived/state/lineage.json` joined the
   * list above, no target has one, so at the next boot `recorded.inputs[k]` is `undefined`,
   * `now.inputs[k]` is `'ABSENT'`, and every count is withheld over a file that does not exist and never
   * did. That is anti-drift item 6 exactly — a change to the SHAPE of the input list must not change the
   * digest for an unchanged project — and it is the same class of defect as the v1 config clause above,
   * one level out: there, the RULE for a recorded key changed; here, the SET of keys did.
   *
   * So the clause is as narrow as it can be and still work: an unrecorded key compares equal ONLY when
   * its current value is `ABSENT`. The moment the file appears the key is a digest, the union comparison
   * is exactly what it always was, and the target reads STALE — which is the behaviour that makes adding
   * a lineage declaration take effect at the next boot rather than at the next savepoint. Every other
   * combination, including a recorded key that is now ABSENT (the file was DELETED), is untouched.
   */
  const keys = [...new Set([...Object.keys(recorded.inputs), ...Object.keys(now.inputs)])].sort();
  const unrecordedAndAbsent = (k) => !(k in recorded.inputs) && now.inputs[k] === ABSENT;
  const changed = keys.filter((k) => !unrecordedAndAbsent(k) && recorded.inputs[k] !== now.inputs[k]);
  if (changed.length) {
    return {
      status: 'STALE',
      changed,
      detail: `compiler input(s) changed since STATE.json was built: ${changed.join(', ')}`,
    };
  }
  return { status: 'CURRENT', changed: [] };
}

/*
 * A digest map over an ARBITRARY list of relative paths, and its comparison.
 *
 * ⛔ ONE DEFINITION OF "CHANGED", FOR THE SECOND READER TOO. Scenario L's killed-feature verdict is a
 * function of the scanned live-content corpus, which is NOT a compiler input — so it needs its own
 * freshness record, and the writer (kernel/lib/removals.js) and the reader (hooks/_runtime.js at boot)
 * are again in two directories that only meet here. Reimplementing the comparison on either side is how
 * a freshness check ends up with halves that disagree, which is worse than having none.
 */
function digestMap(dir, relPaths) {
  const inputs = {};
  for (const rel of relPaths || []) inputs[String(rel).replace(/\\/g, '/')] = digestFile(path.join(dir, rel));
  return { algorithm: 'sha256', inputs };
}

function compareDigestMap(recorded, dir) {
  if (!recorded || typeof recorded !== 'object' || !recorded.inputs || typeof recorded.inputs !== 'object') {
    return { status: 'CANNOT_DETERMINE', detail: 'no usable digest map — what this verdict described cannot be established' };
  }
  if (recorded.algorithm !== 'sha256') return { status: 'CANNOT_DETERMINE', detail: `unknown manifest algorithm ${JSON.stringify(recorded.algorithm)}` };
  const now = digestMap(dir, Object.keys(recorded.inputs));
  const unreadable = Object.entries(now.inputs).filter(([, v]) => v === UNREADABLE).map(([k]) => k);
  if (unreadable.length) return { status: 'CANNOT_DETERMINE', detail: `could not read: ${unreadable.slice(0, 5).join(', ')}` };
  const changed = Object.keys(recorded.inputs).filter((k) => recorded.inputs[k] !== now.inputs[k]);
  return changed.length
    ? { status: 'STALE', changed, detail: `changed since the verdict was computed: ${changed.slice(0, 5).join(', ')}${changed.length > 5 ? ` (+${changed.length - 5} more)` : ''}` }
    : { status: 'CURRENT', changed: [] };
}

/*
 * ⛔ A SAVEPOINT COMMIT IS NOT A SOURCE CHANGE — AND EVERY READER SAID IT WAS.
 *
 * The documented closeout is three steps: commit the session's work (W), run `savepoint --verify
 * --write`, which binds STATE.json's `sourceRevision` to W, then commit the regenerated derived docs
 * as `docs(savepoint): regen at W` (S). Step three necessarily moves HEAD one commit past the revision
 * the state describes. So a literal `sourceRevision === HEAD` called a state regenerated thirty seconds
 * earlier STALE: SessionStart withheld every count at every boot, the Stop hook demanded the savepoint
 * that had just been committed, and a verify-only run rebound STATE.json to S and dirtied the tree —
 * all over a commit whose diff touched nothing the compiler reads. Observed on a real target on
 * 2026-08-23, at every boot, until the operator ran `git checkout -- docs/derived/STATE.json`.
 *
 * ⭐ SO "THE SAME SOURCE" IS DEFINED HERE, ONCE, FOR EVERY READER. A revision R describes the same
 * source as HEAD when HEAD reaches R by walking back through SAVEPOINT-ONLY commits: single-parent
 * commits whose every changed path is a savepoint output (`docs/derived/**`, `memory/candidates/**`)
 * and none of which is a compiler input (`docs/derived/state/**`). A commit that touches anything else
 * — code, a requirement, an evidence artifact, the config, a merge — ends the walk, and the strict
 * comparison is exactly what it was.
 *
 * ⛔ THE COMPILER INPUTS ARE EXCLUDED EVEN THOUGH THEY LIVE UNDER docs/derived/. A committed edit to
 * requirements.json IS a source change. The content manifest would catch it at boot regardless, but the
 * Stop hook has no manifest, and the one commit it must never wave through is a denominator change
 * nobody re-rendered.
 *
 * ⛔ THE WALK IS BOUNDED, AND TRUNCATION IS STRICT. Every commit the walk classified is genuinely
 * equivalent to HEAD, so the verified prefix is kept in `chain`; but when the bound is hit before a
 * source-bearing commit is found, `effective` falls back to HEAD itself, so a compile binds strictly
 * and a later reader finds that binding inside its own chain. Nothing here can produce CURRENT out of
 * a commit it did not look at.
 *
 * ⛔ IT LIVES HERE FOR THE SAME REASON THE MANIFEST DOES. The compiler (kernel/lib/state.js) binds the
 * revision, the boot path (hooks/_runtime.js) and `status`/`doctor` compare against it, and the Stop
 * hook decides whether a committed savepoint closed the session out. Four readers, two installed
 * directories, one path they all resolve — a second spelling of "what moved" in any of them is how the
 * readers come to disagree about the same commit.
 */
/*
 * ⛔ THE WAVE LEDGER IS ON THIS LIST BECAUSE A SAVEPOINT NOW CARRIES IT AWAY (I-3). `savepoint --write`
 * folds `.respawnpack/wave-ledger.md` into the derived docs and deletes it, so the commit that lands
 * that savepoint's output can carry the ledger's DELETION alongside `docs/derived/**`. Without this
 * entry that commit would end the walk and every reader would call the state it just verified STALE —
 * the exact 2026-08-23 savepoint-revision-lag defect, one path wider. It is an output, never an input:
 * nothing the compiler reads lives here, so adding it cannot make a source change look source-neutral.
 */
const SAVEPOINT_OUTPUT_PREFIXES = ['docs/derived/', 'memory/candidates/', '.respawnpack/wave-ledger.md'];
const COMPILER_INPUT_PREFIX = 'docs/derived/state/';
const SAVEPOINT_CHAIN_LIMIT = 16;

const gitOut = (dir, args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const short = (rev) => String(rev || 'unknown').slice(0, 7);

/** Is this repo-relative path one a savepoint run writes — and not one the compiler reads? */
function isSavepointOutput(rel) {
  const p = posix(rel);
  if (p.startsWith(COMPILER_INPUT_PREFIX)) return false;
  return SAVEPOINT_OUTPUT_PREFIXES.some((prefix) => p.startsWith(prefix));
}

/**
 * One commit's parents and changed paths, and whether it is savepoint-only. `-z` so a path with a
 * space or a non-ASCII byte arrives unquoted — `core.quotePath` would otherwise wrap it in quotes and
 * a prefix test would read a savepoint output as "something else", which is the strict direction but
 * still wrong. An EMPTY diff (`--allow-empty`) changes no source and qualifies.
 */
function commitShape(dir, rev) {
  const parents = gitOut(dir, ['rev-list', '--parents', '-n', '1', rev]).trim().split(/\s+/).slice(1).filter(Boolean);
  if (parents.length !== 1) {
    return { parents, paths: [], outside: [], savepointOnly: false, why: parents.length ? 'a merge commit' : 'a root commit' };
  }
  const paths = gitOut(dir, ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', rev]).split('\0').filter(Boolean);
  const outside = paths.filter((p) => !isSavepointOutput(p));
  const why = outside.length ? `touches ${outside.slice(0, 3).join(', ')}${outside.length > 3 ? ` (+${outside.length - 3} more)` : ''}` : null;
  return { parents, paths, outside, savepointOnly: outside.length === 0, why };
}

/**
 * The revisions that describe the same source as HEAD.
 *
 * @returns {{head: string|null, effective: string|null, chain: string[], savepointOnly: Array<{rev:string,paths:string[]}>, truncated: boolean, detail: string}}
 *   head       `git rev-parse HEAD`, or null (no repository, or no commits yet)
 *   effective  the nearest ancestor of HEAD (inclusive) that is NOT savepoint-only — the revision a
 *              compile binds `sourceRevision` to. Falls back to `head` when the walk was truncated.
 *   chain      `[head, …, effective]`: every revision here describes the same source as HEAD, so a
 *              reader asks `chain.includes(state.sourceRevision)` rather than `=== head`.
 */
function sourceRevisions(dir, opts = {}) {
  const limit = Number.isInteger(opts.limit) && opts.limit >= 0 ? opts.limit : SAVEPOINT_CHAIN_LIMIT;
  let head = null;
  try { head = gitOut(dir, ['rev-parse', 'HEAD']).trim() || null; } catch { head = null; }
  if (!head) return { head: null, effective: null, chain: [], savepointOnly: [], truncated: false, detail: 'no HEAD to compare against — not a git repository, or no commits yet' };

  const chain = [head];
  const savepointOnly = [];
  let effective = null;
  let truncated = false;
  let cur = head;
  for (let step = 0; ; step += 1) {
    if (step >= limit) { truncated = true; break; }
    let shape;
    try { shape = commitShape(dir, cur); } catch { break; } // an unreadable commit ends the walk: strict, never CURRENT by guess
    if (!shape.savepointOnly) { effective = cur; break; }
    savepointOnly.push({ rev: cur, paths: shape.paths });
    cur = shape.parents[0];
    chain.push(cur);
  }
  if (effective === null) effective = head; // truncated or unclassifiable: bind strictly to HEAD

  const detail = head === effective
    ? `HEAD ${short(head)}`
    : `HEAD ${short(head)} differs from ${short(effective)} only by ${savepointOnly.length} savepoint-only commit${savepointOnly.length === 1 ? '' : 's'} (derived docs / candidate memories, no source)`;
  return { head, effective, chain, savepointOnly, truncated, detail };
}

module.exports = { sourceManifest, compareManifest, digestMap, compareDigestMap, sourceRevisions, isSavepointOutput, INPUT_FILES, INPUT_DIRS, ABSENT, UNREADABLE, SAVEPOINT_OUTPUT_PREFIXES, COMPILER_INPUT_PREFIX, SAVEPOINT_CHAIN_LIMIT };
