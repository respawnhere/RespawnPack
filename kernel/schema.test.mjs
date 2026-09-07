/*
 * RespawnPack · kernel/schema.test.mjs — the declared schemas, and the fences that keep them true.
 *
 * ⛔ WHY DECLARED SCHEMAS AT ALL, WHEN THE LOADERS ALREADY VALIDATE. `HANDOFF.json` carried
 * "a JSON-schema file per artifact (schemas are enforced in code today, not declared)" under Phase 2
 * for the whole program. Procedural validation answers "did THIS loader accept THIS document"; it
 * cannot answer "what is the format", which is the question every reviewer, every future writer and
 * every project integrating with these files actually has.
 *
 * ⛔ AND THE FAILURE MODE A SCHEMA DIRECTORY INVITES. A schema nobody points at drifts from its
 * artifact in silence, and reads as a specification the whole time. So the schemas are not the
 * deliverable on their own — these fences are:
 *
 *   1. VALIDATOR HONESTY. schemas/validate.mjs THROWS on any keyword it does not implement, so a
 *      schema it cannot fully enforce cannot be used at all. A validator that skips what it does not
 *      understand turns every schema using that keyword into a check of nothing.
 *   2. CODE → SCHEMA. Artifacts are CAPTURED FROM REAL RUNS — the real CLI, the real hooks, on a real
 *      installed target — and validated with additionalProperties:false. A writer that adds a field
 *      fails here.
 *   3. SCHEMA → CODE. Every property a schema declares must appear in its writer's source. A schema
 *      that invents a field fails here.
 *   4. NO UNCLASSIFIED WRITE SITE. Every JSON-writing call in kernel/ and hooks/ must be classified —
 *      as a registered family or as an explicitly justified exclusion. ⛔ This is the direction that
 *      matters: an inventory built from what is present cannot report an absence, which has been the
 *      finding of two separate correction rounds in this program.
 *   5. EVERY EXCLUSION'S JUSTIFICATION IS VERIFIED, not asserted — "no code reads HANDOFF.json" and
 *      "no reader names a field of atomic-task" are both checked against the tree.
 *   6. NO UNCAPTURED FAMILY. Every registered family is either CAPTURED FROM A REAL RUN by a NAMED
 *      test, or excluded with a class checked against the registry. ⛔ Fence 2 can only judge the
 *      captures that exist; it has no way to report the family that has none — the same direction
 *      fence 4 exists for, one level up. `threshold-latches` spent a release inside fence 2's own
 *      describe behind `if (fs.existsSync(...)) ... else assert.ok(true)`, reading as coverage while
 *      exercising nothing, and no fence in this file could see it. So the capture set is DECLARED
 *      here and WITNESSED at run time: a capture that does not fire registers nothing and fails.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import { validate, compile } from '../schemas/validate.mjs';
import { runHook, makeRepo, rm, stdinFor } from '../hooks/_harness.mjs';

const KERNEL = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(KERNEL);
const SCHEMA_DIR = path.join(ROOT, 'schemas');
const CLI = path.join(KERNEL, 'respawnpack.js');
const require_ = createRequire(import.meta.url);
const stateLib = require_(path.join(KERNEL, 'lib', 'state.js'));

const readJSON = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const src = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const REGISTRY = readJSON(path.join(SCHEMA_DIR, 'registry.json'));
const schemaOf = (name) => readJSON(path.join(SCHEMA_DIR, name));
const familyNamed = (f) => REGISTRY.families.find((x) => x.family === f);

/*
 * ⛔ THE ONE WAY A FAMILY BECOMES "CAPTURED", AND THE WITNESS THAT PROVES THE CAPTURE RAN.
 *
 * Every positive capture in this file goes through here, and this is the only place that records one.
 * Two properties follow, and fence 6 at the bottom of the file rests on both:
 *
 *   · It takes a PATH, never a document. A family counts as captured when a schema validated bytes a
 *     REAL RUN left on disk — not when a fixture somebody typed validated against it. Passing an
 *     object is not possible, so that distinction cannot erode one call site at a time.
 *   · The record is written at RUN TIME, not read out of the source. A capture behind a condition
 *     that never fires registers nothing — which is exactly how `threshold-latches` looked covered
 *     for a release while exercising nothing. An inventory built from what is present cannot report
 *     an absence; a witness built from what actually ran can.
 */
const CAPTURED_FROM_DISK = new Set();

function capture(file, schemaName, label) {
  assert.ok(fs.existsSync(file), `${label}: no artifact at ${file}, so ${schemaName} captured nothing this run`);
  const doc = readJSON(file);
  const r = validate(doc, schemaOf(schemaName));
  assert.equal(r.valid, true, `${label} does not conform to ${schemaName}:\n  ${r.errors.join('\n  ')}`);
  CAPTURED_FROM_DISK.add(schemaName);
  return doc;
}

/** The same as capture(), for a JSONL artifact — EVERY line must conform, not merely the newest. */
function captureLines(file, schemaName, label) {
  assert.ok(fs.existsSync(file), `${label}: no artifact at ${file}, so ${schemaName} captured nothing this run`);
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim());
  assert.ok(lines.length, `${label}: ${file} holds no rows, so it captured nothing`);
  lines.forEach((line, i) => {
    const r = validate(JSON.parse(line), schemaOf(schemaName));
    assert.equal(r.valid, true, `${label} row ${i + 1} does not conform to ${schemaName}:\n  ${r.errors.join('\n  ')}`);
  });
  CAPTURED_FROM_DISK.add(schemaName);
  return lines;
}

/*
 * A shape check on a document this file BUILT, which is deliberately NOT a capture and records none.
 * Kept distinct rather than folded into capture() so the difference stays visible at the call site: a
 * fixture validating against its own schema proves the two agree with each other, and nothing at all
 * about what the code writes. A family whose only coverage is this one fails fence 6.
 */
const conforms = (doc, schemaName, label) => {
  const r = validate(doc, schemaOf(schemaName));
  assert.equal(r.valid, true, `${label} does not conform to ${schemaName}:\n  ${r.errors.join('\n  ')}`);
};

/** Every property name a schema declares, at every depth. */
function declaredProps(node, out = new Set()) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { node.forEach((n) => declaredProps(n, out)); return out; }
  for (const k of Object.keys(node.properties || {})) { out.add(k); declaredProps(node.properties[k], out); }
  for (const key of ['items', 'additionalProperties', 'not', 'propertyNames']) declaredProps(node[key], out);
  for (const key of ['oneOf', 'anyOf', 'allOf']) declaredProps(node[key], out);
  for (const k of Object.keys(node.$defs || {})) declaredProps(node.$defs[k], out);
  for (const k of Object.keys(node.patternProperties || {})) declaredProps(node.patternProperties[k], out);
  return out;
}

// ---------------------------------------------------------------------------------------------
describe('the validator refuses what it cannot enforce', () => {
  test('an unsupported keyword is a hard error, never a silently skipped constraint', () => {
    assert.throws(() => compile({ type: 'object', minProperties: 2 }), /unsupported keyword "minProperties"/,
      'a keyword this validator ignores would make every schema using it a check of nothing');
    assert.throws(() => compile({ type: 'object', properties: { a: { uniqueItems: true } } }), /unsupported keyword "uniqueItems"/,
      'the refusal must reach nested subschemas, or the hole simply moves one level down');
    assert.throws(() => compile({ type: 'nonsense' }), /unknown type "nonsense"/);
  });

  test('it discriminates — the same schema accepts good input and rejects each bad shape', () => {
    const s = {
      type: 'object', required: ['a', 'b'], additionalProperties: false,
      properties: { a: { const: '1.0.0' }, b: { type: 'array', items: { type: 'integer' } } },
    };
    assert.equal(validate({ a: '1.0.0', b: [1, 2] }, s).valid, true, 'the known-good control was rejected');
    for (const [label, bad] of [
      ['missing required', { a: '1.0.0' }],
      ['wrong type', { a: '1.0.0', b: 'not an array' }],
      ['wrong nested type', { a: '1.0.0', b: [1, 'two'] }],
      ['wrong const', { a: '9.9.9', b: [] }],
      ['unknown property', { a: '1.0.0', b: [], c: 1 }],
    ]) {
      const r = validate(bad, s);
      assert.equal(r.valid, false, `the validator accepted a document with a ${label}`);
      assert.ok(r.errors.length, `a rejection with no error message cannot be acted on (${label})`);
    }
  });

  test('oneOf means exactly one — matching both branches is a failure, not a pass', () => {
    const s = { oneOf: [{ required: ['x'] }, { required: ['y'] }] };
    assert.equal(validate({ x: 1 }, s).valid, true);
    assert.equal(validate({ x: 1, y: 2 }, s).valid, false, 'a document matching BOTH branches was accepted');
    assert.equal(validate({ z: 1 }, s).valid, false, 'a document matching NEITHER branch was accepted');
  });
});

// ---------------------------------------------------------------------------------------------
describe('the registry and the schema directory agree, in both directions', () => {
  test('every registered family names a schema that exists and compiles', () => {
    for (const f of REGISTRY.families) {
      const p = path.join(SCHEMA_DIR, f.schema);
      assert.ok(fs.existsSync(p), `family ${f.family} names a schema that does not exist: ${f.schema}`);
      const s = schemaOf(f.schema);
      assert.doesNotThrow(() => compile(s), `${f.schema} uses a keyword the validator cannot enforce`);
      assert.equal(s.$schema, 'https://json-schema.org/draft/2020-12/schema', `${f.schema} does not declare the one draft this project uses`);
      assert.equal(s.$id, `https://respawnpack.dev/schemas/${f.schema}`, `${f.schema}'s $id does not match its filename`);
      assert.ok(s.title && s.description, `${f.schema} has no title/description — a schema that cannot say what it is for is documentation of nothing`);
    }
  });

  test('every schema file in schemas/ is registered — an orphan schema is drift with a filename', () => {
    const onDisk = fs.readdirSync(SCHEMA_DIR).filter((f) => f.endsWith('.schema.json')).sort();
    const registered = [...new Set(REGISTRY.families.map((f) => f.schema))].sort();
    assert.deepEqual(onDisk, registered,
      `schemas/ and registry.json disagree. on disk only: ${onDisk.filter((x) => !registered.includes(x))}; `
      + `registered only: ${registered.filter((x) => !onDisk.includes(x))}`);
  });

  test('every registry entry is complete, and its durability is a declared class', () => {
    const classes = Object.keys(REGISTRY.durabilityClasses);
    for (const f of REGISTRY.families) {
      for (const k of ['family', 'schema', 'path', 'durability', 'declaresSchemaVersion', 'readers']) {
        assert.ok(Object.prototype.hasOwnProperty.call(f, k), `family ${f.family} is missing "${k}"`);
      }
      assert.ok(classes.includes(f.durability), `family ${f.family} declares durability "${f.durability}", which is not a declared class`);
      assert.ok(Object.prototype.hasOwnProperty.call(f, 'writer'), `family ${f.family} does not say who writes it (null is a valid, and meaningful, answer)`);
      if (f.writer === null) assert.ok(f.writerNote, `family ${f.family} has no writer and does not say why`);
      else assert.ok(fs.existsSync(path.join(ROOT, f.writer)), `family ${f.family} names a writer that does not exist: ${f.writer}`);
      for (const r of f.readers) assert.ok(fs.existsSync(path.join(ROOT, r)), `family ${f.family} names a reader that does not exist: ${r}`);
      if (!f.declaresSchemaVersion) {
        assert.ok(f.declaresSchemaVersionNote || f.writerNote,
          `family ${f.family} carries no schemaVersion and offers no justification — an undeclared version is a migration nobody can detect`);
      }
    }
  });

  test('every declared schemaVersion is the ONE version the kernel enforces', () => {
    // ⛔ Bound to the code, not to a remembered string. Bumping state.SCHEMA_VERSION without touching
    // the schemas fails here rather than shipping a set of declarations about a superseded format.
    // The property is not always at the root: a schema whose top level is a `oneOf` carries it inside
    // a branch. Searching rather than indexing keeps the fence honest — the first version indexed
    // `s.properties.schemaVersion` and silently found nothing the moment a schema grew a branch.
    const findSV = (node) => {
      if (!node || typeof node !== 'object') return undefined;
      if (Array.isArray(node)) { for (const n of node) { const r = findSV(n); if (r) return r; } return undefined; }
      if (node.properties && node.properties.schemaVersion) return node.properties.schemaVersion;
      for (const key of ['oneOf', 'anyOf', 'allOf', '$defs']) { const r = findSV(node[key]); if (r) return r; }
      return undefined;
    };
    /*
     * ⛔ v0.3 · SOME FAMILIES VERSION AGAINST A DIFFERENT AUTHORITY, AND ARE NAMED RATHER THAN SILENTLY
     * EXEMPTED. `stateLib.SCHEMA_VERSION` is the kernel's OWN format number for docs/derived/* artifacts
     * (state.json, goal.json, ...) it compiles and reads. rollover-handoff is not one of those — it is
     * core/state/handoff.js's document, versioned by `core.handoff.SCHEMA_VERSION`, a wire format the
     * kernel never reads and must not be forced onto. Pinning it to the kernel's number would make a
     * future, unrelated docs/derived/* format bump silently break every rollover handoff's declared
     * version, which is the opposite of what this fence exists to catch.
     */
    const coreLib = require_(path.join(ROOT, 'core', 'index.js'));
    /*
     * ⛔ W5 · candidate-memory joins rollover-handoff as a SECOND core-versioned family, so the single
     * hardcoded `coreLib.handoff.SCHEMA_VERSION` this used to compare every core-versioned family
     * against is no longer sound — candidate-memory's own authority is `coreLib.candidates.SCHEMA_VERSION`
     * (2.0.0), a different number for a different document. Each family versioned outside the kernel now
     * names its OWN authority rather than sharing rollover-handoff's.
     */
    /*
     * ⛔ P5-T-16b · AND A THIRD, FROM adapters/. `task-attempt` is the task runner's own receipt, not a
     * docs/derived/* document the compiler writes, so pinning it to the kernel's number would make an
     * unrelated kernel bump silently re-version every task receipt already on disk — and unlike every
     * other runtime record, these are NEVER replaced (created with `wx`), so older shapes really do
     * survive to be read back. The constant it names is the one the writer stamps.
     */
    const runnerLib = require_(path.join(ROOT, 'adapters', 'claude-code', 'task-runner', 'runner.js'));
    /*
     * ⛔ P4-M-4 · AND A FOURTH, FOR THE SAME REASON THE THIRD EXISTS. The offload receipt is written by
     * a pack-side tool, not by the compiler, and like the task receipt it is created with `wx` and never
     * replaced — so older shapes really do survive on disk to be read back, and pinning it to the
     * kernel's number would re-version every offload receipt already written whenever the kernel moves.
     */
    const offloadLib = require_(path.join(ROOT, 'adapters', 'providers', 'offload.js'));
    const OWN_VERSION_AUTHORITY = {
      'rollover-handoff': ['core/state/handoff.js SCHEMA_VERSION', coreLib.handoff.SCHEMA_VERSION],
      'candidate-memory': ['core/memory/candidates.js SCHEMA_VERSION', coreLib.candidates.SCHEMA_VERSION],
      'task-attempt': ['adapters/claude-code/task-runner/runner.js TASK_ATTEMPT_SCHEMA_VERSION', runnerLib.TASK_ATTEMPT_SCHEMA_VERSION],
      'offload-receipt': ['adapters/providers/offload.js OFFLOAD_RECEIPT_SCHEMA_VERSION', offloadLib.OFFLOAD_RECEIPT_SCHEMA_VERSION],
    };

    const versioned = [];
    for (const f of REGISTRY.families) {
      const s = schemaOf(f.schema);
      const sv = findSV(s);
      if (!sv) { assert.equal(f.declaresSchemaVersion, false, `${f.family} is registered as versioned but its schema declares no schemaVersion`); continue; }
      assert.equal(f.declaresSchemaVersion, true, `${f.family} is registered as unversioned but its schema declares schemaVersion`);
      if (sv.const !== undefined) {
        versioned.push(f.family);
        const [authority, expected] = OWN_VERSION_AUTHORITY[f.family] || ['the kernel', stateLib.SCHEMA_VERSION];
        assert.equal(sv.const, expected, `${f.family} pins schemaVersion ${sv.const}, ${authority} is at ${expected}`);
      }
    }
    assert.ok(versioned.length >= 6, `only ${versioned.length} families pin a version — the fence is not covering the versioned set`);
  });

  test('every exclusion states a class and a reason', () => {
    assert.ok(REGISTRY.excluded.length >= 4, 'the exclusion list is suspiciously short for a repository this size');
    for (const e of REGISTRY.excluded) {
      for (const k of ['path', 'class', 'reason']) assert.ok(e[k], `an exclusion is missing "${k}": ${JSON.stringify(e)}`);
      assert.ok(e.reason.length > 60, `the exclusion for ${e.path} is a label, not a justification`);
    }
  });
});

// ---------------------------------------------------------------------------------------------
describe('⛔ no state write site is unclassified', () => {
  /*
   * The declared classification of every JSON-writing call in kernel/ and hooks/. A call site that
   * appears in the code and NOT here fails the fence below — which is the whole point: the next
   * artifact somebody adds cannot be invisible to this directory.
   *
   * Anchors are source substrings rather than line numbers, so ordinary edits above them do not
   * produce false failures.
   */
  const WRITE_SITES = [
    // --- registered families -------------------------------------------------------------------
    { file: 'kernel/lib/state.js', anchor: 'writeAtomic(goalPath(dir)', family: 'goal-contract' },
    { file: 'kernel/lib/state.js', anchor: 'writeAtomic(file, JSON.stringify(state', family: 'compiled-state' },
    { file: 'kernel/lib/closeout.js', anchor: 'path.join(dir, RUNTIME_REL)', family: 'runtime-contract' },
    { file: 'kernel/lib/closeout.js', anchor: 'path.join(dir, DELEGATION_LOG_REL)', family: 'delegation-archive' },
    { file: 'kernel/lib/living.js', anchor: 'fs.writeFileSync(metaPath, `${JSON.stringify(meta', family: 'skill-meta' },
    { file: 'kernel/lib/living.js', anchor: 'fs.writeFileSync(mp, `${JSON.stringify(m', family: 'skill-meta' },
    { file: 'kernel/lib/living.js', anchor: 'lastReset: new Date().toISOString()', family: 'skill-meta' },
    { file: 'kernel/respawnpack.js', anchor: 'path.resolve(DIR, vf)', family: 'gate-verdict' },
    { file: 'hooks/_runtime.js', anchor: 'atomicWriteJSON(file, record)', family: 'session-baseline' },
    { file: 'hooks/_runtime.js', anchor: 'atomicWriteJSON(stopRecordPath(dir, sessionId)', family: 'stop-decision' },
    { file: 'hooks/_runtime.js', anchor: 'consumedAt: new Date().toISOString()', family: 'precompact-handoff' },
    { file: 'hooks/precompact-ledger-nudge.js', anchor: 'rt.atomicWriteJSON(file, record)', family: 'precompact-handoff' },
    { file: 'hooks/precompact-ledger-nudge.js', anchor: 'readBackVerified: true', family: 'precompact-handoff' },
    { file: 'hooks/_index-lease.js', anchor: 'JSON.stringify(map, null, 2)', family: 'index-ownership' },
    { file: 'hooks/_index-lease.js', anchor: 'provisional: false, confirmedAt', family: 'index-lease' },
    { file: 'hooks/_index-lease.js', anchor: 'JSON.stringify(next, null, 2)', family: 'index-lease' },
    { file: 'hooks/spawn-guard.js', anchor: 'count: Math.max(0, count)', family: 'spawn-counter' },
    // field run §4 — the savepoint receipt. Machine JSON, read by hooks/stop-savepoint.js across the two
    // trees, so it is a registered family rather than a marker: a shape that two components agree on
    // is exactly what this registry exists to keep from drifting.
    { file: 'kernel/respawnpack.js', anchor: 'path.join(DIR, SAVEPOINT_ATTEMPT_REL)', family: 'savepoint-attempt' },
    { file: 'hooks/push-guard.js', anchor: 'at, firstAt: at, cmd', family: 'push-authorization' },
    { file: 'hooks/push-guard.js', anchor: 'retries: (consumed.retries || 0) + 1', family: 'push-authorization' },
    { file: 'install/install.js', anchor: 'respawnpack.config.json', family: 'project-config' },
    /*
     * ⛔ P2-P-3 · `lineage seed --write`'s ONE write site. `lineage`'s writer stayed `null` in
     * schemas/registry.json through P2-P-1 — this pack read the declaration and never wrote it — and
     * `seed --write` (P2-P-2) is the one exception: a founder-owned document this pack will write EXACTLY
     * ONCE, and only onto a project that has none yet (cmdLineageSeed refuses at exit 2 the moment any
     * file already sits at the path). It is still the same tracked family the check reads back, so it is
     * classified under `lineage` rather than invented as a second family for one conditional write.
     */
    { file: 'kernel/respawnpack.js', anchor: 'stateLib.writeAtomic(abs, `${JSON.stringify(proposal', family: 'lineage' },

    /*
     * ⛔ v0.3 · THE ROLLOVER CORE'S OWN WRITE SITES. `core/` is not one of this test's SCANNED dirs (the
     * sweep below covers kernel/lib, kernel and hooks only — core/ has its own consumer, adapters/, and
     * the dependency arrow forbids core/ requiring kernel/ or hooks/), so these six do not need to be
     * FOUND by the sweep. They are registered anyway because "every registered family with a writer has
     * a write site in that writer" (below) checks every family in schemas/registry.json regardless of
     * which tree its writer lives in — a registered family with no classified site is exactly the drift
     * this fence exists to catch, wherever the writer happens to live.
     */
    { file: 'core/state/handoff.js', anchor: 'io.writeAtomicText(file,', family: 'rollover-handoff' },
    { file: 'core/state/handoff.js', anchor: "kind: 'handoff-verification',", family: 'handoff-verification-receipt' },
    { file: 'core/lifecycle/consumable.js', anchor: "kind: 'consumption-receipt',", family: 'consumption-receipt' },
    { file: 'core/policy/thresholds.js', anchor: 'io.writeAtomicJSON(latchPath(dir), record)', family: 'threshold-latches' },
    { file: 'core/lifecycle/cycle.js', anchor: 'io.writeAtomicJSON(file, cycle)', family: 'cycle-record' },
    { file: 'core/lifecycle/journal.js', anchor: 'io.appendLine(journalPath(dir)', family: 'rollover-journal' },
    { file: 'core/lifecycle/journal.js', anchor: 'io.writeAtomicJSON(snapshotPath(dir), snap)', family: 'rollover-journal' },
    /*
     * ⛔ W5 · candidate-memory follows the SAME "core/ is not SCANNED, registered anyway" rule as the
     * six sites above — core/memory/candidates.js is core/'s writer for this family, and the sweep
     * below never reaches it.
     */
    { file: 'core/memory/candidates.js', anchor: 'io.writeAtomicJSON(file, rec)', family: 'candidate-memory' },
    { file: 'core/memory/candidates.js', anchor: 'io.appendLine(auditPath(store)', family: 'candidate-memory' },
    /*
     * ⛔ P5-T-16b · THE FIRST REGISTERED WRITER UNDER adapters/, and it follows the same "not SCANNED,
     * registered anyway" rule as the core/ sites above: the sweep below covers kernel/lib, kernel and
     * hooks only, while "every registered family with a writer has a write site in that writer" checks
     * EVERY family in registry.json regardless of which tree its writer lives in. A registered family
     * with no classified site is exactly the drift this fence exists to catch, wherever the writer is.
     */
    { file: 'adapters/claude-code/task-runner/runner.js', anchor: 'io.createExclusive(file,', family: 'task-attempt' },
    { file: 'adapters/providers/offload.js', anchor: 'io.createExclusive(receiptPath,', family: 'offload-receipt' },

    // --- justified non-family write sites --------------------------------------------------------
    { file: 'kernel/lib/state.js', anchor: 'fs.writeFileSync(tmp, text)', excluded: 'the temporary write INSIDE the atomic-write primitive itself — not an artifact, and never observable as one' },
    { file: 'hooks/_runtime.js', anchor: 'fs.writeFileSync(tmp, JSON.stringify(obj, null, 2))', excluded: 'the same temporary write, in the hook tree twin' },
    { file: 'hooks/_index-lease.js', anchor: 'fs.writeFileSync(tmp,', excluded: 'the lease/ownership temporaries; the published artifacts are registered above' },
    { file: 'kernel/lib/living.js', anchor: 'fs.writeFileSync(basePath, base)', excluded: 'SKILL.base.md — markdown, the frozen baseline, not a machine-readable state artifact' },
    { file: 'kernel/lib/living.js', anchor: "fs.writeFileSync(path.join(sd, 'SKILL.md'), next)", excluded: 'the regenerated SKILL.md — markdown prose for a model to read; its MACHINE-readable half is .skill-meta.json, which is registered' },
    { file: 'kernel/lib/living.js', anchor: 'fs.writeFileSync(archived, overlay)', excluded: 'SKILL.superseded[.N].md — a markdown archive of the founder\'s overlay, bounded at five and reported by `living status`' },
    { file: 'kernel/lib/living.js', anchor: "fs.writeFileSync(path.join(sd, 'SKILL.md'), norm(base))", excluded: 'SKILL.md restored to its baseline by `living reset` — markdown, same class as the regeneration above' },
    { file: 'kernel/respawnpack.js', anchor: 'stateLib.writeAtomic(archiveAbs, existing)', excluded: 'the savepoint migration archive — the founder\'s prior CONTINUITY/GAPS markdown, verbatim' },
    /*
     * ⛔ P2-O-2 · THE AFTER ACTION REPORT. Markdown for a human, written once per window and NEVER
     * rewritten (the verb refuses at exit 2 rather than overwrite one), so there is no shape two
     * components have to keep agreeing on and nothing here for the registry to enforce. Same class as
     * living.js's SKILL.md writes and respawnpack.js's rendered CONTINUITY/GAPS above. Every machine
     * fact inside it is COPIED from an artifact that IS registered — the compiled state, the savepoint
     * receipt, the candidate-memory journal, the delegation archive — so registering the report as a
     * family of its own would be registering a second copy of records this registry already holds.
     */
    { file: 'kernel/lib/aar.js', anchor: 'stateLib.writeAtomic(abs, document)', excluded: 'the After Action Report at docs/derived/aar/<until-date>-<slug>.md — markdown for a human, written once and never overwritten, whose every machine fact is copied from an artifact this registry already covers' },
    /*
     * ⛔ P3-O-4b · THE BUILT SITE'S PAGES, and the reason they are excluded rather than registered.
     * `kernel/lib/site.js` writes HTML — a RENDERING of markdown documents for a person to read, under a
     * gitignored output directory that is rebuilt from scratch on every run. Nothing parses it back: no
     * hook, no kernel verb and no adapter reads a page, so there is no shape two components could
     * disagree about, which is the whole thing schemas/registry.json exists to keep from drifting. Same
     * class as living.js's SKILL.md and respawnpack.js's rendered CONTINUITY/GAPS above. It goes through
     * `writeAtomic` all the same (anti-drift item 8): a build interrupted mid-page must leave the
     * previous whole page behind, never half of one that a reader would take for the document.
     */
    { file: 'kernel/lib/site.js', anchor: 'stateLib.writeAtomic(file, text)', excluded: 'the built site\'s HTML pages — a projection of the repository\'s own markdown for a human to read, written under a gitignored output directory and rebuilt rather than amended. No component parses a page back, so it is not machine state this registry enforces; markdown for a reader, like the SKILL.md and CONTINUITY/GAPS writes above' },
    /*
     * ⛔ CLASSIFIED IN ITS OWN RIGHT (P3-K-07b), NOT BY PROXIMITY. This write was matched only because
     * the rendered-doc anchor two statements below it happened to fall inside the 400-character
     * look-ahead above. Adding a comment between them un-classified it, which is a fence that depends on
     * how much prose sits between two lines. It has its own entry now.
     */
    { file: 'kernel/respawnpack.js', anchor: 'stateLib.writeAtomic(noteArchiveAbs,', excluded: 'the NOTE-overflow archive — the founder\'s full over-budget note, verbatim markdown, written content-addressed under docs/derived/_archive/ BEFORE the bounded doc so the failure mode is "nothing changed" rather than "the note is gone". Same class as the migration archive above: a human\'s prose preserved, not machine state this registry enforces' },
    { file: 'kernel/respawnpack.js', anchor: 'stateLib.writeAtomic(abs, fresh)', excluded: 'the rendered CONTINUITY.md / GAPS.md — markdown, and every number in them is verified back against STATE.json by render.js' },
    { file: 'kernel/respawnpack.js', anchor: 'stateLib.writeAtomic(abs, real.text)', excluded: 'restore-derived putting a pre-kernel CONTINUITY/GAPS original back — the same markdown the migration archived verbatim, written back from that archive; the inverse of the two sites above and the same class as both' },
    { file: 'kernel/respawnpack.js', anchor: 'for (const w of writes) stateLib.writeAtomic(w.abs, w.text)', excluded: 'the wave-ledger fold (I-3) writing the two derived markdown docs it folds into — CONTINUITY.md through the same renderer and the same generated block as the site above, and docs/derived/CHANGELOG.md, which is agent-authored session prose the kernel appends folded ledger lines to. Markdown for a human and for /respawn to read, not machine state this registry enforces; the ledger it consumes is classified below' },
    { file: 'hooks/spawn-guard.js', anchor: 'fs.appendFileSync(ledger,', excluded: 'the wave ledger (.respawnpack/wave-ledger.md) — append-only markdown prose for a human, for /respawn to read, and (since I-3) for kernel/respawnpack.js waveLedgerCheck() to fold into the derived docs and delete when it is UNTRACKED; deliberately free-form so a resume can record whatever a wave turned out to need, which is why its reader parses dispatch groups rather than a schema. Its machine-readable half is the spawn-counter family above' },
    { file: 'hooks/spawn-guard.js', anchor: "fs.writeFileSync(ledger,\n          '# Wave ledger", excluded: 'the wave ledger\'s one-time header, same markdown artifact as the append above' },
    { file: 'hooks/lockdown.js', anchor: "fs.writeFileSync(scopeFile, prefixes.join('\\n')", excluded: 'a newline-delimited prefix list, not JSON' },
    { file: 'hooks/push-guard.js', anchor: 'fs.writeFileSync(markerFile, new Date().toISOString()', excluded: 'a bare ISO timestamp marker, not JSON' },
    { file: 'hooks/spawn-guard.js', anchor: 'fs.writeFileSync(strictFile, new Date().toISOString()', excluded: 'a bare ISO timestamp marker, not JSON' },
    /*
     * ⛔ W5 · promotion's ONE side effect beyond the candidate-memory family: the canonical entity at
     * memory/graph/<type>/<slug>.md, per memory/knowledge-graph.md's file-backed schema. Markdown
     * prose + YAML frontmatter for a human/grep, not machine JSON state this registry enforces — the
     * same class as living.js's SKILL.md writes above. The machine-readable half of a promotion (the
     * candidate's own verificationState/verification.evidencePaths) IS the candidate-memory family
     * record, already classified in core/memory/candidates.js above.
     */
    { file: 'kernel/respawnpack.js', anchor: "fs.writeFileSync(file, `${frontLines.join('\\n')}", excluded: 'the promoted candidate written as a markdown graph entity (memory/graph/<type>/<slug>.md) — markdown + YAML frontmatter for a human/grep, not machine JSON state this registry enforces' },
    /*
     * ⛔ P2-P-3 · `lineage stamp`'s two write sites, and NEITHER is the `lineage` family. The family is
     * docs/derived/state/lineage.json, the DECLARATION; a stamp writes into the TARGET the declaration
     * names — a different file this pack does not register at all, because it is the project's own
     * source, config, or generated artifact, whatever schema (or none) it already carries.
     * schemas/registry.json's own writerNote says this outright: "`lineage stamp` writes a MARKER into a
     * derived file, which is a different artifact — the claim being checked, not the contract checking
     * it." Both sites are excluded here rather than invented as a family, the same way living.js's
     * SKILL.md rewrites above are excluded rather than registered.
     */
    { file: 'kernel/lib/lineage.js', anchor: 'writeAtomic(sidecarAbs, `${JSON.stringify({ sourceId: from', excluded: 'the lineage sidecar, <target>.lineage.json — a per-target provenance note living beside whatever file it describes, not a registered artifact family: its shape (sourceId, sourceDigest, stampedAt) is read back by this same module\'s own readMarker, never by a second consumer that would need a schema entry to agree with' },
    { file: 'kernel/lib/lineage.js', anchor: 'writeAtomic(abs, spliced.text)', excluded: 'the inline marker — one comment line written INTO the founder\'s own derived file, in that file\'s own syntax. It is a line inside a file this pack does not own or register at all, the same class as living.js\'s in-place SKILL.md rewrite above, and doubly so: the file it touches is not even one of this pack\'s artifacts to begin with' },
  ];

  const SCANNED = ['kernel/lib', 'kernel', 'hooks'];

  test('every classified write site still exists — a stale classification is a fence about nothing', () => {
    for (const s of WRITE_SITES) {
      assert.ok(src(s.file).includes(s.anchor), `the classified write site is gone from ${s.file}: ${s.anchor}`);
      if (s.family) assert.ok(familyNamed(s.family), `${s.file} is classified as family "${s.family}", which is not in the registry`);
      else assert.ok(s.excluded && s.excluded.length > 30, `${s.file} @ ${s.anchor} is excluded without a real reason`);
    }
  });

  test('⛔ every write call in the scanned tree is classified — a new artifact cannot be invisible', () => {
    const files = [];
    for (const d of SCANNED) {
      for (const f of fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })) {
        if (!f.isFile() || !f.name.endsWith('.js')) continue;
        files.push(path.posix.join(d, f.name));
      }
    }
    assert.ok(files.length >= 25, `only ${files.length} source files scanned — the sweep is not reaching the tree`);

    const unclassified = [];
    for (const rel of files) {
      const text = src(rel);
      const lines = text.split(/\r?\n/);
      lines.forEach((line, i) => {
        if (!/\b(writeAtomic|atomicWriteJSON|writeFileSync)\s*\(/.test(line)) return;
        if (/^\s*(\*|\/\/)/.test(line)) return;                 // prose about a write is not a write
        if (/^(function|const)\s+(writeAtomic|atomicWriteJSON)/.test(line.trim())) return; // the definitions
        const matched = WRITE_SITES.some((s) => s.file === rel && (line.includes(s.anchor) || text.slice(text.indexOf(line)).slice(0, 400).includes(s.anchor)));
        if (!matched) unclassified.push(`${rel}:${i + 1}  ${line.trim().slice(0, 110)}`);
      });
    }
    assert.deepEqual(unclassified, [],
      'these write sites are classified nowhere. Register the artifact in schemas/registry.json, or add an '
      + `explicit justified exclusion to WRITE_SITES:\n  ${unclassified.join('\n  ')}`);
  });

  test('every registered family with a writer has a write site in that writer', () => {
    for (const f of REGISTRY.families) {
      if (!f.writer) continue;
      const sites = WRITE_SITES.filter((s) => s.family === f.family);
      assert.ok(sites.length, `family ${f.family} declares a writer but no write site is classified for it`);
      assert.ok(sites.some((s) => s.file === f.writer || (f.alsoWrittenBy || []).includes(s.file)),
        `family ${f.family} says ${f.writer} writes it, but no classified site lives there`);
    }
  });
});

// ---------------------------------------------------------------------------------------------
/*
 * ⛔ THE WRITE-SIDE INVENTORY HAD NO READ-SIDE TWIN, AND THE MISSING HALF WAS THE ONE THAT FAILED.
 *
 * Every artifact above is classified by how it is WRITTEN. Nothing asked how it is READ — and an
 * artifact published by atomic rename can be observed, by any reader, momentarily ABSENT or locked.
 * `kernel/lib/closeout.js` wrote `.respawnpack/runtime/contract.json` with `stateLib.writeAtomic` and
 * read it back with `catch { return null }`; one injected ENOENT closed an OPEN delegation on paper
 * (PASS · alreadyClosed · "collaborate") while the file on disk still said delegate. Its delegation
 * archive had the same shape, where a failed read read as "no history" and the next write REPLACED the
 * history it had failed to read.
 *
 * So the inventory is completed here, in the direction that matters. It is BOUNDED on purpose — only
 * pack-owned artifacts published by ATOMIC REPLACEMENT are in it. Founder-authored configuration and
 * ordinary in-place writes cannot be caught mid-rename and are excluded WITH the reason, not by
 * omission: an inventory built from what is present cannot report an absence.
 */
describe('⛔ no reader of an atomically-replaced artifact is unclassified', () => {
  /*
   * Which registered families are published by ATOMIC REPLACEMENT, and by which primitive. This is the
   * bound: `stateLib.writeAtomic`, `_runtime.atomicWriteJSON`, and explicit temporary-file-plus-rename.
   */
  const ATOMIC = {
    'compiled-state': 'writeAtomic',
    'goal-contract': 'writeAtomic',
    'runtime-contract': 'writeAtomic',
    'delegation-archive': 'writeAtomic',
    'gate-verdict': 'writeAtomic',
    'session-baseline': 'atomicWriteJSON',
    'stop-decision': 'atomicWriteJSON',
    'savepoint-attempt': 'writeAtomic',
    'precompact-handoff': 'atomicWriteJSON',
    'index-lease': 'renameSync',
    'index-ownership': 'renameSync',
    // v0.3 · core/_io.js's writeAtomicText/writeAtomicJSON are the SAME temp-file-then-rename primitive
    // as stateLib.writeAtomic and _runtime.atomicWriteJSON, carried over verbatim per core/_io.js's own
    // header ("the MIGRATION TARGET for the other two, not a fourth spelling of a solved problem").
    'rollover-handoff': 'writeAtomicText',
    'handoff-verification-receipt': 'writeAtomicJSON',
    'threshold-latches': 'writeAtomicJSON',
    'cycle-record': 'writeAtomicJSON',
    /*
     * ⛔ W5 · the RECORD half of candidate-memory is published by core/_io.js's writeAtomicJSON —
     * the same primitive as the other core-owned families above — and the readers that matter
     * (core/memory/candidates.js's own read()/list(), and kernel/respawnpack.js's `memory candidates`
     * verb through it) open exactly that record. The AUDIT half is append-only (io.appendLine, no
     * atomicity claim) and is a write-only trail no declared reader opens back — the same split
     * rollover-journal already makes between its row and snapshot, just with the roles reversed: here
     * the atomic half is the one everyone reads, so the family is classified ATOMIC rather than
     * NOT_ATOMIC.
     */
    'candidate-memory': 'writeAtomicJSON',
  };

  /*
   * And everything else, with the reason it is out of the bound. A family in NEITHER map fails the
   * first test below, so a newly registered artifact cannot join the registry unclassified.
   */
  const NOT_ATOMIC = {
    requirements: { why: 'AUTHORED by the project — this pack has no writer for it at all, so there is no pack-owned replacement window to observe' },
    'task-queue': { why: 'AUTHORED by the planner (writer:null, the rework task list, decision 2.1) — this pack has no writer for it at all, so there is no pack-owned replacement window to observe. The same class as requirements, evidence, removals-registry and pairs-registry: a file with no writer in this pack cannot be caught mid-write by this pack\'s own code, because this pack never writes it at all. It now HAS a reader (adapters/claude-code/task-runner/runner.js, P5-T-16a) and that changes nothing here: a reader needs the retrying boundary because the file it opens may be mid-rename, and nothing in this pack ever renames this one' },
    /*
     * ⛔ P5-T-16b · created with `wx`, exactly like consumption-receipt below, and one step stronger:
     * this file is never replaced OR reclaimed. Each attempt writes its own path and a taken path is
     * reported with the record it already holds, so there is no replacement window for a reader to
     * observe and no reader in this tree yet to observe one.
     */
    'task-attempt': { why: 'created with O_EXCL / CREATE_NEW (core/_io.js createExclusive) and never replaced: one file per task attempt, the attempt number in the name, and a path that is already taken is reported with the first record rather than overwritten. There is no rename window to observe because nothing ever renames over it — the exclusivity IS the synchronization, the same role it plays for consumption-receipt', anchor: 'io.createExclusive(file,', writer: 'adapters/claude-code/task-runner/runner.js' },
    /*
     * ⛔ P4-M-4 · the same class as task-attempt, with the id DERIVED rather than counted. One file per
     * bounded offload, the id computed from the input digest and the task class, so the same unit of
     * work against the same project lands on the same path and the exclusive create is what refuses the
     * repeat. A random id would have made every run a new file and the exclusivity a formality.
     */
    'offload-receipt': { why: 'created with O_EXCL / CREATE_NEW (core/_io.js createExclusive) and never replaced: one file per bounded offload, the id derived from the input digest and the task class rather than generated, and a path that is already taken refuses the run rather than being overwritten. There is no rename window to observe because nothing ever renames over it — the exclusivity IS the synchronization, exactly as it is for task-attempt and consumption-receipt', anchor: 'io.createExclusive(receiptPath,', writer: 'adapters/providers/offload.js' },
    evidence: { why: "AUTHORED by the project's qualifying tooling — this pack never writes an evidence artifact, so no rename of one is ever in flight" },
    'removals-registry': { why: 'AUTHORED by the project (path overridable in config) — this pack reads it and never writes it, so it publishes no replacement window' },
    lineage: { why: 'AUTHORED by the founder or the planner (writer:null) — this pack reads the provenance DECLARATION and never writes it, so it publishes no replacement window. The same class as requirements, evidence and removals-registry, and for the same reason: a file with no writer in this pack cannot be caught mid-write by this pack\'s own code. kernel/lib/lineage.js routes through hooks/_artifact.js anyway, which costs nothing and keeps absent, unreadable and malformed apart' },
    'reconciliation-source': { why: "AUTHORED by the project or produced by an adapter on stdout — never written by this pack, and an adapter's stdout is not a file at all" },
    'atomic-task': { why: 'AUTHORED outside the pack — the hooks read it to report what a session declared, and nothing here ever replaces it' },
    'pairs-registry': { why: 'HAND-AUTHORED (writer:null) — no code in this pack ever publishes docs/derived/state/pairs.json, by rename or otherwise, so there is no replacement window for a reader to observe. The same class as requirements, evidence and removals-registry: a file with no writer in this pack cannot be caught mid-write by this pack\'s own code, because this pack never writes it at all' },
    'capability-register': { why: 'HAND-AUTHORED (writer:null) — spine/reference/models/capability-register.json is pack SOURCE, edited by a maintainer and committed, and no code in this pack writes it by rename or otherwise. The same class as pairs-registry, one step further out: it does not even live inside an installed target yet. Its eventual reader (core/policy/routing.js, task M-2) will read it as an installed standards file, which the installer copies wholesale rather than replacing under contention' },
    'project-config': {
      why: 'founder-authored configuration — seeded once by the installer and then owned by the project. Explicitly outside this inventory: it is not runtime state, it is not replaced under contention, and treating it as such would widen a concurrency fence into a config linter',
    },
    'skill-meta': { why: 'written IN PLACE by kernel/lib/living.js, never replaced by rename', anchor: 'fs.writeFileSync(metaPath, `${JSON.stringify(meta', writer: 'kernel/lib/living.js' },
    'spawn-counter': { why: 'written IN PLACE by hooks/spawn-guard.js, and its read-modify-write runs entirely inside _runtime.withLock — the lock, not a retry, is what excludes a concurrent writer', anchor: 'fs.writeFileSync(file, JSON.stringify({ count: Math.max(0, count)', writer: 'hooks/spawn-guard.js' },
    'push-authorization': { why: 'written IN PLACE by hooks/push-guard.js, never replaced by rename', anchor: 'fs.writeFileSync(consumedFile, JSON.stringify({ at, firstAt: at, cmd', writer: 'hooks/push-guard.js' },
    /*
     * ⛔ v0.3 · consumption-receipt is created with `wx` (O_EXCL / CREATE_NEW — core/_io.js createExclusive),
     * not published by rename. There is no replacement window at all: the file either does not exist yet
     * (ENOENT, the ordinary pre-creation state) or was created complete by whichever caller won the race,
     * and every OTHER caller learns that from EEXIST rather than by reading a partially-written file. The
     * exclusivity is the synchronization primitive here, the same role withLock plays for spawn-counter.
     */
    'consumption-receipt': { why: 'created with O_EXCL / CREATE_NEW (core/_io.js createExclusive) — there is no replacement window to observe, because the file is never replaced: exactly one caller creates it and every other caller learns that from EEXIST rather than from a transient read', anchor: "kind: 'consumption-receipt',", writer: 'core/lifecycle/consumable.js' },
    /*
     * ⛔ v0.3 · rollover-journal covers TWO shapes (see the family's own description) with different
     * durability: the snapshot IS published by rename (core/lifecycle/journal.js writeSnapshot), but it
     * is explicitly a fast path NEVER trusted as authority, and no reader this registration declares opens
     * it. The journal itself is APPEND-ONLY — core/_io.js's own header states appendLine makes no atomicity
     * claim — but its crash behaviour is a NAMED, different mechanism (a torn TAIL, detected because an
     * incomplete final line fails to parse) from the transient-absence-during-rename problem this
     * ATOMIC/NOT_ATOMIC split exists to catch. A reader of appended lines does not need the retrying
     * classified boundary; it needs the torn-tail fold, which core/lifecycle/journal.js already is.
     */
    'rollover-journal': { why: 'the row half is APPEND-ONLY (core/_io.js appendLine makes no atomicity claim by design) and the snapshot half is a fast-path cross-check no declared reader opens directly — the crash-safety property that matters here is torn-tail detection on read, a different and already-covered mechanism from the transient-absence-during-rename race this split exists to catch' },
  };

  /*
   * Every production reader of an atomically-replaced artifact, and HOW it reaches the retrying,
   * classifying boundary — `via` is a substring that must be present in that reader's source, so a
   * refactor that quietly drops the boundary fails here rather than in a race nobody can schedule.
   * `excluded` records a reader that does not open the file at all, or one where concurrent replacement
   * is impossible by construction.
   */
  const READERS = [
    // --- compiled-state ---------------------------------------------------------------------------
    { family: 'compiled-state', file: 'kernel/lib/state.js', via: 'artifact.readJSONClassified' },
    { family: 'compiled-state', file: 'kernel/lib/render.js', excluded: 'never opens STATE.json — it is handed the compiled object by its caller, and the fence below proves it reads no file at all' },
    { family: 'compiled-state', file: 'kernel/lib/closeout.js', via: 'stateLib.compile' },
    { family: 'compiled-state', file: 'kernel/respawnpack.js', via: 'stateLib.read' },
    { family: 'compiled-state', file: 'hooks/_runtime.js', via: "require('./_artifact.js')" },
    { family: 'compiled-state', file: 'hooks/session-routing-nudge.js', via: 'rt.readDurableState' },

    // --- goal-contract ----------------------------------------------------------------------------
    { family: 'goal-contract', file: 'kernel/lib/state.js', via: 'artifact.loadGoalDoc' },
    { family: 'goal-contract', file: 'kernel/lib/closeout.js', via: 'stateLib.readGoalDocClassified' },
    { family: 'goal-contract', file: 'kernel/respawnpack.js', via: 'stateLib.readGoalDoc' },
    { family: 'goal-contract', file: 'hooks/_runtime.js', via: "require('./_artifact.js')" },
    { family: 'goal-contract', file: 'hooks/_manifest.js', excluded: 'DIGESTS the bytes for the freshness manifest and never parses the document — there is no field it could misread' },

    // --- runtime-contract · the artifact the reported failure was about ----------------------------
    { family: 'runtime-contract', file: 'kernel/lib/closeout.js', via: 'artifact.readJSONClassified' },
    { family: 'runtime-contract', file: 'kernel/respawnpack.js', via: 'closeout.readRuntimeClassified' },
    { family: 'runtime-contract', file: 'hooks/_runtime.js', via: "require('./_artifact.js')" },
    { family: 'runtime-contract', file: 'hooks/session-routing-nudge.js', via: 'rt.readContract' },
    { family: 'runtime-contract', file: 'hooks/context-monitor.js', via: 'rt.readContract' },
    { family: 'runtime-contract', file: 'hooks/precompact-ledger-nudge.js', via: 'rt.readContract' },
    /*
     * ⛔ P5-T-16b · THE TASK RUNNER READS IT THROUGH core/_io.js, NOT THROUGH rt.readContract, AND THE
     * DIFFERENCE IS THE WHOLE REASON IT IS LISTED SEPARATELY. `readContract` degrades an unreadable
     * file to `collaborate`, which is conservative for a HOOK (the most ceremony, the least authority)
     * and is the DANGEROUS direction here: `collaborate` is exactly what a CLOSED delegation looks
     * like, so degrading would turn a transient read failure into "the task was completed". The
     * classifying boundary keeps the five answers apart, which is what this fence is about.
     */
    { family: 'runtime-contract', file: 'adapters/claude-code/task-runner/runner.js', via: 'io.readJSONClassified' },
    /*
     * ⛔ P5-CT-7 · THE STOP HOOK IS IN THE SAME POSITION AS THE RUNNER, ONE LAYER EARLIER, AND SO IT
     * TAKES THE SAME ROUTE. Its delegation gate asks whether an open bounded task was ever attested to;
     * `rt.readContract`, which every OTHER hook row here uses, degrades an unreadable file to
     * `collaborate` — the shape a CLOSED delegation leaves behind — so routing this read through it
     * would answer "the task was completed" out of a transient rename window. It reaches the boundary
     * directly instead, and reports a read it could not classify on stderr rather than deciding on it.
     */
    { family: 'runtime-contract', file: 'hooks/stop-savepoint.js', via: 'artifact.readJSONClassified' },

    // --- delegation-archive -----------------------------------------------------------------------
    { family: 'delegation-archive', file: 'kernel/lib/closeout.js', via: 'readDelegationArchive' },
    // The attestation record itself: closing a delegation returns runtime to collaborate, so
    // contract.json can say a delegation is no longer open and cannot say WHICH criteria were restated.
    { family: 'delegation-archive', file: 'adapters/claude-code/task-runner/runner.js', via: 'io.readJSONClassified' },

    // --- the hook-tree runtime records ------------------------------------------------------------
    { family: 'session-baseline', file: 'hooks/_runtime.js', via: "require('./_artifact.js')" },
    { family: 'session-baseline', file: 'hooks/stop-savepoint.js', via: 'rt.sessionDelta' },
    { family: 'session-baseline', file: 'hooks/precompact-ledger-nudge.js', via: 'rt.sessionDelta' },
    { family: 'stop-decision', file: 'hooks/_runtime.js', via: "require('./_artifact.js')" },
    { family: 'stop-decision', file: 'hooks/stop-savepoint.js', via: 'rt.alreadyStoppedOn' },
    // field run §4 — the savepoint receipt. Written by the KERNEL, read only in the hook tree, so it is the
    // one family whose two halves live on opposite sides of the kernel/hooks boundary. The read goes
    // through rt.readSavepointAttempt, which is _runtime.readJSON, which is _artifact.js's retrying
    // boundary — the same path stop-decision takes, and it matters more here: the kernel replaces this
    // file by rename at the end of a savepoint, which is exactly when a Stop hook is likely to read it.
    { family: 'savepoint-attempt', file: 'hooks/stop-savepoint.js', via: 'rt.readSavepointAttempt' },
    { family: 'precompact-handoff', file: 'hooks/_runtime.js', via: "require('./_artifact.js')" },
    { family: 'precompact-handoff', file: 'hooks/session-routing-nudge.js', via: 'rt.takePrecompactHandoff' },

    /*
     * ⛔ v0.3 · THE ROLLOVER CORE'S READERS. `core.handoff.consume()` performs its OWN classified read
     * internally (core/state/handoff.js `read()`, via core/_io.js `readTextClassified` — the same
     * retrying boundary `_artifact.js` provides for the hook tree, carried over per core/_io.js's own
     * header). hooks/session-routing-nudge.js reaches it through that ONE call, never by opening the
     * handoff or its verification receipt itself.
     */
    { family: 'rollover-handoff', file: 'hooks/session-routing-nudge.js', via: 'core.handoff.consume' },
    { family: 'handoff-verification-receipt', file: 'hooks/session-routing-nudge.js', via: 'core.handoff.consume' },
    { family: 'threshold-latches', file: 'hooks/context-monitor.js', via: 'core.thresholds.readLatches' },
    { family: 'cycle-record', file: 'hooks/context-monitor.js', via: 'core.cycle.readPersisted' },
    { family: 'cycle-record', file: 'hooks/session-routing-nudge.js', via: 'core.cycle.readPersisted' },

    // --- candidate-memory (W5) — the RECORD half only; the audit half is append-only, covered by
    // NOT_ATOMIC's reasoning elsewhere, not by this list of atomic-replacement readers -------------
    { family: 'candidate-memory', file: 'core/memory/candidates.js', via: 'io.readJSONClassified' },
    { family: 'candidate-memory', file: 'kernel/respawnpack.js', via: 'core.candidates.list' },
    { family: 'candidate-memory', file: 'hooks/session-routing-nudge.js', via: 'core.candidates.list' }, // P2-O-3: the boot line's candidate count, through the classified list()

    // --- the index lease · PROVEN excluded from the acquire/confirm/release protocol ---------------
    {
      family: 'index-lease',
      file: 'hooks/_index-lease.js',
      excluded: 'every writer of the lease record (acquire, confirm) and its only deleter (release) run inside withLock, '
        + 'and every read of it in the protocol — including acquire\'s read-back — is inside that same lock. No reader can be '
        + 'concurrent with a replacement of what it is reading, so there is no rename window to misclassify. A non-ENOENT '
        + 'failure is already {error}, which every caller maps to CANNOT_DETERMINE and denies.',
      proof: { file: 'hooks/_index-lease.js', mustContain: ['withLock(file, () => {', 'readLease(projectDir, identity)'] },
    },
    { family: 'index-lease', file: 'hooks/index-guard.js', excluded: 'never opens the lease record; it calls acquire/confirm/release, which read it under the lock' },

    // --- the ownership ledger · NOT excluded, and this is the one the lease actually got wrong -----
    { family: 'index-ownership', file: 'hooks/_index-lease.js', via: 'readOwnedClassified' },
    { family: 'index-ownership', file: 'hooks/index-guard.js', excluded: 'never opens the ledger; it calls foreignStates and recordOwned, which read it through the classified reader' },
  ];

  /*
   * Every remaining raw `JSON.parse(fs.readFileSync(...))` in the scanned tree, with the reason a
   * transient replacement window cannot reach it. The sweep below finds these mechanically, so a NEW
   * raw reader — including one aimed at a new pack-owned atomic artifact — fails until it is either
   * routed through the boundary or justified here.
   */
  const RAW_READS = [
    { file: 'kernel/respawnpack.js', line: 214, why: 'respawnpack.config.json and .claude/settings.json — founder- and host-owned configuration, written by the installer or by hand, never replaced by rename under contention' },
    { file: 'kernel/lib/applicability.js', line: 233, why: 'respawnpack.config.json — founder-authored configuration, outside this inventory by the same rule as every other config read here; the applicability survey reads DECLARATIONS only and never a pack-published artifact' },
    { file: 'kernel/lib/applicability.js', line: 446, why: "the project's own removal registry, read to learn whether a retirement baseline exists at all. It is project-authored (the path is founder-overridable), and a read failure here is reported as an absent baseline rather than thrown — kernel/lib/removals.js remains the authority that classifies the same file for the scan" },
    { file: 'kernel/lib/gate.js', line: 104, why: "the target project's package.json and respawnpack.config.json — both founder-authored, neither pack-owned nor atomically replaced" },
    { file: 'kernel/lib/living.js', line: 53, why: '.skill-meta.json, which kernel/lib/living.js writes IN PLACE — there is no rename window to observe' },
    { file: 'kernel/lib/memory.js', line: 37, why: 'respawnpack.config.json and .mcp.json — founder- and host-owned configuration, edited by hand or by the installer and never replaced by rename' },
    { file: 'kernel/lib/readiness.js', line: 154, why: "the target project's package.json and respawnpack.config.json — both founder-authored, neither pack-owned nor atomically replaced, and read here for exactly the same two facts kernel/lib/gate.js reads them for: which scripts a manifest declares, and what the config declares about the quality gate. The readiness checklist never reads a pack-published artifact, and its companion `readText` is what separates absent from unreadable so an unparseable manifest is CANNOT_DETERMINE rather than a missing test command" },
    { file: 'kernel/lib/reconcile.js', line: 99, why: 'respawnpack.config.json — founder-authored configuration, outside this inventory by the same rule as every other config read here' },
    { file: 'kernel/lib/removals.js', line: 181, why: 'respawnpack.config.json — founder-authored configuration, outside this inventory by the same rule as every other config read here' },
    { file: 'hooks/_manifest.js', line: 125, why: "respawnpack.config.json — read only to learn the project's DECLARED state.removals.registry path, so a custom registry is freshness-bound like the default one. Founder-authored configuration, never pack-published and never replaced by rename; a read failure yields no extra manifest entry rather than throwing inside a digest routine" },
    { file: 'hooks/_manifest.js', line: 167, why: "respawnpack.config.json again, parsed this time rather than hashed whole, because manifest v2 removes MANIFEST_EXCLUDED ('posture') before digesting a canonical serialization of what is left. Founder-authored configuration, never pack-published and never replaced by rename; a parse failure falls back to the raw-byte digest, so a config nobody can read still counts as CHANGED rather than as fresh" },
    { file: 'hooks/push-guard.js', line: 259, why: 'push.consumed, which this same file writes IN PLACE with fs.writeFileSync' },
    { file: 'hooks/context-monitor.js', line: 179, why: 'the OPT-IN statusline tee (adapters/claude-code/statusline/), read DELIBERATELY OUTSIDE core/_io.js\'s retrying boundary so this measurement source survives a broken core/ the same way the byte-proxy fallback does; a stale or absent tee is read as "no source", never as a fault, because it is gitignored, opt-in, and rewritten by an independent process every call' },
    { file: 'hooks/spawn-guard.js', line: 134, why: 'the spawn counter, written IN PLACE and read-modified-written entirely inside _runtime.withLock — exclusivity comes from the lock, not from a retry' },
    { file: 'hooks/_index-lease.js', line: 331, why: 'readLease — PROVEN excluded above: every read and every write of the lease record happens inside withLock' },
    { file: 'hooks/_index-lease.js', line: 544, why: 'releaseAll\'s filter read. Nothing is deleted on its word: release() re-reads the record UNDER the lock and refuses unless this principal still holds it, so a transient failure skips a release (the lease then expires on its own clock) and can never hand one to the wrong principal' },
    /*
     * ⛔ P4-M-5 · commit ee13bef IS THE PRECEDENT FOR RE-PINNING THIS LINE. An edit that shifts lines
     * above it moves this number; re-pin the number only and keep this `why` verbatim.
     */
    { file: 'adapters/claude-code/task-runner/runner.js', line: 795, why: 'the capability register (spine/reference/models/capability-register.json or a target\'s installed docs/reference/models/ copy) — a STATIC reference file this pack or its target ships, never written concurrently and never replaced by rename. loadCapabilityRegister() already treats ABSENT and UNREADABLE identically (both fall back to core.routing.route()\'s own general-fallback answer, which is the honest response to a register that is not there to consult), so the classified retrying boundary\'s ABSENT/UNREADABLE/MALFORMED split would buy nothing a plain try/catch does not already give this reader' },
  ];

  const SCANNED_DIRS = ['kernel/lib', 'kernel', 'hooks', 'adapters/claude-code/task-runner'];
  const scannedFiles = () => {
    const out = [];
    for (const d of SCANNED_DIRS) {
      for (const f of fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })) {
        if (f.isFile() && f.name.endsWith('.js')) out.push(path.posix.join(d, f.name));
      }
    }
    return out;
  };

  test('every registered family is classified as atomically replaced or explicitly not — a new artifact cannot be invisible', () => {
    const unclassified = REGISTRY.families
      .map((f) => f.family)
      .filter((f) => !(f in ATOMIC) && !(f in NOT_ATOMIC));
    assert.deepEqual(unclassified, [],
      'these registered families say nothing about how they are published, so nothing can say whether their readers '
      + `need the retrying boundary:\n  ${unclassified.join('\n  ')}`);

    for (const f of Object.keys(ATOMIC)) assert.ok(familyNamed(f), `${f} is classified as atomic but is not in the registry`);
    for (const [f, e] of Object.entries(NOT_ATOMIC)) {
      assert.ok(familyNamed(f), `${f} is classified as non-atomic but is not in the registry`);
      assert.ok(e.why && e.why.length > 60, `the non-atomic classification for ${f} is a label, not a justification`);
    }
  });

  test('the atomic/non-atomic classification matches the writer that is actually there', () => {
    for (const [family, primitive] of Object.entries(ATOMIC)) {
      const f = familyNamed(family);
      if (!f.writer) continue;
      assert.ok(src(f.writer).includes(primitive),
        `${family} is classified as published by ${primitive}, which does not appear in its writer ${f.writer}`);
    }
    /*
     * The other direction, which is the one that rots quietly: a family called "written in place" whose
     * writer has since been converted to atomic replacement would leave its readers unfenced.
     */
    for (const [family, e] of Object.entries(NOT_ATOMIC)) {
      if (!e.anchor) continue;
      const text = src(e.writer);
      assert.ok(text.includes(e.anchor), `the in-place write site for ${family} is gone from ${e.writer}: ${e.anchor}`);
      const line = text.split(/\r?\n/).find((l) => l.includes(e.anchor));
      assert.doesNotMatch(line, /writeAtomic|atomicWriteJSON|renameSync/,
        `${family} is classified as written IN PLACE, but its write site now replaces by rename — its readers need the retrying boundary`);
    }
  });

  test('⛔ every declared reader of an atomically-replaced artifact reaches the classified boundary', () => {
    for (const f of Object.keys(ATOMIC)) {
      const declared = (familyNamed(f).readers || []);
      const covered = READERS.filter((r) => r.family === f).map((r) => r.file);
      const missing = declared.filter((d) => !covered.includes(d));
      assert.deepEqual(missing, [],
        `family ${f} is atomically replaced and the registry names readers that this inventory does not classify: ${missing.join(', ')}`);
      const stale = covered.filter((c) => !declared.includes(c));
      assert.deepEqual(stale, [], `family ${f} classifies readers the registry does not declare: ${stale.join(', ')}`);
    }

    for (const r of READERS) {
      assert.ok(ATOMIC[r.family], `${r.file} is classified as a reader of ${r.family}, which is not an atomically-replaced family`);
      if (r.via) {
        assert.ok(src(r.file).includes(r.via),
          `${r.file} is recorded as reading ${r.family} via \`${r.via}\`, and that is no longer in its source. `
          + 'Either it stopped using the retrying boundary — which is the defect this fence exists for — or the record is stale.');
      } else {
        assert.ok(r.excluded && r.excluded.length > 60, `${r.file} is excluded as a reader of ${r.family} without a real reason`);
      }
    }
  });

  test('the exclusions are verified against the tree, not asserted', () => {
    // render.js "never opens the file" is checkable, so it is checked.
    assert.doesNotMatch(src('kernel/lib/render.js'), /readFileSync/,
      'kernel/lib/render.js is excluded because it opens no file, and it now opens one');

    // The lease's exclusion rests entirely on the lock. If a read of the record ever moves outside
    // withLock, the proof expires — so the shape it depends on is asserted.
    for (const r of READERS) {
      if (!r.proof) continue;
      for (const needle of r.proof.mustContain) {
        assert.ok(src(r.proof.file).includes(needle),
          `the exclusion for ${r.family} in ${r.file} depends on \`${needle}\`, which is gone from ${r.proof.file}`);
      }
    }
    const lease = src('hooks/_index-lease.js');
    for (const fn of ['function acquire', 'function confirm', 'function release']) {
      const body = lease.slice(lease.indexOf(fn), lease.indexOf(fn) + 1400);
      assert.match(body, /withLock\(file/,
        `${fn} no longer runs inside withLock — the index-lease read exclusion was proven from that lock and is now false`);
    }
  });

  test('⛔ every raw JSON read in the scanned tree is classified — a new one cannot slip in unfenced', () => {
    const found = [];
    for (const rel of scannedFiles()) {
      src(rel).split(/\r?\n/).forEach((line, i) => {
        if (!/JSON\.parse\s*\(/.test(line) || !/readFileSync/.test(line)) return;
        if (/^\s*(\*|\/\/)/.test(line)) return; // prose about a read is not a read
        found.push({ file: rel, line: i + 1 });
      });
    }
    assert.ok(found.length >= 8, `only ${found.length} raw reads found — the sweep is not reaching the tree`);

    const unclassified = found
      .filter((f) => !RAW_READS.some((r) => r.file === f.file && r.line === f.line))
      .map((f) => `${f.file}:${f.line}`);
    assert.deepEqual(unclassified, [],
      'these raw JSON readers are classified nowhere. If the file they read is a pack-owned artifact published by '
      + 'atomic replacement, route it through hooks/_artifact.js; otherwise add it to RAW_READS with the reason a '
      + `replacement window cannot reach it:\n  ${unclassified.join('\n  ')}`);

    // Two-sided: a classification that no longer points at a raw read is a fence about nothing.
    const stale = RAW_READS
      .filter((r) => !found.some((f) => f.file === r.file && f.line === r.line))
      .map((r) => `${r.file}:${r.line}`);
    assert.deepEqual(stale, [], `these raw-read classifications no longer match a raw read (line moved, or the read is gone):\n  ${stale.join('\n  ')}`);
    for (const r of RAW_READS) assert.ok(r.why.length > 60, `the classification for ${r.file}:${r.line} is a label, not a justification`);
  });

  test('⛔ the artifact the failure was reported against is fenced by name', () => {
    /*
     * The general sweeps above would pass if `contract.json` and `delegations.json` were read raw from a
     * file that also happened to be classified. These two are named, because they are what broke.
     */
    const closeout = src('kernel/lib/closeout.js');
    assert.doesNotMatch(closeout, /JSON\.parse\s*\([^)]*readFileSync/,
      'kernel/lib/closeout.js reads JSON raw again — this is the exact reader whose restoration is killed by kernel/kernel.test.mjs');
    assert.ok(closeout.includes('_artifact.js'), 'kernel/lib/closeout.js no longer routes through the shared artifact boundary');
    for (const fn of ['readRuntimeClassified', 'readDelegationArchive']) {
      assert.ok(closeout.includes(`function ${fn}`), `kernel/lib/closeout.js lost ${fn} — the classified read of a runtime artifact`);
    }
    assert.ok(src('kernel/respawnpack.js').includes('closeout.readRuntimeClassified'),
      'the `contract` verb reads the runtime contract its own way again — inspection and closure must share one interpretation');
  });
});

// ---------------------------------------------------------------------------------------------
describe('schema → code: nothing is declared that nobody writes', () => {
  test('every property a schema declares appears in its writer (or is a documented legacy/read-only field)', () => {
    // Fields the pack READS but never writes are legitimate and are named here, so the fence stays
    // two-sided instead of being loosened into uselessness.
    const READ_ONLY = new Set(['activeGoalId', 'goalId', 'milestone', 'milestoneComplete', 'currentAtomicTask',
      'ownerConfirmations', 'killedFeatures', 'criterion', 'completion', 'externalBlockers', 'legacyShape',
      'authority', 'forbidden', 'constraints', 'goal', 'reason', 'controls', 'good', 'bad', 'risk', 'feature',
      'requires', 'gates', 'dependsOn', 'blockedBy', 'waived', 'priority', 'mandatory', 'title', 'id',
      'denominatorVersion', 'requirements', 'missingAuthority', 'firstAt', 'file',
      // respawnpack.config.json is seeded by the installer and then OWNED by the founder: the gate,
      // removal and adapter keys are read by kernel/lib/*, never written by install.js.
      'qualityGate', 'notApplicable', 'checks', 'adapters', 'registry', 'liveContentDirs',
      'extensions', 'historyPaths', 'exclude', 'critical', 'timeoutMs', 'command', 'args',
      // DF-005 reconciliation: the config keys are read by kernel/lib/reconcile.js and the `tasks`
      // count is composed by it, not by state.js — the installer seeds neither.
      'reconcile', 'tasks', 'openStatuses', 'closedStatuses', 'kind', 'pointer', 'ignore',
      /*
       * ⛔ THESE FOUR ARE QUALIFIED BY FAMILY, AND THAT IS THE POINT (P1-E-1a). The declared-exception
       * keys are read by `hooks/_exceptions.js` and written by nobody, which is the same class the
       * config keys above are in. A BARE `fingerprint` here would have excused `stop-decision`'s own
       * `fingerprint` as well, and that one IS written — so an exemption for a founder-owned key would
       * have quietly stopped covering a pack-written one. A qualified entry exempts exactly the family
       * it names.
       */
      'project-config.fingerprint', 'project-config.declaredBy',
      'project-config.declaredAt', 'project-config.expires',
      /*
       * ⛔ AND THE PROVIDER BLOCK, QUALIFIED FOR THE SAME REASON (P4-M-3). `providers` is declared by
       * the FOUNDER and read by `adapters/openai-compatible/client.js` and its probe; the installer
       * seeds nothing here and must not, because the block names the environment variable that holds a
       * credential and a seeded default would be a provider nobody chose. `models` is qualified rather
       * than left to the bare word match it currently gets in install.js, so this exemption states the
       * decision instead of resting on a coincidence of vocabulary.
       */
      'project-config.providers', 'project-config.protocol', 'project-config.baseUrl',
      'project-config.apiKeyEnv', 'project-config.models']);
    const missing = [];
    for (const f of REGISTRY.families) {
      if (!f.writer) continue;
      const writers = [f.writer, ...(f.alsoWrittenBy || [])].map(src).join('\n');
      for (const p of declaredProps(schemaOf(f.schema))) {
        if (READ_ONLY.has(p) || READ_ONLY.has(`${f.family}.${p}`)) continue;
        if (!new RegExp(`\\b${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(writers)) missing.push(`${f.family}.${p} (writer ${f.writer})`);
      }
    }
    assert.deepEqual(missing, [], `these schema properties appear in no writer — a schema that invents a field documents nothing:\n  ${missing.join('\n  ')}`);
  });
});

// ---------------------------------------------------------------------------------------------
describe('every exclusion justification is verified, not asserted', () => {
  const codeFiles = () => ['kernel/lib', 'kernel', 'hooks', 'install']
    .flatMap((d) => fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })
      .filter((f) => f.isFile() && f.name.endsWith('.js'))
      .map((f) => path.posix.join(d, f.name)));

  test('"no code reads HANDOFF.json" — checked against the tree, not claimed', () => {
    const readers = codeFiles().filter((rel) => /HANDOFF\.json/.test(src(rel)));
    assert.deepEqual(readers, [], `HANDOFF.json is excluded from the product schema set as an audit record, but these read it: ${readers.join(', ')}`);
  });

  test('"no reader names a field of atomic-task" — checked, because the open schema rests on it', () => {
    const offenders = [];
    for (const rel of codeFiles()) {
      for (const m of src(rel).matchAll(/atomicTask\s*\.\s*([A-Za-z_$][\w$]*)/g)) offenders.push(`${rel}: atomicTask.${m[1]}`);
    }
    assert.deepEqual(offenders, [],
      'atomic-task.schema.json is deliberately open BECAUSE no reader names a field of it. One does now, so the '
      + `schema must grow to match: ${offenders.join(', ')}`);
  });
});

// ---------------------------------------------------------------------------------------------
describe('code → schema: artifacts CAPTURED FROM REAL RUNS conform', () => {
  /*
   * ⛔ NOT HAND-AUTHORED FIXTURES. A fixture I write from reading the writer proves that I read it the
   * same way twice. These documents come out of the real CLI and the real hooks, so `additionalProperties:
   * false` is doing the work it exists for: a writer that starts emitting an undeclared field fails here.
   */
  function project() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-schema-'));
    const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    git('init', '--quiet', '--initial-branch=main');
    git('config', 'user.email', 's@respawnpack.test'); git('config', 'user.name', 'Schema');
    git('config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(dir, 'README.md'), '# fixture\n');
    const sd = path.join(dir, stateLib.STATE_DIR);
    fs.mkdirSync(path.join(sd, 'evidence'), { recursive: true });
    fs.writeFileSync(path.join(sd, 'requirements.json'), JSON.stringify({
      schemaVersion: '1.0.0', denominatorVersion: 'schema-1',
      requirements: [{ id: 'R-1', title: 'one', mandatory: true, gate: 'G1' }, { id: 'R-2', title: 'two', mandatory: true, risk: 'high' }],
      gates: { G1: { title: 'gate one', requires: ['R-1'] } },
    }, null, 2));
    git('add', '-A'); git('commit', '--quiet', '-m', 'init');
    return dir;
  }
  const cli = (dir, ...args) => spawnSync(process.execPath, [CLI, ...args, '--dir', dir], { encoding: 'utf8', timeout: 120000 });

  test('STATE.json — both shapes, from the real compiler', () => {
    const dir = project();
    try {
      assert.equal(cli(dir, 'state').status, 0, 'the compiler refused to run');
      capture(path.join(dir, stateLib.STATE_FILE), 'state.schema.json', 'the TRACKED STATE.json');

      // And the reduced shape, which is a real fork and not an edge case.
      fs.rmSync(path.join(dir, stateLib.STATE_DIR, 'requirements.json'));
      cli(dir, 'state');
      const reduced = readJSON(path.join(dir, stateLib.STATE_FILE));
      assert.equal(reduced.tracksRequirements, false, 'the fixture did not actually produce the untracked shape');
      capture(path.join(dir, stateLib.STATE_FILE), 'state.schema.json', 'the UNTRACKED STATE.json');
    } finally { rm(dir); }
  });

  test('goal.json and the runtime contract — from the real `contract` verbs', () => {
    const dir = project();
    try {
      const g = cli(dir, 'contract', 'goal', '--id', 'G-1', '--goal', 'ship it',
        '--completion', 'all-mandatory-conformant;no-open-p0', '--constraints', 'no pushes',
        '--authority', 'edit code', '--forbidden', 'git push');
      assert.equal(g.status, 0, `contract goal failed: ${g.stderr || g.stdout}`);
      const rc = path.join(dir, '.respawnpack', 'runtime', 'contract.json');
      capture(path.join(dir, stateLib.STATE_DIR, 'goal.json'), 'goal.schema.json', 'goal.json after `contract goal`');
      capture(rc, 'runtime-contract.schema.json', 'contract.json in GOAL mode');

      assert.equal(cli(dir, 'contract', 'collaborate').status, 0);
      assert.equal(readJSON(rc).suspendedGoalId, 'G-1', 'collaborate did not SUSPEND the goal, so this shape is untested');
      capture(rc, 'runtime-contract.schema.json', 'contract.json with a SUSPENDED goal');

      const d = cli(dir, 'contract', 'delegate', '--task', 'write the CSV writer', '--acceptance', 'tests pass;docs updated');
      assert.equal(d.status, 0, `contract delegate failed: ${d.stderr || d.stdout}`);
      capture(rc, 'runtime-contract.schema.json', 'contract.json in DELEGATE mode');
    } finally { rm(dir); }
  });

  test('delegations.json — from a real attested closure', () => {
    const dir = project();
    try {
      cli(dir, 'contract', 'delegate', '--task', 'write the CSV writer', '--acceptance', 'tests pass;docs updated');
      const c = cli(dir, 'contract', 'complete', '--met', 'tests pass', '--met', 'docs updated', '--evidence', 'suite green');
      assert.equal(c.status, 0, `the closure was refused: ${c.stderr || c.stdout}`);
      const archive = path.join(dir, '.respawnpack', 'runtime', 'delegations.json');
      assert.equal(readJSON(archive).completed.length, 1, 'nothing was archived, so this shape is untested');
      capture(archive, 'delegations.schema.json', 'delegations.json');
    } finally { rm(dir); }
  });

  test('the gate verdict — from a real gate run, in two different outcomes', () => {
    const dir = project();
    try {
      const vf = path.join(dir, 'gate-verdict.json');
      cli(dir, 'gate', '--verdict-file', vf);
      /*
       * K-09: the verdict a bare project gets is CANNOT_DETERMINE at exit 2 — the same refusal, in the
       * pack's one vocabulary — and the gate's own NOT_CONFIGURED survives beside it as `label`. Both
       * are asserted, because a capture that only checked the outcome would accept a document that had
       * quietly lost the diagnostic word this family exists to carry.
       */
      const unconfigured = readJSON(vf);
      assert.equal(unconfigured.outcome, 'CANNOT_DETERMINE', `expected CANNOT_DETERMINE on a bare project, got ${unconfigured.outcome}`);
      assert.equal(unconfigured.label, 'NOT_CONFIGURED', 'the gate lost its own word for a run that established nothing');
      capture(vf, 'gate-verdict.schema.json', 'the NOT_CONFIGURED verdict');

      fs.writeFileSync(path.join(dir, 'respawnpack.config.json'),
        JSON.stringify({ qualityGate: { notApplicable: true, reason: 'a documentation-only repository' } }, null, 2));
      cli(dir, 'gate', '--verdict-file', vf);
      assert.equal(readJSON(vf).outcome, 'NOT_APPLICABLE', 'the declared opt-out did not take effect');
      assert.equal(readJSON(vf).label, 'NOT_APPLICABLE');
      capture(vf, 'gate-verdict.schema.json', 'the DECLARED NOT_APPLICABLE verdict');
      /*
       * ⛔ NOT the project-config CAPTURE. This config was written by the test two lines up, so it can
       * only ever confirm that the schema matches the fixture — the installed-target block below says
       * the same thing at more length, over the defect that proved it. The family's capture is named
       * there, and fence 6 records it there.
       */
      conforms(readJSON(path.join(dir, 'respawnpack.config.json')), 'project-config.schema.json', 'the opt-out config this test wrote');
    } finally { rm(dir); }
  });

  test('the hook runtime artifacts — captured by running the REAL hooks on real stdin', () => {
    const repo = makeRepo('schema-hooks');
    try {
      const sid = 'schema-session-1';
      const rt = path.join(repo, '.respawnpack', 'runtime');
      const at = (p) => path.join(repo, p);

      // SessionStart → the session baseline.
      runHook('session-routing-nudge.js', stdinFor('SessionStart', { session_id: sid, cwd: repo }), { cwd: repo });
      capture(path.join(rt, `session-${sid}.json`), 'session-baseline.schema.json', 'the session baseline');

      // Real work, then Stop → the stop-decision record.
      fs.writeFileSync(at('worked.txt'), 'a real session edit\n');
      runHook('stop-savepoint.js', stdinFor('Stop', { session_id: sid, cwd: repo }), { cwd: repo });
      capture(path.join(rt, `stop-${sid}.json`), 'stop-decision.schema.json', 'the stop-decision record');

      // PreCompact → the handoff, which the writer verifies by reading back.
      runHook('precompact-ledger-nudge.js', stdinFor('PreCompact', { session_id: sid, cwd: repo, trigger: 'auto' }), { cwd: repo });
      const handoff = capture(path.join(rt, `precompact-${sid}.json`), 'precompact-handoff.schema.json', 'the PreCompact handoff');
      assert.equal(handoff.readBackVerified, true, 'the handoff was not read back, so the captured shape is the unverified one');

      // A dispatch → the spawn counter.
      runHook('spawn-guard.js', stdinFor('PreToolUse', { session_id: sid, cwd: repo, tool_name: 'Task', tool_input: { subagent_type: 'general-purpose', prompt: 'go' } }), { cwd: repo });
      capture(at(path.join('.respawnpack', `spawn-state-${sid}.json`)), 'spawn-state.schema.json', 'the spawn counter');

      // A staging operation → the index lease and the ownership ledger.
      fs.writeFileSync(at('staged.txt'), 'x\n');
      runHook('index-guard.js', stdinFor('PreToolUse', { session_id: sid, cwd: repo, tool_name: 'Bash', tool_input: { command: 'git add -- staged.txt' } }), { cwd: repo });
      const leases = fs.readdirSync(rt).filter((f) => /^index-lease-[0-9a-f]+\.json$/.test(f));
      assert.equal(leases.length, 1, `expected exactly one lease record, found ${leases.length} — the capture did not exercise the lease`);
      capture(path.join(rt, leases[0]), 'index-lease.schema.json', 'the index lease');

      execFileSync('git', ['add', '--', 'staged.txt'], { cwd: repo, stdio: 'ignore' });
      runHook('index-guard.js', stdinFor('PostToolUse', { session_id: sid, cwd: repo, tool_name: 'Bash', tool_input: { command: 'git add -- staged.txt' } }), { cwd: repo });
      capture(path.join(rt, `index-owned-${sid}.json`), 'index-owned.schema.json', 'the index ownership ledger');
    } finally { rm(repo); }
  });

  test('the context-monitor threshold latches and the push authorization — also from real hook runs', () => {
    const repo = makeRepo('schema-hooks-2');
    try {
      const sid = 'schema-session-2';
      /*
       * ⛔ WHAT THIS CAPTURE USED TO DO, AND WHY IT PROVED NOTHING — the defect fence 6 exists over.
       * It built `.respawnpack/context-monitor.state.json` and named `context-monitor-state.schema.json`.
       * Neither survives v0.3: the per-SESSION latch map became the per-CYCLE threshold-latches record,
       * no code path writes that path any more, and that schema file does not exist. Because the
       * assertion sat behind `if (fs.existsSync(...))` with an `else assert.ok(true)`, the miss was
       * unobservable — the else was taken on every run and the test passed having exercised nothing.
       *
       * ⛔ AND THE MEASUREMENT HAS TO BE REAL FOR THE RECORD TO BE. context-monitor.js reads occupancy
       * from the transcript's newest usage row; there is no percent-override env var, and the old
       * `RESPAWNPACK_CONTEXT_PERCENT` set nothing on top of a default `transcript_path` that names a
       * file which deliberately does not exist — so resolveMeasurement() returned null and the hook
       * exited before any threshold was consulted. Not one byte was written, which is precisely why
       * the existsSync guard read as coverage.
       *
       * ⭐ THE BUDGET AND THE STAGE LIST ARE PINNED, NOT INHERITED. Either one silently un-captures
       * this test if it moves: a token count ABOVE the budget takes the falsified-budget branch, which
       * writes nothing by design, and the stage list alone decides which keys `latched` gets. 82k of a
       * pinned 100k budget is 82% — past both pinned advisory stages and below the budget, so it
       * crosses thresholds instead of tripping the branch that returns before the latch store is
       * touched. Reading the defaults here would make a future default change look like a passing test.
       */
      const tp = path.join(repo, 'transcript.jsonl');
      fs.writeFileSync(tp, [
        JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }),
        JSON.stringify({ type: 'assistant', message: { role: 'assistant', usage: { input_tokens: 82000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 10 } } }),
      ].join('\n') + '\n');
      const cm = runHook('context-monitor.js', stdinFor('PostToolUse', { session_id: sid, cwd: repo, transcript_path: tp, tool_name: 'Read' }),
        { cwd: repo, env: { RESPAWNPACK_CONTEXT_BUDGET_TOKENS: '100000', RESPAWNPACK_CONTEXT_ADVISORY_STAGES: '60,80' } });
      assert.ok(cm.json, `the monitor was silent at 82% of a pinned 100k budget — it reached no threshold, so nothing was captured: ${cm.stderr}`);

      const latches = path.join(repo, '.respawnpack', 'runtime', 'rollover', `claude-code-${sid}`, 'thresholds.json');
      const latched = capture(latches, 'threshold-latches.schema.json', 'the context-monitor threshold latches');
      assert.deepEqual(Object.keys(latched.latched).sort(), ['60', '80'],
        'the capture latched something other than the two stages its own input pins — this is not the record the assertions here describe');
      /*
       * ⛔ A PostToolUse hook must never MINT machine state. No compaction has completed for this
       * conversation, so the only correct cycle id is the read-only `unestablished` default
       * (hooks/context-monitor.js §255). An established one here would mean the advisory path took
       * ownership of the lifecycle, which is the machine's job alone.
       */
      assert.equal(latched.cycleId, `claude-code:${sid}:0:unestablished`,
        'the latch record carries an ESTABLISHED cycle id — a PostToolUse hook minted machine state it is only allowed to read');

      fs.mkdirSync(path.join(repo, '.respawnpack'), { recursive: true });
      fs.writeFileSync(path.join(repo, '.respawnpack', 'push.allowed'), new Date().toISOString() + '\n');
      runHook('push-guard.js', stdinFor('PreToolUse', { session_id: sid, cwd: repo, tool_name: 'Bash', tool_input: { command: 'git push origin main' } }), { cwd: repo });
      capture(path.join(repo, '.respawnpack', 'push.consumed'), 'push-consumed.schema.json', 'the consumed push authorization');
    } finally { rm(repo); }
  });

  test('.skill-meta.json — from a real living-skill enable', () => {
    const repo = makeRepo('schema-living');
    try {
      const sd = path.join(repo, 'skills', 'debug');
      fs.mkdirSync(sd, { recursive: true });
      fs.writeFileSync(path.join(sd, 'SKILL.md'), '---\nname: debug\ndescription: d\n---\n\nbody\n');
      const r = spawnSync(process.execPath, [CLI, 'living', 'enable', 'debug', '--dir', repo], { encoding: 'utf8', timeout: 60000 });
      assert.equal(r.status, 0, `living enable failed: ${r.stderr || r.stdout}`);
      capture(path.join(sd, '.skill-meta.json'), 'skill-meta.schema.json', '.skill-meta.json');
    } finally { rm(repo); }
  });

  /*
   * ⛔ THE ROLLOVER CORE'S SIX FAMILIES, FROM ONE PRODUCTION SEQUENCE RATHER THAN SIX FIXTURES.
   *
   * Every one of these was declared, schema'd, fixtured — and never once captured from a run. Their
   * shape coverage was hand-authored fixtures, which can only prove that whoever wrote the fixture read
   * the writer the same way twice; the failure `additionalProperties: false` exists to catch is a
   * WRITER that starts emitting an undeclared field, and no fixture can see that.
   *
   * PreCompact → SessionStart(source=compact) is exactly the production sequence hooks/hooks.test.mjs
   * already drives for behaviour, and it lands all six: precompact-ledger-nudge.js writes the handoff
   * through core/state/handoff.js's write+readback (the handoff, its verification receipt), opens the
   * machine (the cycle record, the journal rows and the snapshot), and session-routing-nudge.js's
   * consumption claims it exactly once (the consumption receipt).
   */
  test('the rollover core artifacts — from a real PreCompact → SessionStart(compact) sequence', () => {
    const repo = makeRepo('schema-rollover');
    try {
      const sid = 'schema-session-3';
      const rt = path.join(repo, '.respawnpack', 'runtime');
      fs.mkdirSync(rt, { recursive: true });
      // Goal mode with an atomic task in flight, so the handoff carries an exactNextAction rather than
      // the degenerate shape a bare session produces.
      fs.writeFileSync(path.join(rt, 'contract.json'), JSON.stringify({ mode: 'goal', goal: 'ship the CSV writer' }));
      fs.writeFileSync(path.join(rt, `atomic-task-${sid}.json`), JSON.stringify({ task: 'finish the CSV writer' }));

      const pc = runHook('precompact-ledger-nudge.js', stdinFor('PreCompact', { session_id: sid, cwd: repo, trigger: 'manual' }), { cwd: repo });
      assert.equal(pc.code, 0, `PreCompact failed: ${pc.stderr}`);
      assert.notEqual(pc.json && pc.json.decision, 'block',
        'PreCompact BLOCKED, which means the handoff could not be written and verified — nothing downstream was captured');

      const cdir = path.join(rt, 'rollover', `claude-code-${sid}`);
      const handoffs = fs.readdirSync(cdir).filter((f) => /^ho_[0-9a-f]+\.json$/.test(f));
      assert.equal(handoffs.length, 1, `expected exactly one rollover handoff, found ${handoffs.length} — the sequence did not write one`);
      const hid = handoffs[0].replace(/\.json$/, '');

      const handoff = capture(path.join(cdir, `${hid}.json`), 'rollover-handoff.schema.json', 'the v2 rollover handoff');
      assert.equal(handoff.exactNextAction, 'finish the CSV writer', 'the atomic task in flight did not reach the handoff, so this is not the shape a real rollover writes');
      const receipt = capture(path.join(cdir, `${hid}.verified.json`), 'handoff-verification-receipt.schema.json', 'the handoff verification receipt');
      assert.equal(receipt.equal, true, 'the read-back did not verify, so the captured receipt is the failed shape');
      capture(path.join(cdir, 'cycle.json'), 'cycle-record.schema.json', 'the context-cycle record');

      /*
       * Both of rollover-journal's shapes, because the family covers both and they fail differently:
       * the snapshot is one document, the journal is a line per transition, and only the rows can
       * carry a kind this schema does not know about.
       */
      capture(path.join(cdir, 'state.json'), 'rollover-journal.schema.json', 'the rollover journal snapshot');
      const rows = captureLines(path.join(cdir, 'journal.jsonl'), 'rollover-journal.schema.json', 'the rollover journal rows');
      assert.ok(rows.length >= 2, `the journal holds ${rows.length} row(s) — a sequence this long must have journaled more than an open`);

      const ss = runHook('session-routing-nudge.js', stdinFor('SessionStart', { session_id: sid, cwd: repo, source: 'compact' }), { cwd: repo });
      assert.equal(ss.code, 0, `SessionStart(compact) failed: ${ss.stderr}`);
      const consumed = capture(path.join(cdir, `${hid}.consumed.json`), 'consumption-receipt.schema.json', 'the handoff consumption receipt');
      assert.equal(consumed.subjectId, hid, 'the receipt claims a subject other than the handoff that was just consumed');
    } finally { rm(repo); }
  });

  /*
   * ⛔ THE SAVEPOINT RECEIPT IS CAPTURED FROM A BLOCKED RUN, WHICH IS THE RUN IT EXISTS FOR. Per its own
   * registration (the 2026-08-07 field run §4), the receipt's whole reason to exist is that "nobody ran a savepoint"
   * and "a savepoint ran and could not finish" were the same observation. Capturing it from a PASS would
   * validate the one shape that was never in question, and leave `blockers` — the field the Stop hook
   * actually reads — as an empty array nothing had written.
   */
  test('the savepoint receipt and its candidate memories — from a real `savepoint` run', () => {
    const dir = project();
    try {
      const sp = cli(dir, 'savepoint');
      assert.equal(sp.status, 2, `a bare project's savepoint should be CANNOT_DETERMINE (exit 2), got ${sp.status}: ${sp.stdout}${sp.stderr}`);

      const attempt = capture(path.join(dir, '.respawnpack', 'runtime', 'savepoint-attempt.json'), 'savepoint-attempt.schema.json', 'the savepoint attempt receipt');
      assert.equal(attempt.outcome, 'CANNOT_DETERMINE', 'the receipt does not record the outcome the run actually had');
      assert.ok(attempt.blockers.length >= 1, 'the receipt of a BLOCKED run names no blocker — the field that decides whether a later nag is new information is empty');

      /*
       * And savepoint's automatic candidate capture (W5), which is the same run's other artifact: every
       * blocking check becomes an unpromoted, evidence-bearing candidate record plus an audit row. Both
       * shapes are this one family.
       */
      const cdir = path.join(dir, 'memory', 'candidates');
      const records = fs.readdirSync(cdir).filter((f) => /^cm_[0-9a-f]+\.json$/.test(f));
      assert.ok(records.length >= 1, 'savepoint captured no candidate memory, so the record shape is untested');
      for (const f of records) {
        const rec = capture(path.join(cdir, f), 'candidate-memory.schema.json', `the captured candidate memory ${f}`);
        assert.equal(rec.verificationState, 'candidate', 'an automatically captured memory must never be born verified');
      }
      captureLines(path.join(cdir, 'audit.jsonl'), 'candidate-memory.schema.json', 'the candidate-memory audit rows');
    } finally { rm(dir); }
  });

  /*
   * ⛔ P5-T-16b · THE TASK RECEIPT IS CAPTURED FROM A RUN THAT DID NOT PASS, for the same reason the
   * savepoint receipt is. Its whole reason to exist is that "a task session ran" and "the task is
   * done" were the same observation; capturing a clean PASS would validate the one shape that was
   * never in question and leave `exitCode: null` — the field that says a gate COULD NOT RUN rather
   * than failed — as a value nothing had ever written.
   *
   * ⭐ WHAT IS REAL HERE AND WHAT IS REPLAYED. The kernel is real (`contract delegate`, `contract
   * complete --met`, the runtime contract and the delegation archive it writes), the gates are real
   * child processes, and the receipt is written by the production writer. The only replayed part is
   * the `claude` process itself — the same fixture stream adapters/claude-code/task-runner/
   * runner.test.mjs replays, for the reason its header gives: a suite that needed an authenticated
   * host would go red on a machine that is merely logged out.
   */
  test('the task-attempt receipt — from a real run of the task runner', async () => {
    const runner = require_(path.join(ROOT, 'adapters', 'claude-code', 'task-runner', 'runner.js'));
    const manifest = require_(path.join(ROOT, 'hooks', '_manifest.js'));
    const dir = project();
    try {
      fs.writeFileSync(path.join(dir, 'respawnpack.config.json'), `${JSON.stringify({
        qualityGate: {
          checks: [
            { name: 'unit', command: process.execPath, args: ['-e', 'process.exit(0)'] },
            { name: 'lint', command: 'respawnpack-no-such-tool-exists', args: [] },
          ],
        },
      }, null, 2)}\n`);
      const acceptance = ['the receipt is written exactly once', 'the gates run out of band'];
      fs.writeFileSync(path.join(dir, stateLib.STATE_DIR, 'tasks.json'), `${JSON.stringify({
        schemaVersion: '1.0.0',
        tasks: [{
          id: 'T-1', title: 'capture the task receipt', specPointer: 'PLAN.md §6',
          scope: { files: [], dirs: [] }, intent: 'Produce one real task-attempt receipt.',
          acceptance, gates: { savepoint: false, gate: true }, dependsOn: [], state: 'ready',
          risk: 'low', provenance: { createdBy: 'kernel/schema.test.mjs', createdAt: new Date().toISOString() },
        }],
      }, null, 2)}\n`);

      // A real STATE.json from the real compiler, so the runner's freshness check passes for the
      // reason it exists rather than because a hand-written projection happened to look current.
      assert.equal(cli(dir, 'state').status, 0, 'the compiler refused to run, so the runner would have refused to start');
      assert.equal(manifest.sourceRevisions(dir).chain.length >= 1, true);

      const lines = fs.readFileSync(path.join(ROOT, 'adapters', 'claude-code', 'sdk-supervisor', 'fixtures', 'synthetic', 'turn-light.jsonl'), 'utf8')
        .split('\n').filter((l) => l.length);
      const fakeCli = {
        async runVersion() { return { ok: true, version: '2.1.205', stdout: '', stderr: '', code: 0, exePath: 'C:/fake/claude.exe', why: null }; },
        async runTurn(opts) {
          // What a session that finished would have done: attest, through the real kernel.
          const done = cli(opts.cwd, 'contract', 'complete', '--json', ...acceptance.flatMap((a) => ['--met', a]));
          assert.equal(done.status, 0, `the fixture attestation failed: ${done.stdout}${done.stderr}`);
          return {
            ok: true, code: 0, signal: null, timedOut: false, spawnError: null,
            stdoutLines: lines.slice(), stdout: lines.join('\n'), stderr: '',
            argv: ['C:/fake/claude.exe'], exePath: 'C:/fake/claude.exe', durationMs: 1,
          };
        },
      };

      const report = await runner.runTask({ dir, cli: fakeCli });
      assert.equal(report.receipt && report.receipt.status, 'WRITTEN', `no receipt was written: ${report.summary}`);
      const receipt = capture(report.receipt.path, 'task-attempt.schema.json', 'the task-attempt receipt');

      assert.equal(receipt.outcome, 'CANNOT_DETERMINE', 'the receipt does not record the outcome the run actually had');
      assert.equal(receipt.exitCode, 2);
      assert.ok(receipt.gates.checks.some((c) => c.outcome === 'CANNOT_DETERMINE' && c.exitCode === null),
        'no row records a gate that COULD NOT RUN, so the field that separates that from a failure is untested');
      assert.deepEqual(receipt.acceptance.unattested, [], 'the fixture session was supposed to attest every criterion');
      assert.ok(receipt.acceptance.evaluation.every((e) => e.evaluation === 'CANNOT_DETERMINE'),
        'a prose criterion was recorded as machine-evaluated');

      /*
       * ⛔ P4-M-5 · THE RECEIPT CAPTURED HERE CARRIES `route`, WHICH IS WHAT MAKES THIS THE CAPTURE FOR
       * THE FIELD (rather than only a shape the schema happens to accept). The queue row above declares
       * no `taskClass`, so this is the "absent means coding" case; this pack's own checkout has no
       * `docs/reference/models/`, so the fallback resolves to the pack's own register.
       */
      assert.equal(receipt.route.taskClass, 'coding', 'a row with no declared taskClass did not route as coding');
      assert.equal(receipt.route.family, 'anthropic', 'a task session routed to a family other than the hooked one');
      assert.equal(receipt.route.overridden, false, 'no --model was passed, so nothing should read as an override');
      assert.equal(receipt.route.overriddenBy, null);
      assert.equal(receipt.route.register.source, 'pack', 'this checkout has no docs/reference/models/, so the pack\'s own register should have answered');
      assert.ok(receipt.route.register.path && receipt.route.register.path.endsWith('capability-register.json'));
    } finally { rm(dir); }
  });

  /*
   * ⛔ P4-M-4 · BOTH SHAPES OF THE OFFLOAD RECEIPT ARE CAPTURED, because the two are a real fork rather
   * than an edge case. A run that produced text fills `usage` and both digests; a run whose provider
   * refused fills `provider.kind` and leaves them null, and `provider.kind` is the field the whole
   * document exists to carry. Capturing only the first would leave the second shape written by nothing.
   *
   * ⭐ WHAT IS REAL HERE AND WHAT IS FAKED. The offload is the production one, the routing policy is the
   * real one, the capability register is this pack's own real file, and the receipt is written by the
   * production writer with the production `wx` create. What is faked is exactly three things, all of
   * them the outside world: `fetch`, the claude path resolver and the codex resolver. Nothing reaches a
   * provider, and the injected environment carries a sentinel value rather than a key.
   */
  test('the offload receipt — from a real run of the offload path against a fake provider', async () => {
    const offload = require_(path.join(ROOT, 'adapters', 'providers', 'offload.js'));
    const SENTINEL = 'sentinel-key-value-do-not-print';
    const ENV_NAME = 'OFFLOAD_SCHEMA_TEST_API_KEY';
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-offload-'));
    try {
      fs.writeFileSync(path.join(dir, 'respawnpack.config.json'), `${JSON.stringify({
        providers: {
          minimax: { protocol: 'openai-compatible', baseUrl: 'https://api.example.invalid/v1', apiKeyEnv: ENV_NAME, models: ['MiniMax-M3', 'MiniMax-M2.7'] },
        },
      }, null, 2)}\n`);

      // The two families that authenticate through an operator sign-in are reported UNREACHABLE, so the
      // route has to skip them by name and the `skipped` list is exercised rather than left empty.
      const deps = {
        claudeCli: { resolveExecutable: () => ({ ok: false, why: 'no `claude` executable was found on PATH in this fixture' }) },
        resolveCodexJs: () => ({ ok: false, detail: 'no codex.js could be resolved in this fixture', searched: [] }),
      };
      const env = { [ENV_NAME]: SENTINEL };

      const answered = async () => ({
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify({
          model: 'MiniMax-M3',
          choices: [{ message: { role: 'assistant', content: 'The reviewed material states its own limits.' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 812, completion_tokens: 24 },
        }),
      });
      const refused = async () => ({ status: 429, statusText: 'Too Many Requests', text: async () => JSON.stringify({ base_resp: { status_code: 1002, status_msg: 'rate limit' } }) });

      const inA = path.join(dir, 'unit-a.md');
      fs.writeFileSync(inA, '# The material\n\nOne paragraph the reviewer is asked about.\n');
      const outA = path.join(dir, 'answer-a.md');
      const pass = await offload.runOffload({ dir, taskClass: 'review', inFile: inA, outFile: outA, env, deps: { ...deps, fetchImpl: answered } });
      assert.equal(pass.receiptWritten, true, `no receipt was written: ${pass.summary}`);
      const okDoc = capture(pass.receiptPath, 'offload-receipt.schema.json', 'the offload receipt of a turn that answered');
      assert.equal(okDoc.outcome, 'PASS');
      assert.equal(okDoc.exitCode, 0);
      assert.equal(okDoc.register.source, 'pack', 'the fixture target has no installed standards, so the pack register is the one that decided');
      assert.equal(okDoc.route.family, 'minimax', 'the only reachable family was not the one routed to');
      assert.ok(okDoc.route.skipped.some((s) => s.family === 'anthropic'), 'an unreachable family was dropped instead of skipped by name');
      assert.equal(okDoc.provider.kind, null, 'a turn that produced text recorded a failure kind');
      assert.equal(okDoc.usage.input, 812, 'the provider reported usage and the receipt did not carry it');

      const inB = path.join(dir, 'unit-b.md');
      fs.writeFileSync(inB, '# A different unit of work\n\nSo the derived receipt id differs from the first.\n');
      const cd = await offload.runOffload({ dir, taskClass: 'review', inFile: inB, env, deps: { ...deps, fetchImpl: refused } });
      assert.equal(cd.receiptWritten, true, `no receipt was written for the refused turn: ${cd.summary}`);
      const badDoc = capture(cd.receiptPath, 'offload-receipt.schema.json', 'the offload receipt of a turn that was refused');
      assert.equal(badDoc.outcome, 'CANNOT_DETERMINE', 'a provider that refused was not recorded as could-not-determine');
      assert.equal(badDoc.exitCode, 2);
      assert.equal(badDoc.provider.kind, 'QUOTA', 'the provider\'s own failure kind did not reach the receipt');
      assert.equal(badDoc.output.digest, null, 'a turn that produced nothing recorded an output digest');
      assert.equal(badDoc.retry.attempted, false, 'the receipt claims a second provider was tried');

      // Anti-drift item 52, checked on the bytes this pack actually wrote rather than on the design.
      for (const p of [pass.receiptPath, cd.receiptPath, outA]) {
        assert.ok(!fs.readFileSync(p, 'utf8').includes(SENTINEL), `the injected key value reached ${p}`);
      }
    } finally { rm(dir); }
  });
});

// ---------------------------------------------------------------------------------------------
describe('the installed target — schemas hold against a real installation, and malformed never passes', () => {
  /*
   * ⛔ THE PACK'S OWN CHECKOUT IS NOT THE PRODUCT. Every one of this program's P0s was found on an
   * INSTALLED target, several of them under a green suite that only ever exercised the source tree.
   * So the schemas are checked once more where they will actually be used, and — more importantly —
   * the loaders are checked to REFUSE the documents these schemas call invalid. A schema that says a
   * document is malformed while the kernel reads it as truth is worse than no schema at all.
   */
  const INSTALL_JS = path.join(ROOT, 'install', 'install.js');

  function installedTarget(label) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `rp-schema-inst-${label}-`));
    const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    git('init', '--quiet', '--initial-branch=main');
    git('config', 'user.email', 'i@respawnpack.test'); git('config', 'user.name', 'Installed');
    git('config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(dir, 'README.md'), '# target\n');
    const r = spawnSync(process.execPath, [INSTALL_JS, dir], { encoding: 'utf8', timeout: 600000 });
    assert.equal(r.status, 0, `the installer failed: ${r.stderr || r.stdout}`);
    const sd = path.join(dir, stateLib.STATE_DIR);
    fs.mkdirSync(path.join(sd, 'evidence'), { recursive: true });
    fs.writeFileSync(path.join(sd, 'requirements.json'), JSON.stringify({
      schemaVersion: '1.0.0', denominatorVersion: 'inst-1',
      requirements: [{ id: 'R-1', title: 'one', mandatory: true }], gates: {},
    }, null, 2));
    git('add', '-A'); git('commit', '--quiet', '-m', 'seed');
    return dir;
  }
  const target = (dir, ...args) => spawnSync(
    process.execPath, [path.join(dir, '.claude', 'respawnpack', 'respawnpack.js'), ...args, '--dir', dir],
    { encoding: 'utf8', timeout: 120000 },
  );

  test('artifacts generated by a REAL INSTALLATION conform to their declared schemas', () => {
    const dir = installedTarget('conform');
    try {
      assert.equal(target(dir, 'state').status, 0, 'the installed kernel could not compile state');
      capture(path.join(dir, stateLib.STATE_FILE), 'state.schema.json', "the INSTALLED kernel's STATE.json");

      assert.equal(target(dir, 'contract', 'goal', '--id', 'G-9', '--goal', 'ship', '--completion', 'all-mandatory-conformant').status, 0);
      for (const [rel, schema] of [
        [path.join(stateLib.STATE_DIR, 'goal.json'), 'goal.schema.json'],
        [path.join('.respawnpack', 'runtime', 'contract.json'), 'runtime-contract.schema.json'],
        /*
         * ⛔ THE INSTALLER'S OWN CONFIG, NOT A FIXTURE'S — and the reason fence 6 names THIS test as
         * project-config's capture rather than the gate-verdict test, which writes its own config and
         * so could only ever confirm that the schema matched the fixture. It declared `opsTargets` an
         * ARRAY while install.js writes a MAP, and nothing here could see it — the installed-target
         * release smoke found it. A capture that builds its own input is not a capture.
         */
        ['respawnpack.config.json', 'project-config.schema.json'],
      ]) {
        capture(path.join(dir, rel), schema, `the installed ${rel}`);
      }
    } finally { rm(dir); }
  });

  test('project-config schema and production loaders accept and refuse the same opt-out language', () => {
    const dir = installedTarget('config-parity');
    try {
      const schema = schemaOf('project-config.schema.json');
      const configPath = path.join(dir, 'respawnpack.config.json');
      const base = readJSON(configPath);
      for (const removals of [
        { notApplicable: true, reason: 'this project has retired nothing' },
        { notApplicable: 'legacy reason stored in the field itself' },
      ]) {
        const doc = { ...base, state: { ...base.state, removals } };
        assert.equal(validate(doc, schema).valid, true, `schema rejected runtime-supported removals config ${JSON.stringify(removals)}`);
        fs.writeFileSync(configPath, JSON.stringify(doc, null, 2));
        const r = target(dir, 'removals', '--json');
        assert.equal(r.status, 0, `runtime rejected schema-valid config: ${r.stdout || r.stderr}`);
        assert.equal(JSON.parse(r.stdout).outcome, 'NOT_APPLICABLE');
      }

      const invalid = { ...base, state: { ...base.state, removals: { notApplicable: true } } };
      assert.equal(validate(invalid, schema).valid, false, 'schema accepted notApplicable:true without its required reason');
      fs.writeFileSync(configPath, JSON.stringify(invalid, null, 2));
      assert.equal(target(dir, 'removals', '--json').status, 2, 'runtime accepted the same unjustified opt-out the schema rejects');

      const conflict = { ...base, state: { ...base.state, reconcile: {
        notApplicable: true, reason: 'conflict', tasks: { kind: 'requirements' }, project: { kind: 'requirements' },
      } } };
      assert.equal(validate(conflict, schema).valid, false, 'schema accepted notApplicable plus live sources');
      fs.writeFileSync(configPath, JSON.stringify(conflict, null, 2));
      assert.equal(target(dir, 'reconcile', '--json').status, 2, 'runtime silently preferred the opt-out over conflicting sources');

      const externalRegistry = { ...base, state: { ...base.state, removals: {
        registry: '../outside.json', liveContentDirs: ['docs'],
      } } };
      assert.equal(validate(externalRegistry, schema).valid, false, 'schema accepted an external removal authority');
      fs.writeFileSync(configPath, JSON.stringify(externalRegistry, null, 2));
      assert.equal(target(dir, 'removals', '--json').status, 2, 'runtime accepted the external authority the schema rejects');

      const externalSource = { ...base, state: { ...base.state, reconcile: {
        tasks: { kind: 'json', path: '../tasks.json', pointer: 'tasks' }, project: { kind: 'requirements' },
      } } };
      assert.equal(validate(externalSource, schema).valid, false, 'schema accepted an external reconciliation source');
      fs.writeFileSync(configPath, JSON.stringify(externalSource, null, 2));
      assert.equal(target(dir, 'reconcile', '--json').status, 2, 'runtime accepted the external source the schema rejects');
    } finally { rm(dir); }
  });

  test('⛔ a malformed requirements / evidence / goal / runtime artifact is NEVER read as valid', () => {
    const dir = installedTarget('malformed');
    try {
      const sd = path.join(dir, stateLib.STATE_DIR);
      const schemaRejects = (doc, name) => assert.equal(validate(doc, schemaOf(name)).valid, false,
        `the schema accepted a document this test calls malformed — the two disagree about ${name}`);

      // 1. requirements.json that is not JSON at all.
      const goodReq = fs.readFileSync(path.join(sd, 'requirements.json'), 'utf8');
      fs.writeFileSync(path.join(sd, 'requirements.json'), '{ not json');
      const broken = target(dir, 'state', '--json');
      assert.notEqual(broken.status, 0, 'an unparseable requirements.json compiled at exit 0');
      fs.writeFileSync(path.join(sd, 'requirements.json'), goodReq);

      // 2. evidence with an unknown schemaVersion must be REJECTED WITH ITS REASON, never counted.
      const rev = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
      const ev = { schemaVersion: '9.9.9', requirements: ['R-1'], sourceRevision: rev, verdict: 'pass', positiveControl: { passed: true }, negativeControl: { detected: true } };
      fs.writeFileSync(path.join(sd, 'evidence', 'future.json'), JSON.stringify(ev));
      schemaRejects(ev, 'evidence.schema.json');
      assert.equal(target(dir, 'state').status, 0);
      let state = readJSON(path.join(dir, stateLib.STATE_FILE));
      assert.equal(state.evidence.accepted, 0, 'evidence at an unknown schemaVersion was ACCEPTED — a future format silently qualified a requirement');
      assert.match(state.evidence.rejected.map((x) => x.reason).join(' '), /unknown schemaVersion/,
        'the rejection happened but was not RECORDED — an artifact that contributes nothing is otherwise indistinguishable from one never written');
      assert.equal(state.counts.conformant, 0, 'a rejected artifact still moved the count');

      // 3. The same evidence at the RIGHT version and it qualifies — without this control the check
      //    above proves only that the loader rejects everything.
      fs.writeFileSync(path.join(sd, 'evidence', 'future.json'), JSON.stringify({ ...ev, schemaVersion: '1.0.0', claimType: 'real-engine qualified', qualifiedBy: 'independent' }));
      execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore' });
      execFileSync('git', ['commit', '--quiet', '-m', 'evidence'], { cwd: dir, stdio: 'ignore' });
      const rev2 = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
      fs.writeFileSync(path.join(sd, 'evidence', 'future.json'), JSON.stringify({ ...ev, schemaVersion: '1.0.0', sourceRevision: rev2, claimType: 'real-engine qualified', qualifiedBy: 'independent' }));
      assert.equal(target(dir, 'state').status, 0);
      state = readJSON(path.join(dir, stateLib.STATE_FILE));
      assert.equal(state.evidence.accepted, 1, 'the KNOWN-GOOD control was rejected too, so the version check discriminates nothing');
      fs.rmSync(path.join(sd, 'evidence', 'future.json'));

      // 4. A malformed goal document must not be read as a goal.
      const badGoal = { schemaVersion: '1.0.0', goals: { 'G-1': { id: 'G-1', goal: 'x', constraints: 'not an array' } } };
      schemaRejects(badGoal, 'goal.schema.json');

      // 5. A runtime contract naming a mode that does not exist degrades to collaborate — it is never
      //    honoured as autonomy. THIS is the case that matters: a mis-read here grants authority.
      const rc = path.join(dir, '.respawnpack', 'runtime', 'contract.json');
      fs.mkdirSync(path.dirname(rc), { recursive: true });
      const badRuntime = { mode: 'autonomous', activeGoalId: 'G-1', suspendedGoalId: null, setAt: new Date().toISOString() };
      fs.writeFileSync(rc, JSON.stringify(badRuntime));
      schemaRejects(badRuntime, 'runtime-contract.schema.json');
      const rt = createRequire(import.meta.url)(path.join(dir, '.claude', 'hooks', '_runtime.js'));
      assert.equal(rt.readContract(dir).mode, 'collaborate',
        'an unrecognised mode was honoured rather than degraded — an invented word in a gitignored file granted autonomy');
    } finally { rm(dir); }
  });

  /*
   * ⛔ THE PRODUCTION LOADER, NOT THE STANDALONE VALIDATOR.
   *
   * The external review's finding about the block above is exact and worth keeping: it called
   * `validate()` on a malformed goal document and never wrote that document into the installed target
   * or invoked the production reader. A schema that says "invalid" beside a loader that consumes the
   * file anyway is worse than no schema — it is a written record that somebody checked.
   *
   * Reproduced on a real installed target at d971cbb, before any of this existed:
   *   requirements.json @ 999.0.0  → consumed, contributed R-FUTURE, counts.mandatory 1, PASS, exit 0
   *   goal.json @ 999.0.0          → consumed AND ACTIVATED: goal text, constraints, authority and
   *                                  FORBIDDEN ACTIONS all reached compiled state, exit 0
   *   constraints: "not an array"  → PASS at exit 0 with constraints
   *                                  ["n","o","t"," ","a","n"," ","a","r","r","a","y"]
   *
   * Every case below writes the document into a REAL installation and runs the REAL verbs.
   */
  const sdOf = (d) => path.join(d, stateLib.STATE_DIR);
  const stateOf = (d) => readJSON(path.join(d, stateLib.STATE_FILE));

  test('⛔ requirements: unknown version, wrong nested type and malformed JSON are all REFUSED — and a valid control is not', () => {
    const dir = installedTarget('req-accept');
    try {
      const req = path.join(sdOf(dir), 'requirements.json');
      const good = { schemaVersion: '1.0.0', requirements: [{ id: 'R-1', title: 'one', mandatory: true }], gates: {} };

      // The KNOWN-GOOD CONTROL FIRST. Without it, "everything is refused" would look like success.
      fs.writeFileSync(req, JSON.stringify(good, null, 2));
      const ok = target(dir, 'state');
      assert.equal(ok.status, 0, `the valid control was refused: ${ok.stdout}${ok.stderr}`);
      assert.equal(stateOf(dir).counts.mandatory, 1, 'the valid control did not contribute its requirement');

      for (const [label, doc, expect] of [
        ['unknown schemaVersion', { ...good, schemaVersion: '999.0.0' }, /declares schemaVersion "999\.0\.0"/],
        ['requirements is not an array', { ...good, requirements: { 'R-1': {} } }, /`requirements` is an object, expected an array/],
        ['a row with no id', { ...good, requirements: [{ title: 'nameless', mandatory: true }] }, /has no string `id`/],
        ['a row whose blockedBy is a string', { ...good, requirements: [{ id: 'R-1', blockedBy: 'R-2' }] }, /blockedBy must be an array of strings/],
        ['mandatory is a string', { ...good, requirements: [{ id: 'R-1', mandatory: 'yes' }] }, /mandatory must be a boolean/],
        ['gates is an array', { ...good, gates: [] }, /`gates` is an array, expected an object/],
      ]) {
        fs.writeFileSync(req, JSON.stringify(doc, null, 2));
        const r = target(dir, 'state');
        const st = stateOf(dir);
        assert.equal(r.status, 2, `${label}: expected CANNOT_DETERMINE (exit 2), got exit ${r.status}`);
        assert.equal(st.tracksRequirements, false, `${label}: the document was CONSUMED — tracksRequirements stayed true`);
        assert.equal(st.counts, undefined, `${label}: counts were derived from a document that was refused`);
        assert.match(st.cannotDetermine.join(' '), expect, `${label}: the refusal did not name the reason`);
        assert.match(st.cannotDetermine.join(' '), /requirements\.json/, `${label}: the refusal did not name the artifact`);
      }

      // Malformed JSON is its own answer, distinct from every structural refusal above.
      fs.writeFileSync(req, '{ not json');
      const bad = target(dir, 'state');
      assert.equal(bad.status, 2, 'malformed JSON did not yield exit 2');
      assert.match(stateOf(dir).cannotDetermine.join(' '), /not parseable JSON/);

      // ...and ABSENT stays a different answer again: a project may legitimately track no denominator.
      fs.rmSync(req);
      const absent = target(dir, 'state');
      assert.equal(absent.status, 0, 'an ABSENT requirements source was treated as a fault rather than a configuration state');
      assert.match(stateOf(dir).cannotDetermine.join(' '), /no approved requirement source/);
    } finally { rm(dir); }
  });

  test('⛔ goal: unknown version and every wrong safety-field type are REFUSED by the PRODUCTION reader', () => {
    const dir = installedTarget('goal-accept');
    try {
      const goalFile = path.join(sdOf(dir), 'goal.json');
      const g = (over) => ({
        schemaVersion: '1.0.0',
        goals: { 'G-1': { id: 'G-1', goal: 'ship it', completion: ['all-mandatory-conformant'], constraints: ['no pushes'], forbidden: ['git push'], authority: ['edit code'], ...over } },
        ongoingGoalId: 'G-1',
      });

      // KNOWN-GOOD CONTROL: the same document, valid, must be accepted and activated.
      fs.writeFileSync(goalFile, JSON.stringify(g({}), null, 2));
      assert.equal(target(dir, 'state').status, 0, 'the valid goal control was refused');
      const okState = stateOf(dir);
      assert.equal(okState.ongoingGoalId, 'G-1', 'the valid control was not activated');
      assert.deepEqual(okState.constraints, ['no pushes']);
      assert.deepEqual(okState.forbidden, ['git push']);

      const cases = [
        ['unknown schemaVersion', { ...g({}), schemaVersion: '999.0.0' }, /declares schemaVersion "999\.0\.0"/],
        ['constraints is a string', g({ constraints: 'not an array' }), /constraints must be an array of strings/],
        ['forbidden is a string', g({ forbidden: 'git push' }), /forbidden must be an array of strings/],
        ['authority is a string', g({ authority: 'deploy' }), /authority must be an array of strings/],
        ['completion is a string', g({ completion: 'all-mandatory-conformant' }), /completion is string, expected an array/],
        ['constraints holds a non-string', g({ constraints: ['ok', 42] }), /constraints must be an array of strings/],
        ['goals is an array', { schemaVersion: '1.0.0', goals: [], ongoingGoalId: 'G-1' }, /`goals` is an array, expected an object/],
      ];

      for (const [label, doc, expect] of cases) {
        fs.writeFileSync(goalFile, JSON.stringify(doc, null, 2));
        const r = target(dir, 'state');
        const st = stateOf(dir);
        assert.equal(r.status, 2, `${label}: expected exit 2, got ${r.status}`);
        assert.match(st.cannotDetermine.join(' '), expect, `${label}: the refusal did not name the reason`);

        // ⛔ NOTHING FROM A REFUSED DOCUMENT REACHES COMPILED STATE — not even the fields that parsed.
        assert.equal(st.ongoingGoalId, null, `${label}: the goal was ACTIVATED from a refused document`);
        assert.equal(st.goal, null, `${label}: goal text was derived from a refused document`);
        assert.deepEqual(st.constraints, [], `${label}: constraints were derived from a refused document`);
        assert.deepEqual(st.forbidden, [], `${label}: forbidden actions were derived from a refused document`);
        /*
         * ⛔ THE SCAN JUDGES THE DERIVED DOCUMENT, NOT THE DIAGNOSTIC PROSE. A first version scanned
         * the whole serialised state for "no pushes" and failed — on the REJECTION MESSAGE, which
         * quotes that phrase to explain what a spread string would do to it. Same shape as the drift
         * fence that once matched the comment describing the defect it had just fixed: an assertion
         * that reads explanation as evidence is measuring the wrong thing.
         */
        const derived = JSON.stringify({ ...st, cannotDetermine: undefined });
        assert.doesNotMatch(derived, /"n","o","t"/, `${label}: a string was spread into single-character constraints`);
        assert.doesNotMatch(derived, /no pushes|git push|edit code/, `${label}: a safety field survived from a refused document`);
      }

      fs.writeFileSync(goalFile, '{ not json');
      assert.equal(target(dir, 'state').status, 2, 'a malformed goal.json did not yield exit 2');
      assert.match(stateOf(dir).cannotDetermine.join(' '), /goal\.json.*not parseable JSON/);
    } finally { rm(dir); }
  });

  test('⛔ a refused goal reaches NEITHER compiled state NOR SessionStart — and the session is TOLD', () => {
    const dir = installedTarget('goal-boot');
    try {
      fs.writeFileSync(path.join(sdOf(dir), 'goal.json'), JSON.stringify({
        schemaVersion: '1.0.0',
        goals: { 'G-1': { id: 'G-1', goal: 'ship it', constraints: 'no pushes', forbidden: 'git push' } },
        ongoingGoalId: 'G-1',
      }, null, 2));
      target(dir, 'state');

      // The runtime pointer says goal mode; the durable contract cannot be accepted.
      target(dir, 'contract', 'goal', '--id', 'G-1', '--goal', 'ship it', '--completion', 'all-mandatory-conformant');
      fs.writeFileSync(path.join(sdOf(dir), 'goal.json'), JSON.stringify({
        schemaVersion: '1.0.0',
        goals: { 'G-1': { id: 'G-1', goal: 'ship it', constraints: 'no pushes' } },
        ongoingGoalId: 'G-1',
      }, null, 2));

      const boot = spawnSync(process.execPath, [path.join(dir, '.claude', 'hooks', 'session-routing-nudge.js')], {
        input: JSON.stringify({ session_id: 'S1', hook_event_name: 'SessionStart', source: 'startup', cwd: dir }),
        encoding: 'utf8', cwd: dir, env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
      });
      let injected = '';
      try { injected = JSON.parse(boot.stdout).hookSpecificOutput.additionalContext || ''; } catch { injected = ''; }
      assert.ok(injected.length, 'SessionStart produced no context at all');

      // The single-character spread must not appear anywhere a session can read.
      assert.doesNotMatch(injected, /\bn\b.{0,4}\bo\b.{0,4}\bt\b/, 'a spread string reached the session');
      /*
       * ⛔ AND SILENCE IS NOT ACCEPTABLE EITHER. Dropping the constraints quietly would leave a
       * goal-mode session believing it has no restrictions, which is strictly worse than a wrong one:
       * losing a prohibition costs more than losing a schedule.
       */
      assert.match(injected, /GOAL CONTRACT COULD NOT BE READ/,
        'the session was not told its goal contract was refused — it would read the absence of constraints as freedom');
      assert.match(injected, /UNKNOWN, not empty/, 'the announcement did not distinguish unknown restrictions from none');
    } finally { rm(dir); }
  });

  test('a legacy goal document with no schemaVersion is still accepted — deliberately', () => {
    /*
     * ⛔ THE LINE BETWEEN LEGACY SUPPORT AND ACCEPTING ANYTHING. These files predate the version field
     * and real projects carry documents without one, so REQUIRING it would break working installations
     * to close a hole they do not have. A document that DECLARES a version this kernel does not
     * implement is a different thing: its author is saying, in the document, that it means something
     * else. Absent is accepted; different is refused; and the legacy flat shape is validated to exactly
     * the same standard as the modern one.
     */
    const dir = installedTarget('goal-legacy');
    try {
      const goalFile = path.join(sdOf(dir), 'goal.json');
      fs.writeFileSync(goalFile, JSON.stringify({ goal: 'a pre-goals document', completion: ['all-mandatory-conformant'], constraints: ['no pushes'] }, null, 2));
      assert.equal(target(dir, 'state').status, 0, 'a legacy flat goal document with no schemaVersion was refused');
      const st = stateOf(dir);
      assert.equal(st.goal, 'a pre-goals document', 'the legacy document was not activated');
      // A legacy document contributes its constraints twice — once from the top level and once from
      // the synthesised `G-legacy` row — so the SET is asserted. The duplication is pre-existing,
      // harmless (the constraint is still delivered), out of scope for this correction, and recorded
      // in HANDOFF.json rather than fixed here.
      assert.deepEqual([...new Set(st.constraints)], ['no pushes']);

      // ...and the legacy shape gets no exemption from structural validation.
      fs.writeFileSync(goalFile, JSON.stringify({ goal: 'a pre-goals document', constraints: 'no pushes' }, null, 2));
      assert.equal(target(dir, 'state').status, 2, 'the legacy shape was exempted from structural validation');
      assert.match(stateOf(dir).cannotDetermine.join(' '), /top-level `constraints` must be an array of strings/);
    } finally { rm(dir); }
  });

  test('an unknown schemaVersion never passes silently in the removal contract either', () => {
    const dir = installedTarget('removals');
    try {
      const reg = { schemaVersion: '9.9.9', removals: [{ id: 'K-1', feature: 'f', forbidden: ['x'] }] };
      assert.equal(validate(reg, schemaOf('removals-registry.schema.json')).valid, false, 'the schema accepted a future registry version');
      fs.writeFileSync(path.join(dir, stateLib.STATE_DIR, 'removals.json'), JSON.stringify(reg, null, 2));
      fs.writeFileSync(path.join(dir, 'respawnpack.config.json'),
        JSON.stringify({ state: { removals: { liveContentDirs: ['docs'] } } }, null, 2));
      const r = target(dir, 'removals', '--json');
      assert.equal(r.status, 2, `expected CANNOT_DETERMINE (exit 2) on a future registry version, got exit ${r.status}`);
      assert.match(r.stdout + r.stderr, /schemaVersion/, 'the refusal did not name the version mismatch that caused it');
      assert.doesNotMatch(r.stdout, /"status"\s*:\s*"PASS"/, 'a registry the kernel cannot interpret produced a PASS');
    } finally { rm(dir); }
  });
});

// ---------------------------------------------------------------------------------------------
describe('negative fixtures — every family rejects the four ways a document goes wrong', () => {
  const FIX = path.join(SCHEMA_DIR, 'fixtures');

  const EXEMPT = readJSON(path.join(FIX, 'exemptions.json'));
  const CANONICAL = ['missing-required', 'wrong-type', 'unknown-schema-version', 'malformed-nested'];

  test('every family ships a valid fixture and at least four discriminating negatives', () => {
    for (const f of REGISTRY.families) {
      const dir = path.join(FIX, f.family);
      assert.ok(fs.existsSync(dir), `family ${f.family} has no fixture directory`);
      const files = fs.readdirSync(dir);
      const valid = files.filter((x) => x.startsWith('valid'));
      const invalid = files.filter((x) => x.startsWith('invalid'));
      assert.ok(valid.length >= 1, `family ${f.family} has no valid fixture — a schema with only negatives can reject everything and look right`);
      assert.ok(invalid.length >= 4, `family ${f.family} has ${invalid.length} negative fixture(s), expected at least 4`);
      for (const kind of CANONICAL) {
        if (invalid.some((x) => x.includes(kind))) continue;
        /*
         * ⛔ AN EXEMPTION IS A DECLARATION, NOT A SHRUG. Some formats genuinely cannot express one of
         * these failures — requirements.json's schemaVersion is never read by the kernel, so pinning
         * it here would make the schema STRICTER than the code it documents, which is the opposite of
         * documenting it. Every such case is named with its reason and checked here, so the gap is
         * auditable instead of showing up as a fixture nobody noticed was missing.
         */
        const why = (EXEMPT[f.family] || {})[kind];
        assert.ok(why, `family ${f.family} has no "${kind}" negative fixture and no declared exemption`);
        assert.ok(why.length > 80, `family ${f.family}'s exemption from "${kind}" is a label, not a justification`);
      }
    }
  });

  test('no exemption is claimed for a failure the schema CAN express', () => {
    // The two-sided half: an exemption that stops being true must not sit there granting cover.
    const seeds = {
      'missing-required': (s) => Array.isArray(s.required) && s.required.length > 0,
      'unknown-schema-version': (s) => (s.properties || {}).schemaVersion !== undefined && (s.properties || {}).schemaVersion.const !== undefined,
    };
    for (const [family, kinds] of Object.entries(EXEMPT)) {
      const f = familyNamed(family);
      assert.ok(f, `exemptions.json names "${family}", which is not a registered family`);
      const s = schemaOf(f.schema);
      for (const kind of Object.keys(kinds)) {
        if (!seeds[kind]) continue;
        assert.equal(seeds[kind](s), false,
          `${family} claims exemption from "${kind}", but its schema now expresses exactly that constraint — `
          + 'the exemption is stale and must be replaced by a real negative fixture');
      }
    }
  });

  test('every valid fixture validates, and every negative fixture is REJECTED with a reason', () => {
    for (const f of REGISTRY.families) {
      const dir = path.join(FIX, f.family);
      const schema = schemaOf(f.schema);
      for (const file of fs.readdirSync(dir)) {
        const doc = readJSON(path.join(dir, file));
        const r = validate(doc, schema);
        if (file.startsWith('valid')) {
          assert.equal(r.valid, true, `${f.family}/${file} should be valid but is not:\n  ${r.errors.join('\n  ')}`);
        } else {
          assert.equal(r.valid, false, `${f.family}/${file} is a NEGATIVE fixture the schema accepted — the schema does not constrain what this file breaks`);
          assert.ok(r.errors.length && r.errors.every((e) => e.length > 5), `${f.family}/${file} was rejected without a usable reason`);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------------------------
/*
 * ⛔ THE CAPTURE INVENTORY HAD NO ABSENCE-SIDE TWIN EITHER, AND THAT IS WHERE IT FAILED.
 *
 * Fence 2 judges every capture that EXISTS. Nothing asked which families have none — the same missing
 * direction as fences 4 and 5, one level up, and it cost the same way. `threshold-latches` sat inside
 * fence 2's own describe behind `if (fs.existsSync(...)) conforms(...) else assert.ok(true)`, aimed at
 * a path v0.3 stopped writing and naming a schema file that does not exist. The else branch was taken
 * on every run since the family was registered. The suite was green, the family read as covered — and
 * TWELVE MORE registered families had never once been validated against an artifact a run produced:
 * the five remaining rollover-core families, the savepoint receipt and the candidate memories
 * savepoint captures, and the five inputs the project authors and this pack only reads. For the seven
 * this pack WRITES, that left hand-authored fixtures under schemas/fixtures/ as the whole of their
 * shape coverage, and a fixture proves only that whoever wrote it read the writer the same way twice.
 * The failure `additionalProperties: false` exists to catch is a WRITER that begins emitting an
 * undeclared field, and no fixture can see that — only a document the writer actually produced can.
 *
 * So the capture set is DECLARED here, in the idiom the write-site and reader inventories already use,
 * and then proved twice over:
 *
 *   · STATICALLY — every family named as captured names a test that exists in this file, and that test
 *     really does capture that family's schema. A renamed or gutted test fails here.
 *   · AT RUN TIME — capture()/captureLines() are the only things that record a capture, and they record
 *     when they RUN. This is the half that would have caught threshold-latches: a capture behind a
 *     condition that never fires registers nothing, so it fails LOUDLY instead of reading as coverage.
 *
 * The split itself is not a judgement call, and is not allowed to become one: a family the registry
 * says this pack WRITES must be captured, and a family it says this pack does not write must be
 * excluded as authored input. Both directions are checked against registry.json's own `writer` field
 * rather than against the prose beside them.
 */
describe('⛔ no registered family is uncaptured', () => {
  /*
   * Every registered family this pack WRITES, and the test that captures it from a real run. The value
   * is the test's exact title: verified against this file's source below, not asserted.
   */
  const CAPTURED = {
    // --- the kernel CLI, on a real project -------------------------------------------------------
    'compiled-state': 'STATE.json — both shapes, from the real compiler',
    'goal-contract': 'goal.json and the runtime contract — from the real `contract` verbs',
    'runtime-contract': 'goal.json and the runtime contract — from the real `contract` verbs',
    'delegation-archive': 'delegations.json — from a real attested closure',
    'gate-verdict': 'the gate verdict — from a real gate run, in two different outcomes',
    'skill-meta': '.skill-meta.json — from a real living-skill enable',
    'savepoint-attempt': 'the savepoint receipt and its candidate memories — from a real `savepoint` run',
    'candidate-memory': 'the savepoint receipt and its candidate memories — from a real `savepoint` run',
    'task-attempt': 'the task-attempt receipt — from a real run of the task runner',
    'offload-receipt': 'the offload receipt — from a real run of the offload path against a fake provider',

    // --- the real hooks, on real stdin -----------------------------------------------------------
    'session-baseline': 'the hook runtime artifacts — captured by running the REAL hooks on real stdin',
    'stop-decision': 'the hook runtime artifacts — captured by running the REAL hooks on real stdin',
    'precompact-handoff': 'the hook runtime artifacts — captured by running the REAL hooks on real stdin',
    'spawn-counter': 'the hook runtime artifacts — captured by running the REAL hooks on real stdin',
    'index-lease': 'the hook runtime artifacts — captured by running the REAL hooks on real stdin',
    'index-ownership': 'the hook runtime artifacts — captured by running the REAL hooks on real stdin',
    'threshold-latches': 'the context-monitor threshold latches and the push authorization — also from real hook runs',
    'push-authorization': 'the context-monitor threshold latches and the push authorization — also from real hook runs',

    // --- the rollover core, through the PreCompact → SessionStart(compact) sequence ----------------
    'rollover-handoff': 'the rollover core artifacts — from a real PreCompact → SessionStart(compact) sequence',
    'handoff-verification-receipt': 'the rollover core artifacts — from a real PreCompact → SessionStart(compact) sequence',
    'consumption-receipt': 'the rollover core artifacts — from a real PreCompact → SessionStart(compact) sequence',
    'cycle-record': 'the rollover core artifacts — from a real PreCompact → SessionStart(compact) sequence',
    'rollover-journal': 'the rollover core artifacts — from a real PreCompact → SessionStart(compact) sequence',

    /*
     * ⛔ THE INSTALLED TARGET, not the fixture. project-config is written by install/install.js, so the
     * only capture that means anything is one taken from an installation the installer performed — the
     * `opsTargets` array/map defect got past a check that wrote its own config first.
     */
    'project-config': 'artifacts generated by a REAL INSTALLATION conform to their declared schemas',
  };

  /*
   * And every family there is nothing to capture FROM, with the class that says why. `authored-input`
   * is not a description of intent — it is a claim about the registry, proved below against the
   * `writer` field rather than against the prose in `why`.
   */
  const NOT_CAPTURABLE = {
    requirements: {
      class: 'authored-input',
      why: 'HAND-AUTHORED INPUT the kernel READS. registry.json records writer:null deliberately — the approved denominator is the project\'s own, and a tool that could rewrite it could make its own gate easier. No run of this pack produces a requirements.json, so there is no artifact of ours to capture; the half that IS ours is proved at length in the installed-target block, where every malformed shape is refused by the PRODUCTION reader.',
    },
    'task-queue': {
      class: 'authored-input',
      why: 'HAND-AUTHORED by the planner (writer:null), the same class as requirements — the rework task list, decision 2.1 chose ONE tracked family over the kernel audit K-11\'s original two, reusing `contract delegate`/`contract complete --met` for execution and attestation so this pack never writes docs/derived/state/tasks.json at all. No run of this pack can produce one to capture. The reading half that requirements proves in the installed-target block is now proved for this family too, in adapters/claude-code/task-runner/runner.test.mjs: the runner\'s PRODUCTION loader (validateTaskQueue, procedural for the reason schemas/validate.mjs\'s own header gives) refuses a duplicate id, an empty acceptance list, an unknown state and an unimplemented schemaVersion.',
    },
    evidence: {
      class: 'authored-input',
      why: "HAND-AUTHORED INPUT, produced by the project's own qualifying tooling (writer:null). This pack never writes an evidence artifact, so no run of it can emit one to capture. What the installed-target block proves instead is the reading half: evidence at an unknown schemaVersion is REJECTED WITH ITS REASON and never counted toward a requirement.",
    },
    'removals-registry': {
      class: 'authored-input',
      why: 'HAND-AUTHORED INPUT (writer:null), at a path the project may override via respawnpack.config.json. This pack reads the removal contract and never writes one, so there is no artifact of ours to capture; the installed-target block proves the reading half — a registry at a version this kernel cannot interpret yields CANNOT_DETERMINE, never a PASS.',
    },
    lineage: {
      class: 'authored-input',
      why: 'HAND-AUTHORED INPUT (writer:null), the same class as requirements and removals-registry: the provenance declaration is the founder\'s or the planner\'s own record of which source each copy came from, and a tool that could rewrite it could make its own verdict easier. No run of this pack produces a lineage.json, so there is no artifact of ours to capture. The reading half is proved in kernel/kernel.test.mjs across three project archetypes — the PRODUCTION reader (kernel/lib/lineage.js readLineage, procedural for the reason schemas/validate.mjs\'s own header gives) refuses an unimplemented schemaVersion, a duplicate source id, a source declaring both path and url, and a derivation with an empty `from`.',
    },
    'reconciliation-source': {
      class: 'authored-input',
      why: "HAND-AUTHORED INPUT, or an adapter's STDOUT (writer:null). DF-005: this pack owns the invocation and the outcome semantics and owns no task system — kernel/reconcile.test.mjs fences that no project's path appears in the reader. For the stdout form there is not even a path a capture could name, because a stream is not a file.",
    },
    'atomic-task': {
      class: 'authored-input',
      why: 'AUTHORED OUTSIDE THE PACK (writer:null) — the hooks read it to report what a session declared, and nothing here ever writes one. Its schema is deliberately open for the same reason, and the fence that keeps THAT honest is "no reader names a field of atomic-task", already checked against the tree above.',
    },
    'pairs-registry': {
      class: 'authored-input',
      why: 'HAND-AUTHORED INPUT (writer:null) — maintained directly by this pack\'s own maintainers or an agent under review, the same way this file and schemas/registry.json are hand-authored rather than generated. No kernel or hook code reads or writes docs/derived/state/pairs.json at all; its only declared reader is counts-fence.test.mjs, so no run of the CLI or a hook can ever emit one to capture.',
    },
    'capability-register': {
      class: 'authored-input',
      why: 'HAND-AUTHORED INPUT (writer:null) — spine/reference/models/capability-register.json is pack SOURCE transcribed from dated published sources, the same class as pairs-registry and for a sharper reason: a tool that could write its own model capability ratings would be grading the thing it is about to choose. No run of this pack produces one to capture. The reading half is proved by name in the describe at the foot of this file, which validates the REAL document against this schema, checks that every rating other than `unproven` carries a URL, an access date and a claim, and checks the JSON against the rendered document in both directions.',
    },
  };

  /*
   * Every exclusion class, and the check that makes its claim falsifiable. A class with no proof is a
   * shrug with a name, which is what this whole file exists not to accept.
   */
  const EXCLUSION_CLASSES = {
    'authored-input': {
      how: 'the registry itself says this pack has no writer for the family, so no run of it can produce the artifact',
      proof: (f) => f.writer === null,
    },
  };

  /** This file's own source, with escaped quotes normalised so a declared title can be found literally. */
  const SELF = src('kernel/schema.test.mjs').replace(/\\'/g, "'");

  /**
   * The CODE of the test with this exact title, bounded by the next test or the end of its describe.
   *
   * ⛔ COMMENT LINES ARE STRIPPED, AND THAT IS NOT A CONVENIENCE. The first version of the fence below
   * failed on the capture it was written to protect — matching `assert.ok(true` inside the comment that
   * EXPLAINS the defect. Same shape as the goal-refusal scan that once matched the rejection message
   * quoting the phrase it was searching for: an assertion that reads explanation as evidence is
   * measuring the wrong thing. Prose about a capture is not a capture, in either direction.
   */
  const testBody = (title) => {
    const at = SELF.indexOf(`test('${title}'`);
    if (at < 0) return null;
    const ends = ['\n  test(', '\n});'].map((m) => SELF.indexOf(m, at + 1)).filter((i) => i > 0);
    return SELF.slice(at, ends.length ? Math.min(...ends) : SELF.length)
      .split(/\r?\n/).filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');
  };

  test('⛔ every registered family is classified — captured from a real run, or excluded with a class', () => {
    const unclassified = REGISTRY.families
      .map((f) => f.family)
      .filter((f) => !(f in CAPTURED) && !(f in NOT_CAPTURABLE));
    assert.deepEqual(unclassified, [],
      'these registered families say nothing about whether any real run has ever validated them, so a writer that '
      + 'started emitting an undeclared field would fail nowhere. Name the test that captures each, or exclude it '
      + `with a class:\n  ${unclassified.join('\n  ')}`);

    const both = Object.keys(CAPTURED).filter((f) => f in NOT_CAPTURABLE);
    assert.deepEqual(both, [], `these families are declared BOTH captured and not capturable: ${both.join(', ')}`);

    // Two-sided: a classification for a family that no longer exists is a fence about nothing.
    for (const f of [...Object.keys(CAPTURED), ...Object.keys(NOT_CAPTURABLE)]) {
      assert.ok(familyNamed(f), `"${f}" is classified here but is not a registered family`);
    }
  });

  test('⛔ every named capture test exists and really captures that family — verified against the tree', () => {
    for (const [family, title] of Object.entries(CAPTURED)) {
      const body = testBody(title);
      assert.ok(body, `family ${family} names a capture test that does not exist in this file: "${title}"`);
      assert.equal(SELF.indexOf(`test('${title}'`), SELF.lastIndexOf(`test('${title}'`),
        `two tests share the title "${title}", so naming it cannot identify which one captures ${family}`);

      const schema = familyNamed(family).schema;
      assert.ok(body.includes(schema),
        `"${title}" is named as ${family}'s capture and never mentions ${schema} — either it stopped capturing that family, or the record is stale`);
      assert.ok(/\bcapture(Lines)?\s*\(/.test(body),
        `"${title}" is named as ${family}'s capture and calls neither capture() nor captureLines(), so nothing it does is witnessed`);

      /*
       * ⛔ AND NO ASSERTION THAT CANNOT FAIL. `else assert.ok(true, '...the shape is covered by its
       * negative fixtures')` is the literal shape that hid threshold-latches for a release: a sentence
       * explaining why exercising nothing was acceptable, in a branch taken every single run.
       */
      assert.doesNotMatch(body, /assert\.ok\(\s*true\b/,
        `"${title}" contains an assertion that cannot fail — a capture with an escape hatch reports coverage it does not have`);
    }
  });

  test('every exclusion names a declared class, and the class is proved against the registry', () => {
    for (const [family, e] of Object.entries(NOT_CAPTURABLE)) {
      const cls = EXCLUSION_CLASSES[e.class];
      assert.ok(cls, `${family} is excluded as "${e.class}", which is not a declared exclusion class`);
      assert.ok(e.why && e.why.length > 60, `the exclusion for ${family} is a label, not a justification`);
      assert.ok(cls.proof(familyNamed(family)),
        `${family} is excluded as "${e.class}" — ${cls.how} — and the registry now disagrees: `
        + `it names ${JSON.stringify(familyNamed(family).writer)} as the writer. If this pack writes it, it can be captured.`);
    }

    /*
     * The other direction, which is what stops the split from becoming a matter of taste: the registry
     * decides which side a family lands on, not this table. A family with a writer must be CAPTURED;
     * one without a writer must be EXCLUDED. Adding either kind forces the corresponding work.
     */
    const writerlessButCaptured = Object.keys(CAPTURED).filter((f) => familyNamed(f).writer === null);
    assert.deepEqual(writerlessButCaptured, [],
      'these families are declared captured, but the registry says this pack does not write them — so whatever '
      + `the named test validated, it was not an artifact of ours: ${writerlessButCaptured.join(', ')}`);

    const writtenButExcluded = Object.keys(NOT_CAPTURABLE).filter((f) => familyNamed(f).writer !== null);
    assert.deepEqual(writtenButExcluded, [],
      'these families are excluded from capture, but the registry names a writer for each — this pack produces them, '
      + `so a real run can produce one to capture: ${writtenButExcluded.join(', ')}`);
  });

  test('⛔ every declared capture ACTUALLY RAN — the witness, not the source, is the evidence', () => {
    /*
     * ⛔ THIS IS THE FENCE. Everything above reads the source, and the source read fine for a whole
     * release: a test existed, named a schema, and never executed the line that mattered. capture() and
     * captureLines() record only when they RUN, so a capture inside a branch that is never taken — or
     * one whose artifact was never written — registers nothing and is reported here BY NAME.
     *
     * This describe is last in the file on purpose: node:test runs a file's tests in declaration order,
     * so every capture block above has finished by the time this asks what happened. It is a witness
     * over the whole run and needs the whole run — filtering to a subset of tests will fail it, which
     * is the correct answer to "was everything captured" when everything did not run.
     */
    const missing = Object.entries(CAPTURED)
      .filter(([family]) => !CAPTURED_FROM_DISK.has(familyNamed(family).schema))
      .map(([family, title]) => `${family} (${familyNamed(family).schema}) — declared captured by "${title}"`);
    assert.deepEqual(missing, [],
      'these families are DECLARED captured from a real run and no capture of them executed. A capture that does not '
      + 'run proves nothing and must not read as coverage — drive the writer until it produces the artifact, or say '
      + `here why it cannot be produced:\n  ${missing.join('\n  ')}`);

    // Two-sided: something captured but declared uncapturable means the exclusion's reasoning is wrong.
    const byName = new Map(REGISTRY.families.map((f) => [f.schema, f.family]));
    const surprises = [...CAPTURED_FROM_DISK]
      .filter((s) => byName.has(s) && !(byName.get(s) in CAPTURED))
      .map((s) => `${byName.get(s)} (${s})`);
    assert.deepEqual(surprises, [],
      `a real run captured these families, which are declared not capturable: ${surprises.join(', ')}`);
  });
});

// ---------------------------------------------------------------------------------------------
/*
 * ⛔ P-023 — docs/derived/state/pairs.json RECORDED ITSELF AS ITS OWN UNFENCED PAIR: a state artifact
 * with no declared schema and no registered family, sitting in the directory that exists to catch
 * exactly that. The bijection tests above (registry ↔ schema directory, registry ↔ classification
 * maps) now cover it as one row among many — but per this file's own opening header, an inventory
 * built from what is present cannot report an absence, and none of those sweeps names pairs.json by
 * path. So it is named here, the same way contract.json and delegations.json are named above in
 * "the artifact the failure was reported against is fenced by name": a generic sweep passing is not
 * evidence that THIS specific artifact was ever checked.
 */
describe('⛔ P-023 — the register of unmirrored obligations is not itself an unmirrored obligation', () => {
  test('docs/derived/state/pairs.json has a registered family, a declared schema, and conforms to it', () => {
    const f = familyNamed('pairs-registry');
    assert.ok(f, 'docs/derived/state/pairs.json has no registered family — P-023 has regressed');
    assert.equal(f.path, 'docs/derived/state/pairs.json', 'the pairs-registry family no longer names pairs.json');
    assert.doesNotThrow(() => compile(schemaOf(f.schema)), `${f.schema} uses a keyword the validator cannot enforce`);
    conforms(readJSON(path.join(ROOT, f.path)), f.schema, f.path);
  });
});

// ---------------------------------------------------------------------------------------------
/*
 * ⛔ P2-K-15 — examples/todo-app/respawnpack.config.json is a WORKED EXAMPLE, never a captured
 * artifact: nobody ever ran the installer against it, so it is checked with conforms() (a shape
 * check against a document this suite read off disk) and never capture()/captureLines() (which
 * record a WITNESSED real run — see CAPTURED_FROM_DISK at the top of this file). project-config's
 * own capture stays the installed-target test above; this describe adds nothing to CAPTURED or
 * NOT_CAPTURABLE and registers no new family.
 *
 * Before this fix the example demonstrated only the OLD shape: routeSource held a real glob and
 * codeTruth held a real (if malformed — one comma-joined string, not an array) value, so both still
 * classified CONFIGURED. The actual defect was ABSENCE: state.removals, state.reconcile and
 * qualityGate were never declared at all, so kernel/lib/applicability.js had no decision to read
 * for three of the six optional contracts and classified each UNDECIDED — a worked example a
 * founder could copy verbatim and still land on "nobody decided" for half of it.
 */
describe('⛔ P2-K-15 — examples/todo-app/respawnpack.config.json is fixed and fenced', () => {
  const EXAMPLE_DIR = path.join(ROOT, 'examples', 'todo-app');
  const EXAMPLE_CONFIG = path.join(EXAMPLE_DIR, 'respawnpack.config.json');
  const applicabilityLib = require_(path.join(KERNEL, 'lib', 'applicability.js'));

  /** Every optional contract must be a DECISION — CONFIGURED or NOT_APPLICABLE — never UNDECIDED or INVALID. */
  const allDecided = (dir) => {
    const s = applicabilityLib.survey(dir);
    const stray = s.rows.filter((r) => r.state !== 'CONFIGURED' && r.state !== 'NOT_APPLICABLE');
    return { ok: stray.length === 0, stray, survey: s };
  };

  /** A bare directory holding only a config — applicability.survey() reads no other project scaffolding. */
  const withTempConfig = (doc, fn) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-todo-app-'));
    try {
      fs.writeFileSync(path.join(tmp, 'respawnpack.config.json'), JSON.stringify(doc, null, 2));
      return fn(tmp);
    } finally { rm(tmp); }
  };

  test('the defect — the pre-fix example left three optional contracts UNDECIDED', () => {
    /*
     * A literal snapshot of examples/todo-app/respawnpack.config.json as it read before this fix
     * (git show b9094a8:examples/todo-app/respawnpack.config.json). The real file on disk is now
     * the corrected one, so the broken shape is reconstructed here rather than read off disk —
     * this IS the assertion that was run against the old file and seen to fail before the fix
     * landed, kept as a permanent regression fixture.
     */
    const PRE_FIX_DOC = {
      respawnpack: '0.1.0',
      installedAt: '2026-04-02',
      routeSource: 'app/**/page.{tsx,jsx,ts,js}',
      opsTargets: { db: 'supabase' },
      codeTruth: 'lib/tokens.ts, lib/strings/en.ts, supabase/migrations/',
      extras: ['playwright-mcp', 'supabase'],
      note: 'ROUTE_SOURCE + CODE_TRUTH feed /savepoint drift-check; OPS_TARGETS feed the ops skills; EXTRAS is the adoption interview\'s record.',
    };
    withTempConfig(PRE_FIX_DOC, (dir) => {
      const { ok, stray } = allDecided(dir);
      assert.equal(ok, false, 'the pre-fix shape was expected to leave contracts undecided, but every row resolved — the fixture no longer reproduces the defect');
      assert.deepEqual(stray.map((r) => r.subsystem).sort(), ['qualityGate', 'reconcile', 'removals'],
        `expected exactly removals/reconcile/qualityGate undecided, got: ${stray.map((r) => `${r.subsystem}=${r.state}`).join(', ') || '(none)'}`);
      assert.ok(stray.every((r) => r.state === 'UNDECIDED'), `expected UNDECIDED for the absent keys, not INVALID: ${stray.map((r) => `${r.subsystem}=${r.state}`).join(', ')}`);
    });
  });

  test('corrected — the fixed example conforms to the schema and every optional contract is decided', () => {
    assert.doesNotThrow(() => compile(schemaOf('project-config.schema.json')), 'project-config.schema.json uses a keyword the validator cannot enforce');
    const doc = readJSON(EXAMPLE_CONFIG);
    // conforms(), never capture(): a worked example nobody installed is not a witnessed real run.
    conforms(doc, 'project-config.schema.json', 'examples/todo-app/respawnpack.config.json');

    const { ok, stray, survey } = allDecided(EXAMPLE_DIR);
    assert.equal(ok, true, `every optional contract must be CONFIGURED or NOT_APPLICABLE: ${stray.map((r) => `${r.subsystem}=${r.state}`).join(', ')}`);
    assert.equal(survey.onboardingComplete, true, 'applicability.js\'s own onboardingComplete flag disagrees with a per-row read of the same survey');
    assert.equal(survey.rows.length, 6, 'expected all six surveyed optional-contract rows — the row count itself drifted');
    assert.deepEqual(survey.rows.filter((r) => r.state === 'CONFIGURED').map((r) => r.subsystem).sort(), ['codeTruth', 'routes'],
      'routes and codeTruth are the CONFIGURED half of this worked example — real values, not opt-outs');
    assert.deepEqual(
      survey.rows.filter((r) => r.state === 'NOT_APPLICABLE').map((r) => r.subsystem).sort(),
      ['qualityGate', 'reconcile', 'removals', 'requirements'],
      'qualityGate/reconcile/removals must declare the current {notApplicable:true, reason} object form; requirements resolves NOT_APPLICABLE on its own with no config key at all',
    );
  });

  test('nearest bypass — reverting one key to its pre-fix absent form is caught by the same fence', () => {
    /*
     * The smallest deviation from the fixed file that reintroduces the defect: everything else
     * stays exactly as fixed, and only state.removals reverts to entirely absent — its own
     * pre-fix shape. Proves the fence does not depend on every field moving together.
     */
    const fixed = readJSON(EXAMPLE_CONFIG);
    const reverted = JSON.parse(JSON.stringify(fixed));
    delete reverted.state.removals;
    withTempConfig(reverted, (dir) => {
      const { ok, stray } = allDecided(dir);
      assert.equal(ok, false, 'dropping state.removals back to absent must reintroduce an undecided contract');
      assert.deepEqual(stray.map((r) => r.subsystem), ['removals']);
      assert.equal(stray[0].state, 'UNDECIDED', `expected UNDECIDED, got ${stray[0] && stray[0].state}`);
    });
  });

  test('the example is a fixture, not a captured artifact — absent from capture() and the fixture-family registry', () => {
    // No registered family in schemas/registry.json is anchored at the example's own path.
    const anchoredHere = REGISTRY.families.filter((f) => typeof f.path === 'string' && f.path.includes('examples/todo-app'));
    assert.deepEqual(anchoredHere, [], `examples/todo-app must not be a registered fixture family: ${anchoredHere.map((f) => f.family).join(', ')}`);

    // Nowhere in this suite is the example's config passed to capture()/captureLines() — conforms() only.
    const capturingLines = src('kernel/schema.test.mjs').split(/\r?\n/)
      .filter((l) => /\bcapture(Lines)?\s*\(/.test(l) && l.includes('examples/todo-app'));
    assert.deepEqual(capturingLines, [],
      'examples/todo-app/respawnpack.config.json must only ever be checked with conforms() — it is a worked example nobody installed, and '
      + 'capture()/captureLines() are reserved for artifacts a real run produced');
  });
});

// ---------------------------------------------------------------------------------------------
/*
 * ⛔ P5-N-4 — docs/derived/state/tasks.json: the tracked task queue, decision 2.1's reversible half.
 *
 * The rework task list, §2.1 chose ONE new family over the kernel audit §5 K-11's original two: execution and
 * attestation reuse `contract delegate --task --acceptance` and `contract complete --met`, which
 * already refuse an empty acceptance list and a partial attestation (the anti-drift core's items 9-11,
 * §1). What is new is only the durable, ordered queue — no verb, no runtime pointer, and (deliberately)
 * no reader yet. That makes `task-queue` an AUTHORED family (registry.json: writer null), so its own
 * NOT_CAPTURABLE and NOT_ATOMIC entries above are the classification; this block is for what the
 * generic per-family fixture loop above cannot cover — an explicit conforms()-not-capture() proof, and
 * the two ways a row can be wrong that a committed fixture is not the right place to demonstrate.
 */
describe('the task queue: docs/derived/state/tasks.json (P5-N-4)', () => {
  const SCHEMA = 'tasks.schema.json';
  const validDoc = () => readJSON(path.join(SCHEMA_DIR, 'fixtures', 'task-queue', 'valid.json'));

  test('the valid fixture conforms — a conforms() case, never a capture() case', () => {
    // AUTHORED (writer:null): nothing in this pack ever produces docs/derived/state/tasks.json, so
    // there is no real run to CAPTURE it from (see this family's entry in NOT_CAPTURABLE, above, and
    // the exclusion class proof that rests on registry.json's writer:null). conforms() proves only that
    // the fixture and the schema agree with each other — the distinction its own header draws — and,
    // unlike capture(), never marks the schema as validated from a real run.
    conforms(validDoc(), SCHEMA, 'schemas/fixtures/task-queue/valid.json');
    assert.ok(!CAPTURED_FROM_DISK.has(SCHEMA),
      'conforms() must never register a capture — that would misreport an authored family as one this pack writes');
  });

  test('a duplicate task id is rejected — JSON Schema has no keyword for cross-item uniqueness, so this file checks it directly', () => {
    /*
     * ⛔ WHY HERE AND NOT IN tasks.schema.json. schemas/validate.mjs's SUPPORTED set has no `uniqueItems`
     * ('an unsupported keyword is a hard error', above, proves compile() throws on it), and even a
     * validator that had one would only compare whole array items, not one field of them. This is the
     * identical gap kernel/lib/reconcile.js:267 hits for reconciliation-source's own ids, resolved the
     * same way there: DUPLICATE_ID is a PROCEDURAL check, not a schema keyword. task-queue has no reader
     * yet to carry that check (decision 2.1), so it is asserted here instead.
     */
    const doc = validDoc();
    doc.tasks.push({ ...doc.tasks[0] }); // a second row, same id as tasks[0]
    assert.equal(validate(doc, schemaOf(SCHEMA)).valid, true,
      'this documents the gap the comment above names: the schema alone accepts a duplicate id');
    const ids = doc.tasks.map((t) => t.id);
    const duplicated = ids.filter((id, i) => ids.indexOf(id) !== i);
    assert.ok(duplicated.length, 'the document was supposed to duplicate an id — it no longer does, so it no longer exercises this check');
    assert.notEqual(new Set(ids).size, ids.length,
      'a duplicate task id must be rejected: two rows in one queue cannot share one stable handle');
  });

  test('an empty acceptance array is rejected — the same rule contract delegate --acceptance enforces', () => {
    const doc = validDoc();
    doc.tasks[0].acceptance = [];
    const r = validate(doc, schemaOf(SCHEMA));
    assert.equal(r.valid, false,
      'a task with acceptance:[] was accepted — a bounded task with no definition of done is an unbounded one with a shorter description');
    assert.match(r.errors.join(' '), /acceptance/);
  });

  test('a row with an unknown state value is rejected', () => {
    const doc = validDoc();
    doc.tasks[0].state = 'archived'; // not one of proposed|ready|in-progress|blocked|done|abandoned
    const r = validate(doc, schemaOf(SCHEMA));
    assert.equal(r.valid, false, 'a task row with an invented state value was accepted');
    assert.match(r.errors.join(' '), /state/);
  });
});

/*
 * ⛔ P3-T-09a · THE POSTURE KEY, REJECTED FOR THE RIGHT REASON RATHER THAN MERELY REJECTED.
 *
 * The sweep above already asserts that every `invalid-*` fixture is refused. That is not enough for
 * these three: a fixture rejected because some UNRELATED part of it broke would pass that sweep while
 * proving nothing about the constraint it was written for. ADR-003 names three distinct failures, and
 * each is a different promise — an unknown profile is a posture nobody could have chosen, a reason-less
 * override is an override nobody has to justify, and an override on a fixed rule is a refusal that must
 * be REFUSED rather than silently discarded. So each fixture is checked against the error it is for.
 *
 * The positive control is in the same test on purpose: `respawnpack.config.json` is
 * `additionalProperties: true` at the top level, so a schema that simply failed to describe `posture`
 * would accept every one of these documents, and a schema that described it wrongly could reject all of
 * them including the legitimate declaration. Both directions are asserted here.
 */
describe('the posture key (P3-T-09a) · each malformed declaration is rejected for its own reason', () => {
  const SCHEMA = schemaOf('project-config.schema.json');
  const FIX = path.join(SCHEMA_DIR, 'fixtures', 'project-config');
  const errorsFor = (file) => validate(readJSON(path.join(FIX, file)), SCHEMA).errors.join(' | ');

  test('a well-formed posture VALIDATES — the constraints below are not a schema that rejects everything', () => {
    const valid = readJSON(path.join(FIX, 'valid.json'));
    assert.ok(valid.posture && valid.posture.profile,
      'the valid project-config fixture no longer carries a posture, so the three negatives below are derived from a seed that never exercised the key');
    const r = validate(valid, SCHEMA);
    assert.equal(r.valid, true, `the valid fixture's posture must validate:\n  ${r.errors.join('\n  ')}`);
  });

  test('an unknown profile is rejected by the enum, not by something else in the document', () => {
    const e = errorsFor('invalid-posture-bad-profile.json');
    assert.match(e, /posture\.profile/, `the rejection must name posture.profile: ${e}`);
    assert.match(e, /"light","standard","strict"|light.*standard.*strict/,
      `the rejection must name the three postures that are allowed, so a founder can see what to write: ${e}`);
  });

  test('a reason-less override is rejected for the MISSING REASON, which is the whole point of requiring one', () => {
    const e = errorsFor('invalid-posture-override-no-reason.json');
    assert.match(e, /missing required property "reason"/,
      `an override with no reason must be refused by name — an override nobody has to justify is an override nobody reviews: ${e}`);
  });

  test('an override naming a rule that is fixed in every posture is refused by the key, not accepted and ignored', () => {
    const e = errorsFor('invalid-posture-override-on-fixed-id.json');
    assert.match(e, /posture\.overrides/, `the rejection must name posture.overrides: ${e}`);
    assert.match(e, /secret-scan/,
      `the rejection must name the id that was refused, or a founder learns only that something in their config is wrong: ${e}`);
  });

  /*
   * ⛔ AND THE REFUSED SET IS DERIVED FROM THE RUNTIME, NOT LISTED TWICE. `hooks/_posture.js` is the ONE
   * reader, and it refuses an override on a fixed id at run time; this schema refuses the same override
   * at declaration time. Two hand-written lists that agree today are a coincidence with no mechanism
   * holding them true tomorrow, so they are compared.
   */
  test('⛔ the schema refuses exactly the ids hooks/_posture.js calls fixed, and carries no key for one', () => {
    const posture = createRequire(import.meta.url)(path.join(ROOT, 'hooks', '_posture.js'));
    const refused = SCHEMA.properties.posture.properties.overrides.propertyNames.not.enum;
    assert.deepEqual([...refused].sort(), [...posture.FIXED_IDS].sort(),
      'the schema and the resolver disagree about which rules are fixed in every posture');
    assert.deepEqual(posture.FIXED_IDS.filter((id) => Object.prototype.hasOwnProperty.call(posture.RESOLVER, id)), [],
      'a fixed id is reachable in the resolver table — a key that exists can be overridden, and the design is that there is nothing to ask for');
  });
});

/*
 * ⛔ P6-5-7 · THE PROJECT TYPE, REFUSED FOR ITS OWN REASON AND AGREED WITH THE ONE THING THAT READS IT.
 *
 * `projectType` decides which digest sections `install/install.js` composes into a target's CLAUDE.md.
 * The top level of this file is `additionalProperties: true`, so a schema that simply failed to
 * describe the key would accept every misspelling as a founder note sitting beside `posture` — which is
 * why the positive control and the negative are in the same describe, exactly as they are for `posture`
 * above. And because the enum here and the composer's own table are two lists that must agree, the
 * second test derives them from both sources rather than trusting that they happen to match today.
 */
describe('the projectType key (P6-5-7) · a declared type validates, an unknown one is refused by name', () => {
  const SCHEMA = schemaOf('project-config.schema.json');
  const FIX = path.join(SCHEMA_DIR, 'fixtures', 'project-config');
  const errorsFor = (file) => validate(readJSON(path.join(FIX, file)), SCHEMA).errors.join(' | ');

  test('a declared project type VALIDATES — the enum below is not a schema that rejects every declaration', () => {
    const valid = readJSON(path.join(FIX, 'valid.json'));
    assert.ok(typeof valid.projectType === 'string' && valid.projectType,
      'the valid project-config fixture no longer carries a projectType, so the negative below is derived from a seed that never exercised the key');
    const r = validate(valid, SCHEMA);
    assert.equal(r.valid, true, `the valid fixture's projectType must validate:\n  ${r.errors.join('\n  ')}`);
  });

  test('an unknown project type is rejected by the enum, and the rejection names the types that exist', () => {
    const e = errorsFor('invalid-project-type-unknown.json');
    assert.match(e, /projectType/, `the rejection must name projectType: ${e}`);
    assert.match(e, /docs-only[\s\S]*ops-infra[\s\S]*greenfield-app[\s\S]*mature-product/,
      `the rejection must name the four types that are allowed, so a founder can see what to write: ${e}`);
  });

  /*
   * ⛔ AND THE ENUM IS THE COMPOSER'S OWN TABLE, NOT A SECOND COPY OF IT. `install/install.js` keys
   * `PROJECT_TYPE_DROPS` by project type and refuses at install time any value it has no key for; this
   * schema refuses the same value at declaration time. Two hand-written lists that agree today are a
   * coincidence with no mechanism holding them true tomorrow, so they are compared in both directions.
   */
  test('⛔ the schema allows exactly the types install/install.js can compose a block for', () => {
    const installer = fs.readFileSync(path.join(ROOT, 'install', 'install.js'), 'utf8');
    const table = /const PROJECT_TYPE_DROPS = \{([\s\S]*?)\n\};/.exec(installer);
    assert.ok(table, 'install.js no longer declares PROJECT_TYPE_DROPS as a literal object — re-aim this fence rather than deleting it');
    const composable = [...table[1].matchAll(/^\s*'([\w-]+)':/gm)].map((m) => m[1]).sort();
    assert.deepEqual([...SCHEMA.properties.projectType.enum].sort(), composable,
      'the schema and the installer disagree about which project types exist — a type the schema accepts and the '
      + 'installer cannot compose would validate at declaration time and then refuse to write a block, and a type the '
      + 'installer composes and the schema rejects is a working feature the founder is told is invalid');
  });
});

/*
 * ⛔ P1-E-1a · THE EXCEPTIONS KEY, REFUSED FOR ITS OWN REASON RATHER THAN MERELY REFUSED.
 *
 * The sweep above already asserts that every `invalid-*` fixture is rejected. That is not enough for
 * these five: a fixture rejected because some UNRELATED part of it broke would pass that sweep while
 * proving nothing about the constraint it was written for. Each of the five is a different promise. An
 * allowance nobody has to justify is an allowance nobody reviews. A rule with no subject notion has
 * nothing for an exception to name. A `match` with no key would apply to every subject the rule sees,
 * which is the whole-guard escape this grammar exists to REPLACE. A subject kind the named rule never
 * computes is a condition that can never hold, so it reads as declared and lifts nothing. And a date
 * nobody can parse would decide when the allowance stops working.
 *
 * The positive control is in the same describe on purpose: the top level of this file is
 * `additionalProperties: true`, so a schema that simply failed to describe `exceptions` would accept
 * every one of these documents, and a schema that described it wrongly could reject all of them
 * including the legitimate declaration. Both directions are asserted here.
 */
describe('the exceptions key (P1-E-1a) · each malformed declaration is rejected for its own reason', () => {
  const SCHEMA = schemaOf('project-config.schema.json');
  const FIX = path.join(SCHEMA_DIR, 'fixtures', 'project-config');
  const errorsFor = (file) => validate(readJSON(path.join(FIX, file)), SCHEMA).errors.join(' | ');

  test('a well-formed exception list VALIDATES — the constraints below are not a schema that rejects everything', () => {
    const valid = readJSON(path.join(FIX, 'valid.json'));
    assert.ok(Array.isArray(valid.exceptions) && valid.exceptions.length >= 2,
      'the valid project-config fixture no longer carries two exceptions, so the five negatives below are derived from a seed that never exercised the key the way a real project does');
    const shapes = new Set(valid.exceptions.map((e) => Object.keys(e.match).sort().join('+')));
    assert.ok(shapes.size >= 2,
      'every exception in the seed matches on the same keys, so the negatives cannot discriminate between the multi-key rule and the single-key one');
    const r = validate(valid, SCHEMA);
    assert.equal(r.valid, true, `the valid fixture's exceptions must validate:\n  ${r.errors.join('\n  ')}`);
  });

  test('a reason-less exception is rejected for the MISSING REASON, which is the whole point of requiring one', () => {
    const e = errorsFor('invalid-exception-no-reason.json');
    assert.match(e, /missing required property "reason"/,
      `an exception with no reason must be refused by name — an allowance nobody has to justify is an allowance nobody reviews: ${e}`);
  });

  test('a rule with no subject notion is rejected by the enum, and the rejection names the rules that have one', () => {
    const e = errorsFor('invalid-exception-unknown-rule.json');
    assert.match(e, /exceptions\[\d+\]\.rule/, `the rejection must name the rule field: ${e}`);
    assert.match(e, /"lockdown"/, `the rejection must name the rule that was refused: ${e}`);
    assert.match(e, /secret-scan[\s\S]*injection-scan[\s\S]*readiness/,
      `the rejection must name the rules that CAN be excepted, so a founder can see what to write: ${e}`);
  });

  test('a match with no subject is refused, because an exception that names nothing would lift everything', () => {
    const e = errorsFor('invalid-exception-no-match.json');
    assert.match(e, /exceptions\[\d+\]\.match/, `the rejection must name the match object: ${e}`);
    assert.match(e, /path[\s\S]*fingerprint[\s\S]*command[\s\S]*item/,
      `the rejection must name the four subject kinds one of which is required: ${e}`);
  });

  test('a subject kind the named rule does not have is refused by the key, not accepted and never matched', () => {
    const e = errorsFor('invalid-exception-subject-kind-rule-lacks.json');
    assert.match(e, /exceptions\[\d+\]/, `the rejection must name the entry: ${e}`);
    assert.match(e, /fingerprint/, `the rejection must name the subject kind that does not belong: ${e}`);
    assert.match(e, /additionalProperties is false/,
      `the rejection must come from the per-rule narrowing rather than from something unrelated in the document: ${e}`);
  });

  test('a malformed expires is rejected by the date pattern, not carried along as a comment', () => {
    const e = errorsFor('invalid-exception-malformed-expires.json');
    assert.match(e, /exceptions\[\d+\]\.expires/, `the rejection must name the field: ${e}`);
    assert.match(e, /does not match/, `the rejection must say the value is not a date this reader can parse: ${e}`);
  });

  /*
   * ⛔ AND THE ACCEPTED SET IS DERIVED FROM THE RUNTIME, NOT LISTED TWICE. `hooks/_exceptions.js` is the
   * ONE reader, and it refuses an entry at run time; this schema refuses the same entry at declaration
   * time. Two hand-written lists that agree today are a coincidence with no mechanism holding them true
   * tomorrow, so they are compared, in both directions and for the per-rule narrowing as well.
   */
  test('⛔ the schema accepts exactly the rules and subject kinds hooks/_exceptions.js carries', () => {
    const mod = createRequire(import.meta.url)(path.join(ROOT, 'hooks', '_exceptions.js'));
    const item = SCHEMA.properties.exceptions.items;
    assert.deepEqual([...item.properties.rule.enum].sort(), Object.keys(mod.EXCEPTION_RULES).sort(),
      'the schema and the reader disagree about which rules can be excepted');
    assert.deepEqual(Object.keys(item.properties.match.properties).sort(), [...mod.SUBJECT_KINDS].sort(),
      'the schema and the reader disagree about which subject kinds exist');
    const narrowed = Object.fromEntries(item.allOf.map((g) => [
      g.anyOf[0].not.properties.rule.const,
      Object.keys(g.anyOf[1].properties.match.properties).sort(),
    ]));
    assert.deepEqual(narrowed, Object.fromEntries(Object.entries(mod.EXCEPTION_RULES).map(([r, k]) => [r, [...k].sort()])),
      'the schema narrows a rule to different subject kinds than EXCEPTION_RULES does, so a declaration one accepts the other would refuse');
    assert.deepEqual(Object.keys(item.properties).sort(), [...mod.ENTRY_FIELDS].sort(),
      'the schema and the reader disagree about which fields an entry may carry, and both refuse anything else — so one would reject an entry the other accepts');
  });
});

// ---------------------------------------------------------------------------------------------
/*
 * ⛔ P4-M-1 — spine/reference/models/capability-register.json IS A CLAIM ABOUT SOMEBODY ELSE'S PRODUCT,
 * AND THAT IS A NEW HAZARD FOR THIS DIRECTORY.
 *
 * Every other tracked family here describes a document about THIS project: its requirements, its
 * removals, its lineage. The capability register describes thirteen models nobody in this repository
 * controls, and it exists to tell a router which of them to send work to. The failure mode is not a
 * malformed document. It is a PLAUSIBLE one: a rating somebody typed because they read a launch post,
 * sitting in the same table and the same shape as a rating transcribed from a dated vendor page, and
 * indistinguishable from it a month later. Anti-drift item 42's rule for the capability matrix is the
 * same rule pointing the other way (that file stays generated so nobody hand-edits it); this one is
 * hand-authored on purpose and is fenced on the EVIDENCE instead.
 *
 * So the properties below are checked, and the artifact is named by path rather than swept for, per
 * this file's own header: a generic sweep passing is not evidence that THIS document was checked.
 *
 *   1. The real file validates against the real schema. Not a fixture: schemas/fixtures/ proves the
 *      schema discriminates, and only the real document proves the register obeys it.
 *   2. Every rating other than `unproven` carries at least one source with a URL, an access date and
 *      the claim that source supports. The schema says so; this asserts it on the real content, and
 *      then MUTATES a copy to prove the schema is what is doing the work.
 *   3. The JSON and the rendered capability-register.md name the same models, in both directions, and
 *      a copy with an extra model is caught. A rendered document that quietly drifts from its data is
 *      the shape of every stale table this program has found.
 *   4. No credential and no private identifier is in any of the six files this task ships, checked
 *      with release/build-public.sh's own patterns and hooks/secret-scan.js's own HIGH-severity set,
 *      both read out of those files rather than retyped here (anti-drift item 52).
 */
describe('⛔ P4-M-1 — the model capability register is evidence-bound, not hand-asserted', () => {
  const REG_JSON = 'spine/reference/models/capability-register.json';
  const REG_MD = 'spine/reference/models/capability-register.md';
  const PROMPTING = ['anthropic', 'openai', 'minimax', 'general'].map((f) => `spine/reference/models/prompting-${f}.md`);
  const SHIPPED = [REG_JSON, REG_MD, ...PROMPTING];

  const family = () => familyNamed('capability-register');
  const register = () => readJSON(path.join(ROOT, REG_JSON));
  /** Model ids as the RENDERED document spells them: one `### <name> · <id>` heading per model. */
  const headingIds = (md) => [...md.matchAll(/^### .+ · `([^`]+)`\s*$/gm)].map((m) => m[1]);
  /** Model ids as the rendered document's at-a-glance matrix spells them: one row per model. */
  const matrixIds = (md) => [...md.matchAll(/^\| `([^`]+)` \| (?:Anthropic|OpenAI|MiniMax) \|/gm)].map((m) => m[1]);

  test('the register is a registered family whose declared path is the file on disk, and it conforms', () => {
    const f = family();
    assert.ok(f, 'spine/reference/models/capability-register.json has no registered family');
    assert.equal(f.path, REG_JSON, 'the capability-register family no longer names the register');
    assert.equal(f.writer, null, 'the registry now names a writer for the capability register — a tool that could write its own model ratings would be grading the thing it is about to choose');
    assert.doesNotThrow(() => compile(schemaOf(f.schema)), `${f.schema} uses a keyword the validator cannot enforce`);
    // conforms(), never capture(): nothing this pack RUNS produces this document, so it is a shape
    // check on a real file rather than a witnessed artifact (see CAPTURED_FROM_DISK at the top).
    conforms(register(), f.schema, REG_JSON);
  });

  test('⛔ every rating that is not `unproven` carries a URL, an access date and a claim', () => {
    const doc = register();
    const schema = schemaOf(family().schema);
    const thin = [];
    let rated = 0;
    for (const m of doc.models) {
      for (const [cls, r] of Object.entries(m.ratings)) {
        if (r.rating === 'unproven') {
          assert.equal(r.evidence.length, 0, `${m.id}.${cls} is unproven and cites sources — an unproven rating with citations is a rating somebody softened rather than removed`);
          assert.ok(r.why && r.why.length > 40, `${m.id}.${cls} is unproven and does not say what is missing`);
          continue;
        }
        rated += 1;
        assert.ok(r.evidence.length >= 1, `${m.id}.${cls} is rated "${r.rating}" with no evidence`);
        for (const e of r.evidence) {
          if (!/^https:\/\//.test(e.url) || !/^\d{4}-\d{2}-\d{2}$/.test(e.accessedAt) || !(e.claim || '').trim()) {
            thin.push(`${m.id}.${cls} -> ${JSON.stringify(e).slice(0, 120)}`);
          }
        }
      }
      assert.ok(m.vendorPositioning.evidence.length >= 1, `${m.id} states a vendor positioning with no source`);
      assert.deepEqual(m.probes, [], `${m.id} carries a probe record. Probes are the owner's action and nothing in this run may write one`);
    }
    assert.deepEqual(thin, [], `these ratings cite something that is not a dated source:\n  ${thin.join('\n  ')}`);
    assert.ok(rated >= 20, `only ${rated} ratings carry evidence — a register that rates almost nothing is not being checked by this fence`);

    /*
     * ⛔ AND THE FENCE ITSELF, MUTATED. Everything above reads the file as it is. If the schema stopped
     * refusing an unsourced rating, those assertions would still pass on a register nobody had broken
     * yet — the same "an inventory built from what is present cannot report an absence" shape this file
     * opens with. So a copy is broken deliberately, both ways round.
     */
    const forged = JSON.parse(JSON.stringify(doc));
    forged.models[0].ratings.extraction = { rating: 'preferred', evidence: [], why: 'because it feels right' };
    assert.equal(validate(forged, schema).valid, false,
      'the schema accepted a `preferred` rating with an empty evidence list, so every citation in this register is decorative');

    const softened = JSON.parse(JSON.stringify(doc));
    softened.models[0].ratings.coding.rating = 'unproven';
    assert.equal(validate(softened, schema).valid, false,
      'the schema accepted an `unproven` rating that still cites sources, so the two shapes are not actually distinct');
  });

  test('⛔ the JSON and the rendered document name the same models, in both directions', () => {
    const ids = register().models.map((m) => m.id);
    const md = src(REG_MD);
    assert.ok(ids.length >= 10, `the register holds only ${ids.length} models — too few for this fence to be checking a document`);

    assert.deepEqual(headingIds(md), ids,
      "capability-register.md's per-model sections and capability-register.json disagree about which models exist, or about their order");
    assert.deepEqual(matrixIds(md), ids,
      "capability-register.md's at-a-glance matrix and capability-register.json disagree about which models exist, or about their order");

    /*
     * ⛔ AND THE COMPARISON IS EXERCISED, NOT ASSUMED. Both assertions above pass on a document that
     * agrees today; neither shows that the comparison would NOTICE a disagreement. So the same
     * deepEqual is run against a mutated side and required to throw, once per direction — a
     * `notDeepEqual` against an invented id would have been a check that cannot fail.
     */
    const grown = [...ids, 'model-nobody-rendered'];
    assert.throws(() => assert.deepEqual(headingIds(md), grown), assert.AssertionError,
      'a model added to the register and not to the rendered document did not fail this fence\'s own comparison');
    assert.throws(() => assert.deepEqual(matrixIds(md), grown), assert.AssertionError,
      'a model added to the register and not to the matrix did not fail this fence\'s own comparison');

    // And the reverse: a document section with no entry behind it must not read as agreement.
    const withStray = md.replace(/^(### .+ · `[^`]+`\s*)$/m, '### Stray Model · `stray-model`\n$1');
    assert.notEqual(withStray, md, 'the stray-section mutation matched nothing, so the direction below is untested');
    assert.throws(() => assert.deepEqual(headingIds(withStray), ids), assert.AssertionError,
      'a model section added to the rendered document did not fail this fence\'s own comparison, so the fence is not reading the document');
  });

  test('the register, the schema and the rendered document agree on the task-class vocabulary', () => {
    const doc = register();
    const schema = schemaOf(family().schema);
    const enumerated = schema.$defs.taskClass.enum;
    assert.deepEqual([...doc.taskClasses], enumerated,
      'the register declares a different task-class list than its schema enumerates');
    assert.deepEqual(Object.keys(schema.properties.models.items.properties.ratings.properties), enumerated,
      "the schema's ratings object and its task-class enum name different classes, so a class could be required and unratable");
    assert.deepEqual([...schema.properties.models.items.properties.ratings.required].sort(), [...enumerated].sort(),
      'a task class is declared and not required, so a model could omit it and still read as covered');
    for (const m of doc.models) {
      assert.deepEqual(Object.keys(m.ratings).sort(), [...enumerated].sort(), `${m.id} does not carry a verdict for every task class`);
    }
    // The rendered document has to name every class too, or a reader gets a partial register.
    const md = src(REG_MD);
    for (const cls of enumerated) assert.ok(md.includes(`### ${cls}`), `capability-register.md has no section for the task class "${cls}"`);
  });

  test('every family names a prompting standard that exists, and the general fallback is there', () => {
    const doc = register();
    for (const f of doc.families) {
      const rel = f.promptingPractice.replace(/^docs\/reference\//, 'spine/reference/');
      assert.ok(fs.existsSync(path.join(ROOT, rel)), `family ${f.id} names a prompting standard with no file behind it: ${f.promptingPractice} (${rel})`);
    }
    assert.ok(fs.existsSync(path.join(ROOT, 'spine', 'reference', 'models', 'prompting-general.md')),
      'the general prompting fallback is gone, so a model no family profiles has nothing to fall back to');
    assert.match(src('spine/reference/models/prompting-general.md'), /fallback/i,
      'the general prompting standard no longer says it is the fallback');
    /*
     * ⛔ THE FILENAMES ARE LOAD-BEARING. counts-fence.test.mjs derives the standards count from
     * spine/reference/*-standards.md, so a prompting file named that way would silently move a number
     * that four documents state in prose.
     */
    for (const rel of PROMPTING) {
      assert.doesNotMatch(rel, /-standards\.md$/, `${rel} is named like a counted standard, which would move the standards count in four documents`);
      const lines = src(rel).split(/\r?\n/).length;
      assert.ok(lines < 120, `${rel} is ${lines} lines; a prompting standard nobody finishes reading is guidance nobody follows`);
    }
  });

  test('⛔ no credential and no private identifier is in anything this task ships', () => {
    /*
     * The HIGH-severity set is read out of hooks/secret-scan.js rather than retyped: a second copy that
     * agrees today is a coincidence with no mechanism holding it true tomorrow, and the runtime guard is
     * the one that decides what a secret looks like.
     */
    const block = /const PATTERNS = \[\n([\s\S]*?)\n\];/.exec(src('hooks/secret-scan.js'));
    assert.ok(block, "hooks/secret-scan.js's PATTERNS table could not be parsed, so this check is running on nothing");
    const high = [...block[1].matchAll(/^\s*\{\s*re:\s*\/(.+)\/([gimsuy]*),\s*sev:\s*'HIGH',\s*name:\s*'([^']+)'/gm)]
      .map((m) => ({ re: new RegExp(m[1], m[2]), name: m[3] }));
    assert.ok(high.length >= 7, `only ${high.length} HIGH-severity patterns were extracted from the guard — the table's shape has changed and this check is weaker than it reads`);

    const hits = [];
    for (const rel of SHIPPED) {
      assert.ok(fs.existsSync(path.join(ROOT, rel)), `${rel} does not exist, so this check is guarding a file that is not there`);
      const text = src(rel);
      for (const p of high) if (p.re.test(text)) hits.push(`${rel}: ${p.name}`);
      // The one credential-shaped field is a variable NAME, and a name is all it may ever be.
      for (const m of text.matchAll(/"envVar":\s*"([^"]*)"/g)) {
        assert.match(m[1], /^[A-Z][A-Z0-9_]{2,63}$/, `${rel} carries an envVar that is not a variable name: ${JSON.stringify(m[1])}`);
      }
    }
    assert.deepEqual(hits, [], `a HIGH-severity secret pattern matches content this task ships:\n  ${hits.join('\n  ')}`);
  });

  test("release/build-public.sh's own private-identifier patterns find nothing in what this task ships", (t) => {
    const BUILD_SH = 'release/build-public.sh';
    if (!fs.existsSync(path.join(ROOT, BUILD_SH))) {
      t.skip('release/build-public.sh is the build tooling itself and is absent from the published package');
      return;
    }
    const sh = src(BUILD_SH);
    /** Each pattern parsed out of the script, so a codename added there is enforced here the same day. */
    const named = (varName, flags) => {
      const m = new RegExp(`^${varName}='([^']*)'`, 'm').exec(sh);
      assert.ok(m, `${BUILD_SH} no longer declares ${varName}, so this check is running on nothing`);
      return new RegExp(m[1], flags);
    };
    const checks = [
      ['private project identifier', named('PRIVATE_IDENTIFIERS', '')],
      ['account name', named('PRIVATE_ACCOUNT_NAME', 'i')],
      ['home-directory path', named('ACCOUNT_NAME_RE', '')],
    ];
    const hits = [];
    for (const rel of SHIPPED) {
      const text = src(rel);
      for (const [label, re] of checks) if (re.test(text)) hits.push(`${rel}: ${label}`);
    }
    assert.deepEqual(hits, [], `the public build's own checks would fail on content this task ships:\n  ${hits.join('\n  ')}`);
  });
});

// ---------------------------------------------------------------------------------------------
/*
 * ⛔ P4-M-2 — core/policy/routing.js's TASK_CLASSES IS THE REGISTER SCHEMA'S taskClass ENUM, EXACTLY.
 *
 * routing.js declares its own literal copy of the eight-class vocabulary rather than requiring a schema
 * file from core/ — core/ requires nothing from schemas/, hooks/ or kernel/ (anti-drift item 36), and
 * routing.js's own banner says so. A copy that merely agrees today is the exact hazard
 * install/_sources.js's own header describes for KERNEL_FILES before that pair was fenced: no mechanism
 * holds two independent lists equal tomorrow, so a class added to one and not the other would route (or
 * refuse to route) on a vocabulary the register cannot answer, or leave the register naming a class the
 * router can never be asked for. So the two are compared here, in both directions, and — as this file's
 * own header requires of every fence in it — the comparison is exercised on a mutated copy of each side
 * before it is trusted, rather than assumed to discriminate because it agrees on the unmodified pair.
 */
describe('⛔ P4-M-2 — core/policy/routing.js TASK_CLASSES agrees with the register schema, both ways', () => {
  test('the two enums are equal, and the comparison is exercised on a mutated copy of each side', () => {
    const schema = schemaOf('capability-register.schema.json');
    const enumerated = schema.$defs.taskClass.enum;
    const mod = require_(path.join(ROOT, 'core', 'policy', 'routing.js'));

    assert.ok(Array.isArray(mod.TASK_CLASSES) && mod.TASK_CLASSES.length === 8,
      'core/policy/routing.js does not export an eight-entry TASK_CLASSES');
    assert.deepEqual(mod.TASK_CLASSES, enumerated,
      "core/policy/routing.js's TASK_CLASSES disagrees with schemas/capability-register.schema.json's taskClass enum, in order or in content");

    // Exercised, not assumed: a class added to either side alone must make this exact comparison fail —
    // once per direction, or a silent drift in that direction would pass this fence forever.
    assert.throws(() => assert.deepEqual(mod.TASK_CLASSES, [...enumerated, 'summarizing']), assert.AssertionError,
      "a class added to the schema enum and not to TASK_CLASSES did not fail this fence's own comparison");
    assert.throws(() => assert.deepEqual([...mod.TASK_CLASSES, 'summarizing'], enumerated), assert.AssertionError,
      "a class added to TASK_CLASSES and not to the schema enum did not fail this fence's own comparison");
  });
});

/*
 * ⛔ P4-M-3 · THE PROVIDER BLOCK, AND THE ONE FIELD THAT IS REFUSED BY NAME.
 *
 * `providers` declares how this project reaches a model over the OpenAI chat-completions protocol: a
 * base URL, the NAME of the environment variable holding the credential, and a model list. Anti-drift
 * item 52 is what the schema is defending — the key is read from the environment at call time and never
 * written, so the one place a value could realistically end up in a tracked file is a founder writing
 * `"apiKey"` into this block because that is what every other tool's config wants. That property is
 * REFUSED BY NAME rather than merely being unrecognised, and the first test below asserts the rejection
 * comes from that clause and not from `additionalProperties` catching it as a typo: the two produce
 * different errors, and only one of them survives a future widening of the flag.
 *
 * The other four are the block's shape, each with its own reason, for the same argument the posture and
 * exception describes above make: the sweep that rejects every `invalid-*` fixture cannot tell a fixture
 * rejected for its own constraint from one rejected because something unrelated in it broke.
 *
 * The positive control is in the same describe on purpose. The top level of this file is
 * `additionalProperties: true`, so a schema that simply failed to describe `providers` would accept
 * every one of these documents, including the one carrying a key value.
 */
describe('the providers key (P4-M-3) · a value is refused where the variable NAME belongs', () => {
  const SCHEMA = schemaOf('project-config.schema.json');
  const FIX = path.join(SCHEMA_DIR, 'fixtures', 'project-config');
  const errorsFor = (file) => validate(readJSON(path.join(FIX, file)), SCHEMA).errors.join(' | ');

  test('a well-formed provider block VALIDATES — the constraints below are not a schema that rejects everything', () => {
    const valid = readJSON(path.join(FIX, 'valid.json'));
    const entries = Object.entries(valid.providers || {});
    assert.equal(entries.length >= 1, true,
      'the valid project-config fixture no longer carries a providers block, so the five negatives below are derived from a seed that never exercised the key');
    for (const [name, block] of entries) {
      assert.equal(block.protocol, 'openai-compatible', `the seed's provider "${name}" no longer declares the protocol the negatives mutate`);
      assert.match(block.apiKeyEnv, /^[A-Z][A-Z0-9_]*$/, `the seed's provider "${name}" must carry an environment variable NAME`);
      assert.equal(Array.isArray(block.models) && block.models.length > 0, true, `the seed's provider "${name}" must declare at least one model id`);
    }
    const r = validate(valid, SCHEMA);
    assert.equal(r.valid, true, `the valid fixture's providers must validate:\n  ${r.errors.join('\n  ')}`);
  });

  test('⛔ a key VALUE is refused BY NAME, not merely as an unrecognised field', () => {
    const e = errorsFor('invalid-provider-key-value.json');
    assert.match(e, /providers\.minimax\/<key "apiKey">/,
      `the rejection must name the property it refused, and must come from the propertyNames clause that refuses it by name: ${e}`);
    assert.match(e, /matched a schema it must not match/,
      `the refusal must be the deliberate \`not\` clause — an "unknown property" error alone would disappear the day additionalProperties is widened: ${e}`);
  });

  test('⛔ every name a key value would be written under is refused, not just the one the fixture uses', () => {
    /*
     * The fixture proves `apiKey`. The other four are the same mistake spelled differently, and a
     * schema that refused only the one spelling the fixture happens to use would be a fence around a
     * single typo rather than around the class. Built from the valid fixture so this cannot pass on a
     * document that was already invalid for some other reason.
     */
    const base = readJSON(path.join(FIX, 'valid.json'));
    for (const field of ['apiKey', 'api_key', 'key', 'token', 'secret']) {
      const doc = JSON.parse(JSON.stringify(base));
      doc.providers.minimax[field] = 'REFUSED: a value never belongs in a tracked config';
      const r = validate(doc, SCHEMA);
      assert.equal(r.valid, false, `a provider block carrying "${field}" must be refused`);
      assert.match(r.errors.join(' | '), new RegExp(`<key "${field}">: matched a schema it must not match`),
        `"${field}" must be refused by the propertyNames clause, by name: ${r.errors.join(' | ')}`);
    }
  });

  test('a plaintext base URL is refused by the https pattern, because a credential travels on that connection', () => {
    const e = errorsFor('invalid-provider-base-url-not-https.json');
    assert.match(e, /providers\.minimax\.baseUrl/, `the rejection must name baseUrl: ${e}`);
    assert.match(e, /does not match/, `the rejection must come from the https pattern: ${e}`);
  });

  test('an empty model list is refused, because a provider with no models is one nothing can route to', () => {
    const e = errorsFor('invalid-provider-empty-models.json');
    assert.match(e, /providers\.minimax\.models/, `the rejection must name models: ${e}`);
    assert.match(e, /minItems 1/, `the rejection must come from minItems rather than from something unrelated: ${e}`);
  });

  test('a lowercase apiKeyEnv is refused, which is also the shape a pasted VALUE would have', () => {
    const e = errorsFor('invalid-provider-env-name-lowercase.json');
    assert.match(e, /providers\.minimax\.apiKeyEnv/, `the rejection must name apiKeyEnv: ${e}`);
    assert.match(e, /does not match/, `the rejection must come from the environment-variable-name pattern: ${e}`);
  });

  test('a protocol with no adapter is refused by the enum, and the rejection names the protocol that exists', () => {
    const e = errorsFor('invalid-provider-unknown-protocol.json');
    assert.match(e, /providers\.minimax\.protocol/, `the rejection must name protocol: ${e}`);
    assert.match(e, /openai-compatible/, `the rejection must name the protocol a founder can write: ${e}`);
  });

  /*
   * ⛔ AND THE PROTOCOL NAME AND THE ENV-NAME RULE COME FROM THE CLIENT, NOT FROM A SECOND COPY.
   * `adapters/openai-compatible/client.js` refuses the same configuration at construction time that
   * this schema refuses at declaration time. Two hand-written rules that agree today are a coincidence
   * with no mechanism holding them true tomorrow, so they are compared.
   */
  test('⛔ the schema declares exactly the protocol and the env-name rule the client enforces', () => {
    const client = createRequire(import.meta.url)(path.join(ROOT, 'adapters', 'openai-compatible', 'client.js'));
    const block = SCHEMA.properties.providers.additionalProperties;
    assert.deepEqual(block.properties.protocol.enum, [client.PROTOCOL],
      'the schema and the client disagree about which protocol this adapter speaks');
    assert.equal(block.properties.apiKeyEnv.pattern, client.ENV_NAME_RE.source,
      'the schema and the client disagree about what an environment variable NAME looks like, so one would accept a declaration the other refuses');
    assert.deepEqual(block.propertyNames.not.enum, ['apiKey', 'api_key', 'key', 'token', 'secret'],
      'the refused-name list moved — it is named in adapters/openai-compatible/README.md as part of what the client refuses, so re-aim both rather than only this one');
  });
});

// ---------------------------------------------------------------------------------------------
/*
 * ⛔ P4-M-5 — schemas/tasks.schema.json's taskClass IS core/policy/routing.js's TASK_CLASSES TOO, THE
 * SAME DISCIPLINE P4-M-2 ALREADY KEEPS ONE LEVEL UP. The queue row's `taskClass` is a second, independent
 * copy of the eight-class vocabulary (tasks.schema.json has its own $id and this validator's $ref is
 * local-only — schemas/validate.mjs "supported: ... $ref(local)" — so it cannot point at another
 * schema file's $defs). A class added to routing.js and not to this schema would let a planner declare a
 * row route() can answer that the queue reader refuses outright, and the reverse would let a row
 * validate against a class the runner's own `core.routing.TASK_CLASSES.includes()` check in
 * `validateTaskQueue` can never match — both silent until a row actually used the class.
 */
describe('⛔ P4-M-5 — schemas/tasks.schema.json TASK_CLASS agrees with core/policy/routing.js TASK_CLASSES, both ways', () => {
  test('the two enums are equal, and the comparison is exercised on a mutated copy of each side', () => {
    const schema = schemaOf('tasks.schema.json');
    const enumerated = schema.$defs.task.properties.taskClass.enum;
    const mod = require_(path.join(ROOT, 'core', 'policy', 'routing.js'));

    assert.ok(Array.isArray(enumerated) && enumerated.length === 8,
      'schemas/tasks.schema.json does not declare an eight-entry taskClass enum');
    assert.deepEqual(mod.TASK_CLASSES, enumerated,
      "core/policy/routing.js's TASK_CLASSES disagrees with schemas/tasks.schema.json's taskClass enum, in order or in content");

    // Exercised, not assumed — the same proof-of-discrimination shape the P4-M-2 fence above uses.
    assert.throws(() => assert.deepEqual(mod.TASK_CLASSES, [...enumerated, 'summarizing']), assert.AssertionError,
      "a class added to the schema enum and not to TASK_CLASSES did not fail this fence's own comparison");
    assert.throws(() => assert.deepEqual([...mod.TASK_CLASSES, 'summarizing'], enumerated), assert.AssertionError,
      "a class added to TASK_CLASSES and not to the schema enum did not fail this fence's own comparison");
  });

  test('runner.js validateTaskQueue reads the vocabulary from the SAME module, never a second hand-typed copy', () => {
    const runnerSrc = src('adapters/claude-code/task-runner/runner.js');
    assert.match(runnerSrc, /core\.routing\.TASK_CLASSES\.includes\(t\.taskClass\)/,
      'validateTaskQueue no longer reads the taskClass vocabulary from core.routing.TASK_CLASSES — a hand-typed copy could drift from the router it protects');
  });
});
