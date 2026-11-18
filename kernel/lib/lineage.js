/*
 * RespawnPack · kernel/lib/lineage.js — the declared-provenance contract (Class D).
 *
 * ⛔ WHAT THIS CLOSES. Anything cloned, copied, migrated or regenerated has a source, and a project
 * usually has an opinion about which source is the truth. Nothing in this pack could hold that opinion.
 * `codeTruth` names paths that outrank prose for ONE check; `removals` handles negative knowledge; the
 * compiler-input manifest digests what the compiler reads and knows nothing about derived files. So the
 * owner's own instance — a range's Guacamole configuration cloned from the TEMPLATE box instead of the
 * per-range box — had no surface that could have said anything at all, and neither does a generated API
 * client whose schema moved, a customer document copied from a stale template, or an inventory
 * duplicated by hand. They are one class, and this is the one contract for it.
 *
 * ⭐ THE FOUR THINGS THAT MAKE THIS A CONTRACT RATHER THAN A CONVENTION.
 *
 * 1. THE DECLARATION IS STRUCTURED AND AUTHORED, NEVER INFERRED. `docs/derived/state/lineage.json` is
 *    the founder's or planner's own file (writer null in schemas/registry.json, the class of
 *    requirements.json): which files are SOURCES, and which files were DERIVED from them. This pack
 *    reads it and never writes it, because a tool that could rewrite the provenance could make its own
 *    verdict easier.
 *
 * 2. A MARKER IS VERIFIED, NEVER TRUSTED (anti-drift item 55). The marker records the source id AND the
 *    digest of that source at derivation time, and this module recomputes the digest from the source on
 *    disk. "It says it came from the inventory" is not evidence; "it says it came from the inventory,
 *    and the inventory still hashes to what it recorded" is.
 *
 * 3. THE FORBIDDEN SOURCE IS A FIRST-CLASS FIELD. `neverFrom` is what makes the guac case detectable at
 *    all: the config LOOKS right, parses fine, and has a perfectly good marker — naming the template box.
 *    A row that only listed the allowed sources would report a missing marker; this one reports what the
 *    file actually says and what the project declared instead.
 *
 * 4. AN UNDECIDABLE ROW SAYS SO. A target that is absent and not required, a marker that cannot be read,
 *    a source that cannot be read, a URL source this pack cannot digest at all — every one of them is
 *    CANNOT_DETERMINE naming the reason, never a pass and never a failure. The blind spot is reported,
 *    which is the whole difference between this and a grep.
 *
 * ⛔ AND NO LINEAGE FILE AT ALL IS NOT_APPLICABLE, AT EXIT 0 (owner decision 22). Making an absent
 * declaration UNDECIDED would flip every installed target's onboarding row to INCOMPLETE on upgrade and
 * move exit codes under `strict` — a new contract retroactively failing projects that never heard of it.
 * It is deliberately NOT a seventh onboarding contract; adding the row to kernel/lib/applicability.js is
 * the reversal, on the day the owner wants it asked in the interview.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { OUTCOME, result, rollup } = require('./outcome.js');
/*
 * ⛔ THE CONTAINMENT TRIO IS REUSED, NOT RE-IMPLEMENTED. `removals.js` exports
 * `containedResolution`/`portableAbsolute`/`hasParentSegment` explicitly so any other path-taking
 * surface in the kernel reaches the SAME check rather than growing a fourth copy — and this module is
 * exactly such a surface: every `path` and every `target` in the declaration is a project-relative
 * string somebody typed, and a declaration that resolved outside the project through a symlink would let
 * a "source of truth" live somewhere the project does not own.
 */
const removalsLib = require('./removals.js');
const modhealth = require('./modhealth.js');
/*
 * ⛔ THE CLASSIFIED READ, THROUGH THE SAME BOUNDARY EVERY OTHER TRACKED INPUT USES. Absent · unreadable
 * · malformed are three different answers and collapsing any two of them turns a fault into a
 * configuration state — see hooks/_artifact.js's own header. Probed rather than required outright for
 * the reason state.js gives at its own probe: a bootstrap module must be able to describe its own
 * breakage instead of dying with a MODULE_NOT_FOUND stack and no rows.
 */
const ARTIFACT_PATH = path.resolve(__dirname, '..', '..', 'hooks', '_artifact.js');
const artifactHealth = modhealth.probePath(ARTIFACT_PATH);
const artifact = artifactHealth.module;

const SCHEMA_VERSION = '1.0.0';
const LINEAGE_REL = path.join('docs', 'derived', 'state', 'lineage.json');

/*
 * ⛔ THE MARKER IS SPELLED ONCE, HERE. The stamp verb writes it (P2-P-3), this check reads it, and the
 * two live in one module so they cannot come to disagree about a byte of it. `<sourceId>@sha256:<hex>`
 * — the id says WHICH source and the digest says WHICH VERSION of it, and a marker carrying only the
 * first would be a comment rather than a claim anything could falsify.
 */
const MARKER = {
  prefix: 'respawnpack-derived-from:',
  pattern: /respawnpack-derived-from:\s*([A-Za-z0-9][A-Za-z0-9._-]{0,63})@sha256:([0-9a-f]{64})/,
  sidecarSuffix: '.lineage.json',
  /*
   * ⛔ FORTY LINES, AND THE BOUND IS THE POINT. A marker is a header, so a scan of the whole file would
   * find one a generator happened to echo into the body of a data table — and an unbounded scan of a
   * multi-megabyte generated client is a cost every savepoint pays. Anything below line 40 is not a
   * header, and the remedy (re-stamp it) is one command.
   */
  lines: 40,
};

/** Read at most this many bytes looking for the marker header. */
const MARKER_SCAN_BYTES = 64 * 1024;
/** Directory names that are never walked for a glob target, at any depth. */
const SKIP_DIR_NAMES = new Set(['node_modules', '.git', '.respawnpack', '__pycache__']);
/** A glob that matched more than this many files is reported, never silently truncated. */
const MAX_GLOB_MATCHES = 500;

const posix = removalsLib.posix;
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

// --- the declaration -------------------------------------------------------------------------------

const SOURCE_KINDS = new Set(['inventory', 'iac', 'template', 'schema', 'dataset', 'doc']);
const HOWS = new Set(['clone', 'copy', 'migrate', 'generate']);
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const badPath = (p) => typeof p !== 'string' || !p.trim()
  || removalsLib.portableAbsolute(p) || removalsLib.hasParentSegment(p);

/**
 * Accept or refuse a lineage document, structurally.
 *
 * ⛔ SHAPED LIKE hooks/_artifact.js's OWN VALIDATORS ON PURPOSE, INCLUDING THE VERSION SENTENCE. An
 * ABSENT `schemaVersion` is accepted and a DIFFERENT one is refused, which is the same asymmetry
 * `checkVersion` applies to requirements.json and goal.json: documents predate the field, and a
 * document that DECLARES a version this kernel does not implement is telling us, in the document, that
 * it means something we cannot read.
 *
 * @returns {{ok:boolean, reason:string|null}}
 */
function validateLineage(doc, artifactName = 'lineage.json') {
  const reject = (reason) => ({ ok: false, reason });
  if (!isPlainObject(doc)) return reject(`${artifactName} is ${Array.isArray(doc) ? 'an array' : typeof doc}, expected a JSON object`);
  if (doc.schemaVersion !== undefined && doc.schemaVersion !== null && doc.schemaVersion !== SCHEMA_VERSION) {
    return reject(`${artifactName} declares schemaVersion ${JSON.stringify(doc.schemaVersion)}, and this kernel implements ${SCHEMA_VERSION}. `
      + 'It is REFUSED rather than read on a best-effort basis: a document that says it means something else may mean anything.');
  }
  for (const key of ['sources', 'derivations']) {
    if (doc[key] === undefined) return reject(`${artifactName} has no \`${key}\` array — a provenance declaration with no ${key} is a contract with nothing in it`);
    if (!Array.isArray(doc[key])) return reject(`${artifactName}: \`${key}\` is ${isPlainObject(doc[key]) ? 'an object' : typeof doc[key]}, expected an array`);
  }
  const ids = new Set();
  for (const [i, s] of doc.sources.entries()) {
    if (!isPlainObject(s)) return reject(`${artifactName}: source ${i} is ${Array.isArray(s) ? 'an array' : typeof s}, expected an object`);
    if (typeof s.id !== 'string' || !ID_RE.test(s.id)) return reject(`${artifactName}: source ${i} has no usable \`id\` — a source nothing can be keyed by cannot be named by a marker`);
    if (ids.has(s.id)) return reject(`${artifactName}: source id ${JSON.stringify(s.id)} is declared twice, so a marker naming it would have two different digests to compare against`);
    ids.add(s.id);
    if (!SOURCE_KINDS.has(s.kind)) return reject(`${artifactName}: source ${s.id} declares kind ${JSON.stringify(s.kind)} — expected one of ${[...SOURCE_KINDS].join(', ')}`);
    if (s.authority !== 'source-of-truth') return reject(`${artifactName}: source ${s.id} does not declare \`"authority": "source-of-truth"\` — declaring a source IS declaring it authoritative, so a weaker entry would leave a reader guessing what the derivations are checked against`);
    const hasPath = s.path !== undefined;
    const hasUrl = s.url !== undefined;
    if (hasPath === hasUrl) return reject(`${artifactName}: source ${s.id} must declare exactly one of \`path\` or \`url\`, and declares ${hasPath ? 'both' : 'neither'}`);
    if (hasPath && badPath(s.path)) return reject(`${artifactName}: source ${s.id} path must be a non-empty project-relative string with no parent traversal`);
    if (hasUrl && (typeof s.url !== 'string' || !/^[a-z][a-z0-9+.-]*:\/\//.test(s.url))) return reject(`${artifactName}: source ${s.id} url must be an absolute URL`);
  }
  const derivationIds = new Set();
  for (const [i, d] of doc.derivations.entries()) {
    if (!isPlainObject(d)) return reject(`${artifactName}: derivation ${i} is ${Array.isArray(d) ? 'an array' : typeof d}, expected an object`);
    if (typeof d.id !== 'string' || !ID_RE.test(d.id)) return reject(`${artifactName}: derivation ${i} has no usable \`id\` — the check row is spelled \`lineage:<id>\`, so a row with no id has no name to report under`);
    if (derivationIds.has(d.id)) return reject(`${artifactName}: derivation id ${JSON.stringify(d.id)} is declared twice, so two rows would report under one check id and a reader would see whichever came last`);
    derivationIds.add(d.id);
    if (badPath(d.target)) return reject(`${artifactName}: derivation ${d.id} target must be a non-empty project-relative string with no parent traversal`);
    if (!Array.isArray(d.from) || !d.from.length || d.from.some((x) => typeof x !== 'string')) {
      return reject(`${artifactName}: derivation ${d.id} must declare a non-empty \`from\` array of source ids — a derivation with no declared source is a target nothing can be checked against`);
    }
    if (!HOWS.has(d.how)) return reject(`${artifactName}: derivation ${d.id} declares how ${JSON.stringify(d.how)} — expected one of ${[...HOWS].join(', ')}`);
    if (d.neverFrom !== undefined && (!Array.isArray(d.neverFrom) || d.neverFrom.some((x) => typeof x !== 'string'))) {
      return reject(`${artifactName}: derivation ${d.id} neverFrom must be an array of source ids`);
    }
    if (d.required !== undefined && typeof d.required !== 'boolean') {
      return reject(`${artifactName}: derivation ${d.id} required must be a boolean — anything else silently changes whether a missing target is a breach`);
    }
  }
  return { ok: true, reason: null };
}

/**
 * Read the lineage declaration through the shared classified boundary.
 *
 * @returns {{status:'OK'|'ABSENT'|'UNREADABLE'|'MALFORMED'|'UNSUPPORTED'|'INVALID', doc:object|null, detail:string|null}}
 *   Six answers, kept apart for the reason hooks/_artifact.js keeps them apart: a transient replacement
 *   window, a genuinely absent file, a file nobody can parse and a file that parses into the wrong shape
 *   are four different facts, and only one of them means "this project declares no provenance".
 */
function readLineage(dir) {
  const rel = posix(LINEAGE_REL);
  if (!artifact) {
    return {
      status: 'UNREADABLE', doc: null,
      detail: `${rel}: the classified read boundary hooks/_artifact.js could not be loaded (${artifactHealth.detail || artifactHealth.status}), so nothing can be accepted from it`,
    };
  }
  const r = artifact.readJSONClassified(path.join(dir, LINEAGE_REL));
  if (r.status !== 'OK') return { status: r.status, doc: null, detail: r.detail ? `${rel}: ${r.detail}` : `${rel}: ${r.status}` };
  const v = validateLineage(r.doc, rel);
  if (v.ok) return { status: 'OK', doc: r.doc, detail: null };
  // A declared-but-unimplemented version is a document from another era; a broken shape is a document
  // that is simply wrong. Same split, and the same test, hooks/_artifact.js's loadContract applies.
  return { status: /declares schemaVersion/.test(v.reason) ? 'UNSUPPORTED' : 'INVALID', doc: null, detail: v.reason };
}

// --- targets ---------------------------------------------------------------------------------------

const isGlob = (p) => /[*?]/.test(p);

/** A glob over POSIX paths: `**` crosses segments, `*` stays inside one, `?` is a single character. */
function globToRegExp(glob) {
  const g = posix(glob);
  let out = '^';
  for (let i = 0; i < g.length; i += 1) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        i += 1;
        // `a/**/b` must also match `a/b`, so the separator is consumed with the wildcard.
        if (g[i + 1] === '/') { i += 1; out += '(?:[^/]+/)*'; } else out += '.*';
      } else out += '[^/]*';
      continue;
    }
    if (c === '?') { out += '[^/]'; continue; }
    out += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`${out}$`);
}

/** The literal directory prefix of a glob — where the walk can start instead of at the project root. */
function globRoot(glob) {
  const parts = posix(glob).split('/');
  const out = [];
  for (const p of parts.slice(0, -1)) {
    if (isGlob(p)) break;
    out.push(p);
  }
  return out.join('/');
}

/**
 * Every project-relative file a target names. A literal target resolves to itself (present or not); a
 * glob is walked.
 *
 * ⛔ A GLOB CHECKS EVERY MATCHING FILE, AND THE CAP IS REPORTED. One unmarked file in a generated tree
 * is the entire reason a glob target exists, so stopping at the first match would answer the wrong
 * question — and a silent cap would be coverage nobody mentioned, which reads as coverage that happened.
 *
 * @returns {{files:string[], truncated:boolean, error:string|null}}
 */
function targetFiles(dir, target) {
  if (!isGlob(target)) {
    const abs = path.join(dir, ...posix(target).split('/'));
    const resolved = removalsLib.containedResolution(path.resolve(dir), abs);
    if (!resolved.ok) {
      return { files: [], truncated: false, error: `${posix(target)} could not be resolved inside the project (${resolved.kind || 'error'})` };
    }
    return { files: resolved.exists ? [posix(target)] : [], truncated: false, error: null };
  }
  const rx = globToRegExp(target);
  const root = globRoot(target);
  const files = [];
  let truncated = false;
  const walk = (relDir) => {
    if (truncated) return;
    let entries;
    try { entries = fs.readdirSync(path.join(dir, ...(relDir ? relDir.split('/') : [])), { withFileTypes: true }); }
    catch { return; } // an unreadable subtree contributes no matches; the row below reports zero, never a pass
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (SKIP_DIR_NAMES.has(e.name)) continue;
        walk(rel);
        if (truncated) return;
        continue;
      }
      if (!e.isFile()) continue;
      if (!rx.test(rel)) continue;
      if (files.length >= MAX_GLOB_MATCHES) { truncated = true; return; }
      files.push(rel);
    }
  };
  walk(root);
  return { files: files.sort(), truncated, error: null };
}

// --- the marker ------------------------------------------------------------------------------------

/** The first `MARKER_SCAN_BYTES` of a file, as text. Bounded so a huge generated file costs a header read. */
function headText(abs) {
  const fd = fs.openSync(abs, 'r');
  try {
    const buf = Buffer.alloc(MARKER_SCAN_BYTES);
    const n = fs.readSync(fd, buf, 0, MARKER_SCAN_BYTES, 0);
    return buf.subarray(0, n).toString('utf8');
  } finally { fs.closeSync(fd); }
}

/**
 * The provenance one derived file records about itself.
 *
 * @returns {{status:'OK'|'MISSING'|'UNREADABLE', sourceId:string|null, digest:string|null, where:string|null, detail:string|null}}
 */
function readMarker(dir, rel) {
  const abs = path.join(dir, ...posix(rel).split('/'));
  // The sidecar first: it is the form a binary or machine-generated target uses, and a project that
  // wrote one meant it to be authoritative for that file.
  const sidecarRel = `${posix(rel)}${MARKER.sidecarSuffix}`;
  const sidecarAbs = `${abs}${MARKER.sidecarSuffix}`;
  if (artifact) {
    const s = artifact.readJSONClassified(sidecarAbs);
    if (s.status === 'OK') {
      const doc = s.doc;
      if (!isPlainObject(doc) || typeof doc.sourceId !== 'string' || !ID_RE.test(doc.sourceId) || !/^[0-9a-f]{64}$/.test(String(doc.sourceDigest))) {
        return { status: 'UNREADABLE', sourceId: null, digest: null, where: sidecarRel, detail: `${sidecarRel} is not a usable lineage sidecar: it needs a \`sourceId\` and a 64-character hex \`sourceDigest\`` };
      }
      return { status: 'OK', sourceId: doc.sourceId, digest: doc.sourceDigest, where: sidecarRel, detail: null };
    }
    if (s.status !== 'ABSENT') {
      return { status: 'UNREADABLE', sourceId: null, digest: null, where: sidecarRel, detail: `${sidecarRel} exists and could not be read (${s.detail || s.status})` };
    }
  }
  let head;
  try { head = headText(abs); }
  catch (e) { return { status: 'UNREADABLE', sourceId: null, digest: null, where: posix(rel), detail: `${posix(rel)} could not be read (${(e && (e.code || e.message)) || 'unknown error'})` }; }
  const window = head.split(/\r?\n/).slice(0, MARKER.lines).join('\n');
  const m = MARKER.pattern.exec(window);
  if (m) return { status: 'OK', sourceId: m[1], digest: m[2], where: posix(rel), detail: null };
  /*
   * ⛔ A MALFORMED MARKER IS NOT A MISSING ONE. Somebody wrote the prefix and got the rest wrong — a
   * truncated digest, a hand-edited id — and reporting that as "no marker" would send them to write a
   * second one beside the first.
   */
  if (window.includes(MARKER.prefix)) {
    return { status: 'UNREADABLE', sourceId: null, digest: null, where: posix(rel), detail: `${posix(rel)} carries a \`${MARKER.prefix}\` line this kernel cannot parse — the form is \`${MARKER.prefix} <sourceId>@sha256:<64 hex characters>\`` };
  }
  return { status: 'MISSING', sourceId: null, digest: null, where: posix(rel), detail: `${posix(rel)} records no provenance in its first ${MARKER.lines} lines and has no ${MARKER.sidecarSuffix} sidecar` };
}

/**
 * The digest of a source as it is on disk now.
 *
 * @returns {{status:'OK'|'UNDIGESTIBLE', digest:string|null, detail:string|null}}
 */
function sourceDigest(dir, source) {
  if (source.url !== undefined) {
    /*
     * ⛔ THE HONEST BLIND SPOT, NAMED RATHER THAN RESOLVED. This pack makes no network call, so the
     * bytes behind a URL source cannot be compared against anything. Reporting a URL derivation as PASS
     * would be a verdict about a thing nobody looked at, and reporting it as FAIL would blame a project
     * for a check this kernel declined to run.
     */
    return { status: 'UNDIGESTIBLE', digest: null, detail: `source ${source.id} is the URL ${source.url}, and this pack makes no network call — its bytes cannot be compared against the recorded digest` };
  }
  const abs = path.join(dir, ...posix(source.path).split('/'));
  const resolved = removalsLib.containedResolution(path.resolve(dir), abs);
  if (!resolved.ok) return { status: 'UNDIGESTIBLE', digest: null, detail: `source ${source.id} (${posix(source.path)}) does not resolve inside the project — an external file cannot be this project's source of truth` };
  if (!resolved.exists) return { status: 'UNDIGESTIBLE', digest: null, detail: `source ${source.id} declares ${posix(source.path)}, which is not present — the derivation cannot be compared against a source that is not there` };
  try { return { status: 'OK', digest: sha256(fs.readFileSync(resolved.realPath)), detail: null }; }
  catch (e) { return { status: 'UNDIGESTIBLE', digest: null, detail: `source ${source.id} (${posix(source.path)}) could not be read (${(e && (e.code || e.message)) || 'unknown error'})` }; }
}

// --- the check -------------------------------------------------------------------------------------

const STAMP_REMEDY = (rel, sourceId) => `declare the marker with \`respawnpack lineage stamp ${rel} --from ${sourceId}\``;

/**
 * One derivation's verdict, over every file its target names.
 *
 * Precedence is deliberate and is the difference between a useful row and a confusing one: a marker
 * naming a FORBIDDEN source is reported as that, before anything about digests, because the digest of
 * the wrong source matching is not good news.
 */
function checkDerivation(dir, d, byId) {
  const id = `lineage:${d.id}`;
  const subject = posix(d.target);
  const from = d.from.map(String);
  const never = new Set((d.neverFrom || []).map(String));
  const unknown = [...new Set([...from, ...never])].filter((s) => !byId.has(s));
  if (unknown.length) {
    return result(OUTCOME.CANNOT_DETERMINE, id,
      `derivation ${d.id} names source id(s) ${unknown.join(', ')} that ${posix(LINEAGE_REL)} does not declare — there is nothing to compare a marker against`,
      { checked: 0, subject });
  }

  const found = targetFiles(dir, d.target);
  if (found.error) return result(OUTCOME.CANNOT_DETERMINE, id, `${found.error} — the target of derivation ${d.id} could not be enumerated`, { checked: 0, subject });
  if (!found.files.length) {
    /*
     * ⛔ ABSENT AND REQUIRED IS A BREACH; ABSENT AND NOT REQUIRED IS A QUESTION. A partial checkout, a
     * tree that has not been generated on this machine, and a target somebody deleted look identical
     * from here, so the default is the weaker answer and `required: true` is how a project says it is
     * not one of those.
     */
    const why = `derivation ${d.id} names ${subject}, and nothing here matches it`;
    return d.required === true
      ? result(OUTCOME.FAIL, id, `${why}. The derivation declares \`"required": true\`, so a missing target is a breach rather than an open question.`, { checked: 0, subject })
      : result(OUTCOME.CANNOT_DETERMINE, id, `${why}. It is not declared \`required\`, so this is undetermined rather than a failure — declare \`"required": true\` if the target must exist here.`, { checked: 0, subject });
  }

  const fails = [];
  const undetermined = [];
  for (const rel of found.files) {
    const marker = readMarker(dir, rel);
    if (marker.status === 'MISSING') {
      undetermined.push(`${marker.detail} — ${STAMP_REMEDY(rel, from[0])}`);
      continue;
    }
    if (marker.status === 'UNREADABLE') { undetermined.push(marker.detail); continue; }

    if (never.has(marker.sourceId)) {
      /*
       * ⛔ THE GUAC CASE, AND THE DETAIL NAMES BOTH SIDES. "Wrong source" is not actionable; "it says
       * template-box and this derivation declares range-inventory, and template-box is on its
       * neverFrom list" is the sentence somebody can act on without opening three files.
       */
      fails.push(`${rel} is marked as derived from \`${marker.sourceId}\`, which derivation ${d.id} declares it must NEVER be derived from; its declared source(s) are ${from.join(', ')}`);
      continue;
    }
    if (!from.includes(marker.sourceId)) {
      if (!byId.has(marker.sourceId)) { undetermined.push(`${rel} is marked as derived from \`${marker.sourceId}\`, which ${posix(LINEAGE_REL)} does not declare as a source — there is nothing to compare its digest against`); continue; }
      fails.push(`${rel} is marked as derived from \`${marker.sourceId}\`, which derivation ${d.id} does not declare among its sources (${from.join(', ')})`);
      continue;
    }

    const src = byId.get(marker.sourceId);
    const now = sourceDigest(dir, src);
    if (now.status !== 'OK') { undetermined.push(`${rel}: ${now.detail}`); continue; }
    if (now.digest !== marker.digest) {
      fails.push(`${rel} records source \`${marker.sourceId}\` at sha256:${marker.digest.slice(0, 12)} and it is now sha256:${now.digest.slice(0, 12)} — the source moved since the derivation, so this copy is behind the truth it came from`);
    }
  }

  const checked = found.files.length;
  const scope = `${checked} file(s)${found.truncated ? ` (the first ${MAX_GLOB_MATCHES}; ${subject} matches more, and the rest were NOT checked)` : ''}`;
  if (fails.length) {
    return result(OUTCOME.FAIL, id, `${fails.length} of ${scope} under derivation ${d.id} (${d.how}): ${fails.slice(0, 5).join('; ')}${fails.length > 5 ? ` (+${fails.length - 5} more)` : ''}`, { checked, subject });
  }
  if (undetermined.length || found.truncated) {
    const why = undetermined.length
      ? `${undetermined.length} of ${scope} under derivation ${d.id} could not be checked: ${undetermined.slice(0, 5).join('; ')}${undetermined.length > 5 ? ` (+${undetermined.length - 5} more)` : ''}`
      : `derivation ${d.id} matched more than ${MAX_GLOB_MATCHES} files and the rest were not checked, so this row does not describe ${subject} as a whole`;
    return result(OUTCOME.CANNOT_DETERMINE, id, why, { checked, subject });
  }
  return result(OUTCOME.PASS, id, `${scope} under derivation ${d.id} (${d.how}) carry a marker naming a declared source at its current digest`, { checked, subject });
}

/** How many source ids the bounded `failing` list carries into STATE.json. Same bound as reconciliation's driftIds. */
const FAILING_LIMIT = 20;

/**
 * Run the provenance check.
 *
 * @returns {{outcome:string, checks:object[], block:object, read:object}}
 *   `block` is what travels in STATE.json — the verdict, the counts, and a BOUNDED list of the
 *   derivations that are not passing. The rows themselves stay here, exactly as DF-005 keeps the
 *   reconciliation records out of the compiled document: a boot path may summarise an established
 *   verdict without any hook reading a project's own files.
 */
function checkLineage(dir) {
  const read = readLineage(dir);
  const rel = posix(LINEAGE_REL);
  const empty = (checks, status) => ({
    outcome: status, checks,
    block: { status, counts: { sources: 0, derivations: 0, pass: 0, fail: 0, undetermined: 0 }, failing: [], failingTruncated: false },
    read,
  });

  if (read.status === 'ABSENT') {
    /*
     * ⛔ NOT_APPLICABLE, AT EXIT 0, AND THIS IS THE ONE BRANCH OWNER-DECISION 22 IS ABOUT. Every other
     * optional contract in this kernel spells an absent declaration UNDECIDED and blocks release
     * readiness on it. This one may not: making it the seventh onboarding contract would turn every
     * installed target's `onboarding` row INCOMPLETE the day this ships, on a question its founder has
     * never been asked. It is NOT tagged `coverage` either, because it is not in the survey that
     * decides onboarding — a row nothing surveys, filed under the heading of the survey, would be a
     * reader's second copy of a decision that lives in kernel/lib/applicability.js.
     */
    return empty([result(OUTCOME.NOT_APPLICABLE, 'lineage:declaration',
      `no ${rel} — this project declares no provenance, so nothing here is claimed about where its copies come from. `
      + 'Declare sources and derivations there to have them verified.', { subject: rel })], OUTCOME.NOT_APPLICABLE);
  }
  if (read.status !== 'OK') {
    return empty([result(OUTCOME.CANNOT_DETERMINE, 'lineage:declaration',
      `${read.detail || `${rel} could not be used (${read.status})`} — NOTHING was derived from it: no source, no derivation and no verdict. `
      + 'A declaration that EXISTS and cannot be used is not the same state as one that is absent, and is never a pass.', { checked: 0, subject: rel })], OUTCOME.CANNOT_DETERMINE);
  }

  const doc = read.doc;
  const byId = new Map(doc.sources.map((s) => [s.id, s]));
  const checks = [];

  if (!doc.derivations.length) {
    /*
     * ⛔ A DECLARATION WITH NO DERIVATION IS A CHECK WITH NOTHING TO CHECK. Sources alone are a useful
     * thing to have written down — naming the inventory before anything derives from it is a real
     * decision — but they establish nothing about any file, so this cannot spell PASS.
     */
    checks.push(result(OUTCOME.CANNOT_DETERMINE, 'lineage:declared',
      `${rel} declares ${doc.sources.length} source(s) and ZERO derivations, so no file's provenance was checked. `
      + 'Naming the sources is half the contract; the other half is saying which files come from them.', { checked: 0, subject: rel }));
    return {
      outcome: OUTCOME.CANNOT_DETERMINE, checks, read,
      block: { status: OUTCOME.CANNOT_DETERMINE, counts: { sources: doc.sources.length, derivations: 0, pass: 0, fail: 0, undetermined: 1 }, failing: ['declared'], failingTruncated: false },
    };
  }

  for (const d of doc.derivations) checks.push(checkDerivation(dir, d, byId));

  const by = (outcome) => checks.filter((c) => c.outcome === outcome);
  const failing = [...by(OUTCOME.FAIL), ...by(OUTCOME.CANNOT_DETERMINE)].map((c) => c.check.replace(/^lineage:/, ''));
  const outcome = rollup(checks);
  return {
    outcome, checks, read,
    block: {
      status: outcome,
      counts: {
        sources: doc.sources.length,
        derivations: doc.derivations.length,
        pass: by(OUTCOME.PASS).length,
        fail: by(OUTCOME.FAIL).length,
        undetermined: by(OUTCOME.CANNOT_DETERMINE).length,
      },
      failing: failing.slice(0, FAILING_LIMIT),
      failingTruncated: failing.length > FAILING_LIMIT,
    },
  };
}

// --- seeding (P2-P-2) -------------------------------------------------------------------------------

/*
 * ⛔ A PROPOSAL, NEVER A DERIVATION. `seed` finds the files a project's truth usually lives in — the
 * evidence a repository ALREADY carries, by the same discipline kernel/lib/gate.js's `detectProfiles`
 * applies to a toolchain — and writes each as a `sources[]` row. It never proposes a `derivations[]`
 * row, because WHICH file derives from which is the one fact a directory listing cannot recover: an
 * inventory and a generated config both existing says nothing about whether the second came from the
 * first, and guessing that link is exactly the verdict this contract exists to keep out of a tool's
 * hands. `derivations` in every written document is `[]`; a founder fills it in by hand, the way
 * `docs/derived/state/lineage.json` is always theirs to author.
 *
 * ⛔ REIMPLEMENTED, NOT IMPORTED. `gate.js`'s `candidateRoots`/`detectProfiles` walk a similar shape —
 * the project root and one level down — to answer a different question (which TOOLCHAIN applies) that
 * task Q-1 is actively extending on another branch. Importing gate.js here would make this module's
 * detection move every time that one does, for a reason that has nothing to do with provenance, so the
 * walk below is this module's own: small enough to own outright, and it plans nothing — it only
 * detects sources.
 */

/** What counts as a Terraform file declaring the block that makes its directory a root. */
const TF_CONTENT_RE = /\bterraform\s*\{|\bprovider\s+"/;

/**
 * One directory's own entries (not recursive), split from a single `readdirSync`.
 *
 * ⛔ A SYMLINK IS NEVER FOLLOWED, WHATEVER IT POINTS AT. `seed` only ever reads what a project's own
 * tree lists, and a symlinked entry — file- or directory-shaped, wherever it resolves — is reported in
 * `evidence` once and excluded, never silently absorbed into the proposal as if it were the project's
 * own file. An unlistable directory is reported once too, and contributes nothing.
 *
 * @returns {{rel:string, abs:string, name:string, isDirectory:boolean}[]}
 */
function listDir(rel, abs, evidence) {
  let dirents;
  try { dirents = fs.readdirSync(abs, { withFileTypes: true }); }
  catch (e) {
    evidence.push({ status: 'skipped', path: rel, detail: `could not be listed (${(e && e.code) || 'unknown error'})` });
    return [];
  }
  const out = [];
  for (const ent of dirents.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const entRel = rel === '.' ? ent.name : `${rel}/${ent.name}`;
    if (ent.isSymbolicLink()) {
      evidence.push({ status: 'skipped', path: entRel, detail: 'is a symlink — a proposal never follows one, so nothing under it was considered' });
      continue;
    }
    if (!ent.isFile() && !ent.isDirectory()) continue; // a socket or device is neither evidence nor a symlink
    out.push({ rel: entRel, abs: path.join(abs, ent.name), name: ent.name, isDirectory: ent.isDirectory() });
  }
  return out;
}

/**
 * The project root, plus every immediate subdirectory not in `SKIP_DIR_NAMES` — "root and one level
 * down". Each root carries the entries `listDir` already read for it, so nothing is listed twice and a
 * symlinked subdirectory is reported by `listDir` exactly once, at the point it is excluded from ever
 * becoming a root.
 */
function seedRoots(dir, evidence) {
  const rootEntries = listDir('.', dir, evidence);
  const roots = [{ rel: '.', entries: rootEntries }];
  for (const e of rootEntries) {
    if (!e.isDirectory || SKIP_DIR_NAMES.has(e.name)) continue;
    roots.push({ rel: e.rel, entries: listDir(e.rel, e.abs, evidence) });
  }
  return roots;
}

/** A stable id from a proposed path: lowercase, path separators to hyphens, extension dropped. */
function idFromPath(rel) {
  if (rel === '.') return 'terraform-root'; // the only rule that ever proposes a directory as a source
  const stem = rel.replace(/\.[^./]+$/, '');
  const id = stem.toLowerCase().replace(/\//g, '-').replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+/, '');
  return id && /^[a-z0-9]/.test(id) ? id : `s-${id || 'source'}`;
}

/** `idFromPath`, disambiguated when two candidate paths would collapse to the same id. */
function uniqueId(rel, used) {
  const base = idFromPath(rel);
  if (!used.has(base)) { used.add(base); return base; }
  let n = 2;
  while (used.has(`${base}-${n}`)) n += 1;
  used.add(`${base}-${n}`);
  return `${base}-${n}`;
}

/**
 * Propose the sources a repository already has, by evidence file: a Terraform root (a directory
 * carrying `*.tf` files that declare a `terraform {` or `provider "` block), an Ansible control config
 * and its inventories (`ansible.cfg`; every file under an `inventory/` directory, or named `hosts*`),
 * compose files, a Kustomize overlay, a Pulumi project, an OpenAPI or Swagger document, a Prisma or SQL
 * schema, and the Node package manifest. Detection stops at the project root and one level down.
 *
 * @returns {{proposal:{schemaVersion:string, sources:object[], derivations:[]}, evidence:object[]}}
 *   `evidence` carries one row per candidate this walk actually looked at — `status: 'proposed'` beside
 *   the id and kind it was proposed under, or `status: 'skipped'` naming why a symlink or an unreadable
 *   candidate contributed nothing. Nothing found is ever left out of it.
 */
function seed(dir) {
  const evidence = [];
  const used = new Set();
  const sources = [];

  const propose = (rel, kind, detail) => {
    const id = uniqueId(rel, used);
    sources.push({ id, kind, path: rel, authority: 'source-of-truth', note: `proposed by lineage seed from ${detail}` });
    evidence.push({ status: 'proposed', id, path: rel, kind, detail });
  };

  for (const root of seedRoots(dir, evidence)) {
    /*
     * Terraform: every entry NAMED `*.tf`, whatever kind it turns out to be. A directory shaped like
     * one is read anyway, so it fails through the SAME catch a genuine permission fault would and is
     * reported as unreadable rather than silently excluded for "not being a file" — a candidate this
     * walk noticed is never dropped without a trace.
     */
    const matched = [];
    for (const c of root.entries.filter((e) => /\.tf$/i.test(e.name))) {
      let text;
      try { text = fs.readFileSync(c.abs, 'utf8'); }
      catch (e) { evidence.push({ status: 'skipped', path: c.rel, detail: `could not be read (${(e && e.code) || 'unknown error'})` }); continue; }
      if (TF_CONTENT_RE.test(text)) matched.push(c.name);
    }
    if (matched.length) propose(root.rel, 'iac', `${matched.join(', ')} (declares a \`terraform {\` or \`provider "\` block)`);

    // Every remaining rule looks at plain files only — directories above were only ever needed for
    // the Terraform check, which is why they are filtered out here rather than at listDir.
    for (const f of root.entries) {
      if (f.isDirectory) continue;
      if (root.rel === 'inventory') { propose(f.rel, 'inventory', `${f.rel} (an Ansible inventory file under inventory/)`); continue; }
      if (/^hosts/i.test(f.name)) { propose(f.rel, 'inventory', `${f.rel} (named hosts*, an Ansible inventory file)`); continue; }
      if (f.name === 'ansible.cfg') { propose(f.rel, 'iac', `${f.rel} (an Ansible control configuration)`); continue; }
      if (/^docker-compose.*\.ya?ml$/i.test(f.name) || /^compose\.ya?ml$/i.test(f.name)) { propose(f.rel, 'iac', `${f.rel} (a Compose file)`); continue; }
      if (f.name === 'kustomization.yaml') { propose(f.rel, 'iac', `${f.rel} (a Kustomize overlay)`); continue; }
      if (f.name === 'Pulumi.yaml') { propose(f.rel, 'iac', `${f.rel} (a Pulumi project file)`); continue; }
      if (/^(openapi|swagger)\./i.test(f.name)) { propose(f.rel, 'schema', `${f.rel} (an OpenAPI/Swagger document)`); continue; }
      if (root.rel === 'prisma' && f.name === 'schema.prisma') { propose(f.rel, 'schema', `${f.rel} (a Prisma schema)`); continue; }
      if (f.name === 'schema.sql') { propose(f.rel, 'schema', `${f.rel} (a SQL schema)`); continue; }
      if (f.name === 'package.json') { propose(f.rel, 'schema', `${f.rel} (the Node package manifest)`); continue; }
    }
  }

  return { proposal: { schemaVersion: SCHEMA_VERSION, sources, derivations: [] }, evidence };
}

// --- stamping (P2-P-3) -------------------------------------------------------------------------------

/*
 * ⛔ THE COMMENT FORM IS CHOSEN BY EXTENSION, NEVER GUESSED FROM CONTENT. A file's comment grammar is a
 * fact about its language, not something worth sniffing bytes for — sniffing is exactly how a marker
 * ends up inside a string literal instead of a comment. `Dockerfile` and `Makefile` are named, not
 * extended, so they are matched by basename. An extension this table does not know, or a target with
 * neither a known extension nor a known basename, falls through to the sidecar, which every syntax and
 * no syntax can carry alike.
 */
const LINE_COMMENT_EXT = new Set(['sh', 'py', 'rb', 'yml', 'yaml', 'toml', 'tf', 'tfvars', 'ini', 'cfg', 'conf', 'env']);
const SLASH_COMMENT_EXT = new Set(['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'go', 'rs', 'java', 'kt', 'c', 'h', 'cpp', 'json5']);
const DASH_COMMENT_EXT = new Set(['sql', 'lua', 'hs']);
const BLOCK_COMMENT_EXT = new Set(['css', 'scss']);
const MARKUP_COMMENT_EXT = new Set(['md', 'html', 'xml', 'svg']);
const COMMENT_BY_BASENAME = { Dockerfile: 'line', Makefile: 'line' };

/**
 * The comment FORM a target's own syntax uses, or `null` when this module knows none — the trigger for
 * the sidecar. `'line'` is `#`, `'slash'` is `//`, `'dash'` is `--`; `'block'` and `'markup'` carry an
 * open AND a close, so `wrapMarker` spells each out rather than folding it into one shared prefix.
 */
function commentForm(rel) {
  const base = posix(rel).split('/').pop();
  if (COMMENT_BY_BASENAME[base]) return COMMENT_BY_BASENAME[base];
  const m = /\.([^./]+)$/.exec(base);
  const ext = m ? m[1].toLowerCase() : '';
  if (LINE_COMMENT_EXT.has(ext)) return 'line';
  if (SLASH_COMMENT_EXT.has(ext)) return 'slash';
  if (DASH_COMMENT_EXT.has(ext)) return 'dash';
  if (BLOCK_COMMENT_EXT.has(ext)) return 'block';
  if (MARKUP_COMMENT_EXT.has(ext)) return 'markup';
  return null;
}

/** `text` wrapped as one line in the given comment form. */
function wrapMarker(form, text) {
  if (form === 'markup') return `<!-- ${text} -->`;
  if (form === 'block') return `/* ${text} */`;
  if (form === 'dash') return `-- ${text}`;
  if (form === 'slash') return `// ${text}`;
  return `# ${text}`; // 'line'
}

/** A shebang, an XML declaration or a DOCTYPE on the first line — kept ahead of the marker, never displaced. */
const FIRST_LINE_DIRECTIVE = /^(#!.*|<\?xml[^>]*\?>|<!doctype[^>]*>)$/i;

/**
 * `text` with `markerLine` inserted, or — when a `MARKER.prefix` line already sits in the first
 * `MARKER.lines` lines — REPLACED there in place. That is the same window `readMarker` scans, so a
 * marker this module would find on the next check is a marker it finds now, and re-stamping a target
 * never grows a second line. A shebang or a markup/XML directive already on line one stays ahead of the
 * marker; everything else gets it at the very top, where a provenance header belongs.
 *
 * @returns {{text:string, replaced:boolean}}
 */
function spliceMarker(text, markerLine) {
  const lines = text.split(/\r?\n/);
  const scanEnd = Math.min(lines.length, MARKER.lines);
  let replaceAt = -1;
  for (let i = 0; i < scanEnd; i += 1) {
    if (lines[i].includes(MARKER.prefix)) { replaceAt = i; break; }
  }
  if (replaceAt >= 0) {
    const next = lines.slice();
    next[replaceAt] = markerLine;
    return { text: next.join('\n'), replaced: true };
  }
  const insertAt = lines.length && FIRST_LINE_DIRECTIVE.test(lines[0].trim()) ? 1 : 0;
  const next = lines.slice();
  next.splice(insertAt, 0, markerLine);
  return { text: next.join('\n'), replaced: false };
}

/** Every derivation in `doc` whose `target` (literal or glob) names `targetRel`. */
function derivationsCovering(doc, targetRel) {
  return doc.derivations.filter((d) => (isGlob(d.target) ? globToRegExp(d.target).test(targetRel) : posix(d.target) === targetRel));
}

/**
 * Write the provenance marker into `target` — the founder's or the builder's own mechanism for
 * producing exactly the fact `checkLineage` later verifies. `stamp` computes the source's digest through
 * the SAME `sourceDigest` the check uses, so there is one implementation of "what does this source hash
 * to right now" in this module, never a second one only the writer trusts.
 *
 * Refuses, in the order checked: a target that does not resolve inside the project or is not a file
 * there yet (CANNOT_DETERMINE — stamp records where a file came from, so the file has to exist first); a
 * `from` that names no source `docs/derived/state/lineage.json` declares (CANNOT_DETERMINE, naming the
 * ids that ARE declared); a `from` that some derivation covering this target lists in its `neverFrom`
 * (FAIL, naming that derivation — the guac case, caught before a single byte is written). Anything else
 * writes: a comment in the target's own syntax chosen by extension, or a `<target>.lineage.json` sidecar
 * for an extension this module does not know or when `sidecar: true` is passed. An existing marker for
 * the same target — inline or sidecar — is REPLACED, never duplicated.
 *
 * @param {string} dir project root
 * @param {{target:string, from:string, sidecar?:boolean, now?:string}} opts `now` is an ISO timestamp,
 *   injectable for deterministic tests; it defaults to the current time and is recorded only in a
 *   sidecar's `stampedAt` — the inline marker carries no timestamp, by the one grammar this module reads.
 * @returns {{outcome:string, checks:object[], wrote:string|null, marker:object|null}}
 */
function stamp(dir, { target, from, sidecar = false, now } = {}) {
  const id = 'lineage:stamp';
  const targetRel = typeof target === 'string' ? posix(target) : '';
  const refuse = (outcome, detail) => ({ outcome, checks: [result(outcome, id, detail, { subject: targetRel })], wrote: null, marker: null });

  if (!targetRel.trim()) return refuse(OUTCOME.CANNOT_DETERMINE, 'stamp requires a project-relative target file — none was given');

  const abs = path.join(dir, ...targetRel.split('/'));
  const resolved = removalsLib.containedResolution(path.resolve(dir), abs);
  if (!resolved.ok) return refuse(OUTCOME.CANNOT_DETERMINE, `${targetRel} could not be resolved inside the project (${resolved.kind || 'error'})`);
  if (!resolved.exists) return refuse(OUTCOME.CANNOT_DETERMINE, `${targetRel} does not exist — stamp records where a file came from, and there is nothing here yet to record it on`);
  let stat;
  try { stat = fs.statSync(resolved.realPath); }
  catch (e) { return refuse(OUTCOME.CANNOT_DETERMINE, `${targetRel} could not be inspected (${(e && e.code) || 'unknown error'})`); }
  if (!stat.isFile()) return refuse(OUTCOME.CANNOT_DETERMINE, `${targetRel} is not a file — stamp marks one derived file, never a directory`);

  const read = readLineage(dir);
  const byId = read.status === 'OK' ? new Map(read.doc.sources.map((s) => [s.id, s])) : new Map();
  if (!byId.has(from)) {
    const ids = [...byId.keys()];
    const why = read.status === 'OK'
      ? `"${from}" is not a source ${posix(LINEAGE_REL)} declares — declared source(s): ${ids.length ? ids.join(', ') : '(none)'}`
      : `"${from}" cannot be verified: ${posix(LINEAGE_REL)} ${read.status === 'ABSENT' ? 'does not exist yet' : `could not be used (${read.detail || read.status})`} — declare the source there first (\`lineage seed --write\` proposes one)`;
    return refuse(OUTCOME.CANNOT_DETERMINE, why);
  }

  if (read.status === 'OK') {
    for (const d of derivationsCovering(read.doc, targetRel)) {
      if (new Set((d.neverFrom || []).map(String)).has(from)) {
        return refuse(OUTCOME.FAIL,
          `derivation ${d.id} declares \`${from}\` in its neverFrom list for ${targetRel} — refusing to write a marker `
          + 'naming a source this project has already said this file must never come from');
      }
    }
  }

  const src = byId.get(from);
  const digest = sourceDigest(dir, src);
  if (digest.status !== 'OK') return refuse(OUTCOME.CANNOT_DETERMINE, digest.detail);

  const nowIso = typeof now === 'string' && now ? now : new Date().toISOString();
  const form = sidecar === true ? null : commentForm(targetRel);
  /*
   * ⛔ EVERY WRITE GOES THROUGH THE ONE ATOMIC PRIMITIVE (anti-drift item 8), REQUIRED LAZILY. This
   * module is required BY kernel/lib/state.js at ITS top level, to compile the lineage block into
   * STATE.json — so a top-level `require('./state.js')` here would deadlock the load order: whichever
   * of the two loads first would hand the other back an EMPTY exports object, because Node resolves a
   * circular require to whatever the far side has exported SO FAR, and state.js does not assign
   * `module.exports` until the very end of its file. By the time `stamp` is actually CALLED — always
   * after the whole module graph has finished loading — the cache already holds both fully populated,
   * so this costs nothing and creates no cycle a reader has to reason about.
   */
  const { writeAtomic } = require('./state.js');

  if (!form) {
    const sidecarAbs = `${abs}${MARKER.sidecarSuffix}`;
    const sidecarRel = `${targetRel}${MARKER.sidecarSuffix}`;
    const existed = fs.existsSync(sidecarAbs);
    writeAtomic(sidecarAbs, `${JSON.stringify({ sourceId: from, sourceDigest: digest.digest, stampedAt: nowIso }, null, 2)}\n`);
    return {
      outcome: OUTCOME.PASS,
      checks: [result(OUTCOME.PASS, id,
        `${sidecarRel} ${existed ? 'replaces the prior sidecar and now records' : 'now records'} \`${from}@sha256:${digest.digest}\` for ${targetRel}`,
        { subject: targetRel, checked: 1 })],
      wrote: sidecarRel,
      marker: { sourceId: from, digest: digest.digest, where: sidecarRel },
    };
  }

  let text;
  try { text = fs.readFileSync(resolved.realPath, 'utf8'); }
  catch (e) { return refuse(OUTCOME.CANNOT_DETERMINE, `${targetRel} could not be read (${(e && e.code) || 'unknown error'})`); }
  const markerLine = wrapMarker(form, `${MARKER.prefix} ${from}@sha256:${digest.digest}`);
  const spliced = spliceMarker(text, markerLine);
  writeAtomic(abs, spliced.text);
  return {
    outcome: OUTCOME.PASS,
    checks: [result(OUTCOME.PASS, id,
      `${targetRel} ${spliced.replaced ? 'replaces its prior marker and now records' : 'now records'} \`${from}@sha256:${digest.digest}\``,
      { subject: targetRel, checked: 1 })],
    wrote: targetRel,
    marker: { sourceId: from, digest: digest.digest, where: targetRel },
  };
}

module.exports = {
  readLineage, checkLineage, validateLineage, seed, stamp,
  MARKER, SCHEMA_VERSION, LINEAGE_REL, FAILING_LIMIT, MAX_GLOB_MATCHES,
  globToRegExp, targetFiles, readMarker, sourceDigest,
};
