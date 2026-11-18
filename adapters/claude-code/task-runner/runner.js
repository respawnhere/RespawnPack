#!/usr/bin/env node
/*
 * RespawnPack · adapters/claude-code/task-runner/runner.js — read the queue, refuse on a stale
 * projection, run ONE fresh session, then decide what it achieved OUT OF BAND.
 *
 * ⛔ WHAT A SUCCESSFUL EXIT FROM THIS FILE MEANS, AND WHAT IT DOES NOT. Exit 0 says exactly two
 * things: EVERY GATE THIS RUNNER RAN PASSED, and THE KERNEL HOLDS AN ATTESTATION FOR EVERY RECORDED
 * ACCEPTANCE CRITERION. It does not say a criterion was verified. Nothing here can evaluate prose, so
 * every criterion is recorded with the evaluation CANNOT_DETERMINE and, separately, as attested or
 * not — an attestation is a claim the closing caller made under the kernel's own refusal (`contract
 * complete --met` will not close a partial one), and printing it as proof would manufacture exactly
 * the evidence this pack exists to refuse. The summary says which half is which on every run.
 *
 * ⛔ AND THE SESSION'S OWN WORD IS NEVER THE PROOF. This runner does not read the assistant's text
 * looking for "done"; a transcript full of "all acceptance criteria met" changes nothing here,
 * because completion is decided from the runner's own gate results plus the kernel's attestation
 * record and from nothing else. It never treats a timeout, an exit code, or elapsed wall time as a
 * completion signal (`core/lifecycle/evidence.js` FORBIDDEN_PROOF_TOKENS, anti-drift item 38). The
 * only facts it derives from the stream are the ones stream.js observes structurally: the new
 * session's id, and whether the host said it could not authenticate.
 *
 * ⛔ AND "COULD NOT RUN" NEVER COLLAPSES INTO "FAILED" (anti-drift item 2). A gate whose command does
 * not exist, whose deadline passed, or whose process could not be started is CANNOT_DETERMINE at exit
 * 2 — not FAIL at exit 1. The two get different repairs: a FAIL sends someone to the code, a
 * CANNOT_DETERMINE sends them to the toolchain, and answering the second with the first is how a
 * missing binary becomes a re-planned task.
 *
 * ⛔ IT REFUSES TO START FROM A STALE PROJECTION. A fresh session is composed from generated state; a
 * fresh session composed from a state that no longer describes the tree is a confident wrong answer,
 * which is the failure this pack was written about. Freshness is decided FIRST, before the queue is
 * read, before a contract is recorded, and before any process is spawned — so a refusal writes
 * nothing at all under `.respawnpack/runtime/tasks/`.
 *
 * ⭐ WHAT THIS BUILDS ON, AND WHY NOTHING IS REBUILT BESIDE IT.
 *
 *   · `../sdk-supervisor/cli.js` — `resolveExecutable`, the exact argv (`buildTurnArgs`), and
 *     `runTurn`, which puts the prompt on STDIN because a Windows argv dies at ~32767 characters and
 *     a task record is long. OMITTING `sessionId` is already how a fresh session starts; this file
 *     therefore passes no `sessionId` and never `--resume`.
 *   · `../sdk-supervisor/stream.js` — `observe`, `sessionIdOf`, and `detectAuth`, which already
 *     classifies an unauthenticated host from four places in the stream.
 *   · `canary.js`'s rule, verbatim in effect: an unauthenticated host is CANNOT_DETERMINE with the
 *     host's own words and one owner action, NEVER a FAIL. "Could not run" and "ran and failed" are
 *     different facts, and a task marked FAIL gets re-planned when it should be re-authenticated.
 *   · `core/policy/failures.js` — the four outcomes and the 0/1/2 exit map. No new vocabulary.
 *   · `hooks/_runtime.js` `readDurableState` — the SAME revision-chain + compiler-input-digest
 *     freshness `status` and the SessionStart hook both ask through `hooks/_manifest.js`. The refusal
 *     this file prints reproduces `status`'s own three lines; `runner.test.mjs` asserts those strings
 *     are still present in `kernel/respawnpack.js`'s `cmdStatus`, so the claim "the same words" is
 *     checked against the tree rather than asserted in a comment.
 *   · `core/state/handoff.js` — the write-once document plus sibling verification receipt
 *     `hooks/precompact-ledger-nudge.js` already writes at PreCompact. The next reader of an
 *     incomplete task reads THAT, not a format invented here.
 *   · `core/_io.js` `createExclusive` — `fs.openSync(path, 'wx')`, the same portable compare-and-swap
 *     `core/lifecycle/consumable.js` is built on (anti-drift item 40). The receipt is a RECORD rather
 *     than a consumption claim, so it uses the primitive directly instead of writing a
 *     `consumption-receipt` shaped document for a subject nobody consumes.
 *
 * ⭐ WHY hooks/_runtime.js IS REQUIRED ACROSS THE TREE AND THE KERNEL IS NOT. `adapters/` is
 * pack-repo-only today (`install/_sources.js` copies `adapters/claude-code/interactive` and nothing
 * else), so this file always resolves `../../../hooks/` and `../../../core/`. The kernel is a
 * different case on purpose: `contract delegate` and `savepoint --verify` are VERBS with their own
 * refusals, their own runtime pointers and their own exit-code mapping, and reaching into
 * `kernel/lib/closeout.js` to record a contract would be a second, differently-interpreted writer of
 * `.respawnpack/runtime/contract.json`. So the kernel is invoked as a CHILD PROCESS, the way
 * `ops/release-smoke.mjs` invokes it, and the verb's own exit code is what this file believes. The
 * one consequence to know: the Windows batch-shim spawn below is a deliberate second copy of the
 * technique `kernel/lib/gate.js` proves, for the same reason — `runner.test.mjs` fences that the
 * original is still there so the copy stays traceable to it.
 *
 * ⛔ NEVER `--bare`. It skips hooks, CLAUDE.md discovery and auto-memory, which ARE the anti-drift
 * core (the CLI facts note). ⛔ AND NEVER `--dangerously-skip-permissions` BY DEFAULT: the opt-in below is
 * off unless the owner passes it, and `assertArgvIsSafe` refuses to spawn if either flag reaches the
 * argv by any other route.
 *
 * ⛔ AND THE TOOL ALLOW LIST TRAVELS ON THE ARGV, NOT IN THE PROJECT'S SETTINGS FILE. The first live
 * run of this runner (the field run of 2026-09-03, defect D3) failed for a reason nobody
 * had declared: the target had never been opened interactively, so the host DISCARDED every
 * `permissions.allow` entry in `.claude/settings.json` and said so only on the child's stderr —
 * "Ignoring 9 permissions.allow entries from .claude/settings.json: this workspace has not been
 * trusted." The session could read but could not Edit or Write the one file in its scope, and it
 * could not see why, because that sentence never enters the JSON stream. `--allowedTools` is not
 * subject to the trust dialog, so the list is composed HERE, from a DECLARED source and never from a
 * guess: the list DERIVED from this project's own posture and projectType (`deriveAllowedTools`
 * below, whose floor is DEFAULT_ALLOWED_TOOLS) when the queue row declares no `tools` of its own,
 * that same derived list NARROWED by the row when it does, with `--allowed-tools` as the owner's
 * explicit override that may widen past the derived list. Either way the composed list is recorded
 * in the report, in the delegation record and in the receipt, along with `derivedFrom` — which
 * posture and projectType it was derived from — so the receipt says what the session was permitted
 * and why, rather than leaving a reader to infer it.
 *
 * ⛔ AND A QUEUE ROW MAY ONLY NARROW WHAT ITS OWN PROJECT DERIVES (P3-I-2, owner decision 21). An
 * entry in a row's `tools` that is not in the list this project's posture and projectType derive is
 * refused here, before anything is spawned — the same position as the freshness refusal — naming the
 * entry and the derived list. Only `--allowed-tools`, typed by the owner on the command line, may
 * widen past what a project derives; a queue row, and so a session's own declared work, cannot.
 *
 * ⛔ AND THE LIST ITSELF IS FENCED REGARDLESS. `assertArgvIsSafe` refuses an entry that grants `Bash`
 * with no program (`Bash`, `Bash(*)`) or that grants a push or a forcing flag, wherever the entry
 * came from — the derivation, the queue row, the command line, or a future caller. This is the floor
 * beneath the derivation too: `deriveAllowedTools` may never add a bare `Bash`, a push or a forcing
 * flag, and a test proves every derived combination still passes this fence.
 *
 * ⛔ AND THE MODEL IS ROUTED, NOT GUESSED (P4-M-5). A queue row may declare `taskClass` (one of
 * `core/policy/routing.js`'s TASK_CLASSES; absent means `coding`). `resolveTaskRoute` reads whichever
 * capability register answers — the target's own installed `docs/reference/models/capability-register.json`,
 * else this pack's own `spine/reference/models/capability-register.json`, else neither, which is a real
 * state and not a fault — and calls `core.routing.route()` with `requiresHooks: true` UNCONDITIONALLY:
 * a task session is always a hook-bearing Claude Code session (anti-drift item 54), so the routed
 * family is always `HOOKED_FAMILY`, whatever the register rates `preferred` elsewhere. The routed model
 * becomes the session's `--model` UNLESS the owner typed `--model` on the command line, in which case
 * the owner's choice runs and the report and receipt both say the route was overridden and by what.
 * `--dry-run` prints the route beside the tool derivation.
 *
 * Usage:
 *   node adapters/claude-code/task-runner/runner.js --dir <project> [options]
 *
 *   --dir <path>          the project whose queue is read and whose session is run
 *                         (default: CLAUDE_PROJECT_DIR, then cwd — the kernel's own default)
 *   --task <id>           run this row instead of the first ready one; it must still be ready and
 *                         its dependsOn must still all be done
 *   --dry-run             compose the prompt, print it, and spawn NOTHING (no contract either)
 *   --model <name>        --model for the session, overriding the row's own routed model (P4-M-5)
 *   --allowed-tools <a,b> the session's --allowedTools, overriding the queue row's `tools` and the
 *                         list derived from posture/projectType — the one source that may WIDEN past
 *                         it; every entry is still fenced
 *   --permission-mode <m> --permission-mode for the session
 *   --timeout <ms>        deadline for the one turn (default: cli.js's DEFAULT_TIMEOUT_MS)
 *   --kernel <path>       the respawnpack.js to invoke (default: the target's installed kernel, then
 *                         this pack's own)
 *   --claude-path <path>  the claude executable (default: RESPAWNPACK_CLAUDE_PATH, then PATH)
 *   --json <file>         write the full report as JSON
 *   --allow-dangerously-skip-permissions
 *                         the owner's own choice, off by default, never set by this runner itself
 *
 * Exit: 0 PASS or NOT_APPLICABLE · 1 FAIL · 2 CANNOT_DETERMINE.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const core = require(path.join(__dirname, '..', '..', '..', 'core', 'index.js'));
const cliLib = require(path.join(__dirname, '..', 'sdk-supervisor', 'cli.js'));
const stream = require(path.join(__dirname, '..', 'sdk-supervisor', 'stream.js'));
const durable = require(path.join(__dirname, '..', '..', '..', 'hooks', '_runtime.js'));
// P3-I-2: the ONE posture resolver (hooks/_posture.js) and the SAME classified config boundary it
// reads through (hooks/_artifact.js) — never a second, raw read of respawnpack.config.json.
const postureLib = require(path.join(__dirname, '..', '..', '..', 'hooks', '_posture.js'));
const artifactReader = require(path.join(__dirname, '..', '..', '..', 'hooks', '_artifact.js'));

const { OUTCOME, exitCodeFor, rollup } = core.failures;
const io = core.io;

// Written with forward slashes because they are QUOTED IN PROSE — the registry, the schema and this
// package's README all name them that way, and a reader who greps for one of these strings should
// find the same characters on every platform. `path.join(dir, ...split)` opens them.
const QUEUE_REL = 'docs/derived/state/tasks.json';
const STATE_REL = 'docs/derived/STATE.json';
const RUNTIME_TASKS_REL = '.respawnpack/runtime/tasks';
const CONTRACT_REL = '.respawnpack/runtime/contract.json';
const DELEGATIONS_REL = '.respawnpack/runtime/delegations.json';
const CONFIG_REL = 'respawnpack.config.json';
const RUNTIME_REL = '.respawnpack/runtime';
const atRel = (dir, rel) => path.join(dir, ...rel.split('/'));

/*
 * The receipt's own version and kind. Owned HERE, not by the kernel: this is an adapter's record, and
 * pinning it to `kernel/lib/state.js` SCHEMA_VERSION — the number for the docs/derived/* documents the
 * compiler writes — would make an unrelated kernel bump silently re-version every task receipt.
 * `kernel/schema.test.mjs` names this constant as the family's version authority for that reason.
 */
const TASK_ATTEMPT_SCHEMA_VERSION = '1.0.0';
const TASK_ATTEMPT_KIND = 'respawnpack-task-attempt';

/** The same ceiling `kernel/lib/gate.js` defaultExec applies to a project check. */
const GATE_TIMEOUT_MS = 900000;

/** The one flag pair that must never reach a task session's argv. */
const FORBIDDEN_ARGS = ['--bare', '--dangerously-skip-permissions'];

/*
 * ⛔ THE FLOOR, DECLARED IN EXACTLY ONE PLACE. Every derivation below (`deriveAllowedTools`) starts
 * from exactly this list and only ever adds to it; an undeclared posture and an undeclared or
 * unrecognised projectType add nothing, so a project that declares neither derives THIS list byte for
 * byte — the migration guarantee P3-I-2 keeps, checked as a fence rather than promised in prose.
 *
 * The flag is `--allowedTools` (also spelled `--allowed-tools`), whose own help reads "Comma or
 * space-separated list of tool names to allow (e.g. \"Bash(git *) Edit\")" on claude 2.1.259. It takes
 * the SAME permission-rule syntax as `permissions.allow` in a settings file, which is why the entries
 * below look like settings entries; the difference is only that the trust dialog does not gate them.
 * `cli.js` buildTurnArgs joins them with commas.
 *
 * What is in it, and why each entry is the narrowest form that still lets a task session do its job:
 *
 *   · Read, Edit, Write — a task session that cannot edit the one file in its scope is the D3 failure
 *     itself. These are the pack's own editing surface and nothing more.
 *   · Bash(node .claude/respawnpack/respawnpack.js contract *) — the composed prompt instructs the
 *     session to attest with `contract complete --met`, and an instruction the session cannot carry
 *     out is an instruction that produces an unattested run for no reason. Scoped to the `contract`
 *     verb of the TARGET's installed kernel: not the whole kernel, and not the whole of node.
 *   · Bash(git status), Bash(git diff *), Bash(git log *) — read-only git, the same three reads a
 *     fresh install already puts in `.claude/settings.json`, so a session can see what it changed.
 *
 * ⛔ AND WHAT IS DELIBERATELY NOT IN IT. No push, no `git commit`, no reset/clean/checkout, no package
 * install, no bare `Bash` and no `Bash(*)`. A task session earns its verdict from the runner's own
 * out-of-band gates, so nothing it could do to the remote, to the index or to node_modules would make
 * that verdict truer, and every one of those is a change nobody declared. A task that genuinely needs
 * more says so in its queue row's `tools`, where a reader can see the widening and the fence below
 * still applies to it.
 */
const DEFAULT_ALLOWED_TOOLS = Object.freeze([
  'Read',
  'Edit',
  'Write',
  'Bash(node .claude/respawnpack/respawnpack.js contract *)',
  'Bash(git status)',
  'Bash(git diff *)',
  'Bash(git log *)',
]);

/** The host's own sentence when a workspace has never accepted the trust dialog (D3). */
const TRUST_REFUSAL_PHRASE = 'has not been trusted';

/*
 * ⛔ P3-I-2 · THE DERIVATION VOCABULARY, DECLARED WHERE THE FLOOR IS. Class B, "intent over mechanics"
 * (the class audit): a task session's tools derive from the project's
 * DECLARED posture and projectType, with safe defaults, rather than from one fixed list every project
 * gets regardless of shape. Each addition below is the narrowest read-only-or-already-scoped set that
 * posture or projectType earns; none of them grants a bare `Bash`, a push or a forcing flag, and
 * `runner.test.mjs` proves every combination still passes `assertArgvIsSafe`.
 */

/** The four `projectType` values `install/install.js`'s `PROJECT_TYPE_DROPS` declares — fenced
 * against that source, both directions, by `runner.test.mjs`, the same discipline
 * `ops/_project-fixtures.mjs`'s `KINDS` already carries for the fixture side of this vocabulary. */
const KNOWN_PROJECT_TYPES = Object.freeze(['docs-only', 'ops-infra', 'greenfield-app', 'mature-product']);

/** What posture `light` adds on top of the floor: the two writes a task session doing real work under
 * a relaxed posture needs and nothing else. `standard` and `strict` add nothing here — the posture
 * scale this pack uses elsewhere is about rigidity, not about widening what a session may run. */
const LIGHT_POSTURE_ADDITIONS = Object.freeze(['Bash(git add *)', 'Bash(git commit *)']);

/** What projectType `ops-infra` adds: read-only validators for the toolchains that archetype
 * declares (the same vocabulary Class E's gate presets read). */
const OPS_INFRA_ADDITIONS = Object.freeze(['Bash(terraform validate)', 'Bash(terraform fmt *)', 'Bash(ansible-lint *)', 'Bash(shellcheck *)']);

/** What projectType `greenfield-app` and `mature-product` add: the three scripts a Node project's own
 * package.json already promises. `docs-only` adds nothing — there is no toolchain to run. */
const NODE_APP_ADDITIONS = Object.freeze(['Bash(npm test)', 'Bash(npm run lint)', 'Bash(npm run build)']);

/*
 * ⛔ P4-M-5 · THE ROUTE, AND WHY requiresHooks IS NEVER OPTIONAL HERE. A task session IS a Claude Code
 * session carrying the pack's hooks — there is no other kind this runner ever starts (anti-drift item
 * 54) — so every call this file makes into `core.routing.route()` passes `requiresHooks: true`,
 * unconditionally, which restricts the candidate family to `core.routing.HOOKED_FAMILY` before ranking
 * is even considered. `available` below reports only what this runner actually KNOWS: it IS running as
 * the hooked family right now (there is no probe to run — the fact is this runner's own existence), and
 * it reports nothing about openai or minimax, which `route()`'s own `skippedFamilies()` reads honestly
 * as "no availability was reported" rather than as a guess this file never checked. Since
 * `requiresHooks: true` restricts the pool before `available` is even consulted for the other families,
 * that honesty costs nothing here.
 */
const TASK_SESSION_AVAILABILITY = Object.freeze({
  anthropic: { ok: true, why: 'this runner IS a Claude Code task session; the hooked family is running by definition, not by probe' },
});

/** The class a row routes as when it declares no `taskClass` of its own. */
const DEFAULT_TASK_CLASS = 'coding';

/*
 * ⛔ `status`'S OWN REFUSAL, REPRODUCED SO A READER OF ONE HAS READ THE OTHER. These three strings
 * are asserted against `kernel/respawnpack.js`'s `cmdStatus` by `runner.test.mjs`, because a runner
 * that refuses in different words than the verb an operator would run next teaches them that the two
 * disagree.
 */
const WITHHELD_LINE = '  rows      : WITHHELD · blocked: WITHHELD · next: WITHHELD';
const REGENERATE_LINE = '  Regenerate with `savepoint` (or `state compile`), then re-run status.';
const stateWarnLine = (label, detail) => `  ⚠️ state  : ${label} — ${detail}`;

// =================================================================================================
// the task queue
// =================================================================================================

const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const arrayOfStrings = (v) => Array.isArray(v) && v.every((s) => typeof s === 'string');
const reject = (reason) => ({ ok: false, reason });
const ACCEPT = { ok: true, reason: null };

const TASK_STATES = new Set(['proposed', 'ready', 'in-progress', 'blocked', 'done', 'abandoned']);

/**
 * Accept or refuse `docs/derived/state/tasks.json`, PROCEDURALLY — the way every other authored
 * document in this pack is validated (`hooks/_artifact.js` `validateRequirements`,
 * `validateGoalDoc`), and for the reason `schemas/validate.mjs`'s own header gives: the schemas are
 * normative declarations verified in tests, the procedural loaders are the production validators, and
 * `schemas/` is never installed to a target (anti-drift item 34), so a runtime reader cannot depend
 * on it being there.
 *
 * The rules below are `schemas/tasks.schema.json`'s, field for field, plus the ONE rule that schema
 * says in prose it cannot express: ids are unique. `kernel/schema.test.mjs` checks that same rule
 * directly against the fixtures for exactly the same reason.
 *
 * @returns {{ok:boolean, reason:string|null}}
 */
function validateTaskQueue(doc, artifact = 'tasks.json') {
  if (!isPlainObject(doc)) return reject(`${artifact} is ${Array.isArray(doc) ? 'an array' : typeof doc}, expected a JSON object`);
  if (doc.schemaVersion !== '1.0.0') {
    return reject(`${artifact} declares schemaVersion ${JSON.stringify(doc.schemaVersion)}; this reader implements "1.0.0" only`);
  }
  if (!Array.isArray(doc.tasks)) return reject(`${artifact}: \`tasks\` is ${isPlainObject(doc.tasks) ? 'an object' : typeof doc.tasks}, expected an array`);

  const seen = new Set();
  for (const [i, t] of doc.tasks.entries()) {
    const at = `${artifact}: task ${i}`;
    if (!isPlainObject(t)) return reject(`${at} is ${Array.isArray(t) ? 'an array' : typeof t}, expected an object`);
    for (const f of ['id', 'title', 'specPointer', 'intent', 'risk']) {
      if (typeof t[f] !== 'string' || !t[f].trim()) return reject(`${at} has no non-empty string \`${f}\``);
    }
    if (seen.has(t.id)) {
      return reject(`${artifact}: task id ${JSON.stringify(t.id)} appears more than once. `
        + 'Ids are what dependsOn cites, so a duplicate makes "this task is done" ambiguous.');
    }
    seen.add(t.id);
    if (!TASK_STATES.has(t.state)) return reject(`${artifact}: ${t.id}.state is ${JSON.stringify(t.state)}, expected one of ${[...TASK_STATES].join(' | ')}`);
    if (!Array.isArray(t.acceptance) || !t.acceptance.length || !arrayOfStrings(t.acceptance)) {
      return reject(`${artifact}: ${t.id}.acceptance must be a non-empty array of strings — `
        + 'the same rule `contract delegate --acceptance` enforces: a bounded task with no definition of done is an unbounded one with a shorter description.');
    }
    if (!arrayOfStrings(t.dependsOn)) return reject(`${artifact}: ${t.id}.dependsOn must be an array of strings`);
    if (!isPlainObject(t.scope) || !arrayOfStrings(t.scope.files) || !arrayOfStrings(t.scope.dirs)) {
      return reject(`${artifact}: ${t.id}.scope must be an object with \`files\` and \`dirs\` arrays of strings`);
    }
    if (!isPlainObject(t.gates) || typeof t.gates.savepoint !== 'boolean' || typeof t.gates.gate !== 'boolean') {
      return reject(`${artifact}: ${t.id}.gates must be an object with boolean \`savepoint\` and \`gate\``);
    }
    if (t.gates.only !== undefined && !arrayOfStrings(t.gates.only)) return reject(`${artifact}: ${t.id}.gates.only must be an array of strings`);
    /*
     * ⛔ OPTIONAL, BUT NEVER EMPTY WHEN PRESENT. An absent `tools` means "the list this project's
     * posture and projectType derive" (P3-I-2, `deriveAllowedTools`), which is a real answer. A
     * `tools: []` is a row that says "this session may use no tool at all", which is not something a
     * planner means and which would otherwise fall through to the derived list and quietly grant MORE
     * than the row asked for. Whether a PRESENT list stays inside what this project derives is judged
     * by the runner rather than here, because it needs the derivation, which this procedural validator
     * has no project directory to read; the forbidden-entry floor is applied by the runner for the same
     * reason, and because it applies equally to a list that arrived on the command line.
     */
    if (t.tools !== undefined && (!arrayOfStrings(t.tools) || !t.tools.length)) {
      return reject(`${artifact}: ${t.id}.tools must be a non-empty array of strings when it is present — `
        + 'omit it to take the list this project derives; an empty list is a session that may use no tool at all.');
    }
    /*
     * ⛔ P4-M-5 · REFUSED HERE, BEFORE ANY SESSION EXISTS — the same position `tools` is judged from.
     * An absent `taskClass` is a real answer (DEFAULT_TASK_CLASS applies); a present one that is not in
     * core.routing.TASK_CLASSES is a row naming a class `route()` can never be asked for, which is a
     * queue defect rather than something to route around by guessing. Read from the SAME module the
     * route this row eventually gets comes from — never a second, hand-typed copy of the vocabulary —
     * so this check and the routing it protects can never drift apart.
     */
    if (t.taskClass !== undefined && !core.routing.TASK_CLASSES.includes(t.taskClass)) {
      return reject(`${artifact}: ${t.id}.taskClass is ${JSON.stringify(t.taskClass)}, expected one of `
        + `${core.routing.TASK_CLASSES.join(' | ')} (core/policy/routing.js TASK_CLASSES) or undefined`);
    }
    if (!isPlainObject(t.provenance) || typeof t.provenance.createdBy !== 'string' || typeof t.provenance.createdAt !== 'string') {
      return reject(`${artifact}: ${t.id}.provenance must carry string \`createdBy\` and \`createdAt\``);
    }
  }
  return ACCEPT;
}

/**
 * Read and accept the queue, or say exactly which of the five answers this document produced.
 * @returns {{status:'OK'|'ABSENT'|'UNREADABLE'|'MALFORMED'|'INVALID', doc:any, detail:string|null}}
 */
function loadTaskQueue(dir) {
  const r = io.readJSONClassified(atRel(dir, QUEUE_REL));
  if (r.status !== 'OK') return { status: r.status, doc: null, detail: r.detail ? `${QUEUE_REL}: ${r.detail}` : `${QUEUE_REL}: ${r.status}` };
  const v = validateTaskQueue(r.doc, QUEUE_REL);
  return v.ok ? { status: 'OK', doc: r.doc, detail: null } : { status: 'INVALID', doc: null, detail: v.reason };
}

/**
 * The first row that may actually be started, and WHY each earlier candidate was passed over.
 *
 * "Ready" is two conditions, not one: the row says `ready`, AND every id in `dependsOn` names a row
 * in this same queue whose state is `done`. A dependency naming a row that is not here at all is NOT
 * satisfied — an absent row is an unknown row, and treating unknown as done is precisely the
 * collapse of CANNOT_DETERMINE into PASS this pack refuses everywhere else.
 *
 * @returns {{task:object|null, skipped:Array<{id:string,why:string}>, considered:number, why:string|null}}
 */
function selectTask(doc, { taskId = null } = {}) {
  const tasks = (doc && doc.tasks) || [];
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const unmetOf = (t) => (t.dependsOn || []).filter((d) => {
    const dep = byId.get(d);
    return !dep || dep.state !== 'done';
  });

  if (taskId !== null) {
    const t = byId.get(taskId);
    if (!t) return { task: null, skipped: [], considered: tasks.length, why: `no task in ${QUEUE_REL} has id ${JSON.stringify(taskId)}` };
    if (t.state !== 'ready') return { task: null, skipped: [{ id: t.id, why: `state is "${t.state}", not "ready"` }], considered: tasks.length, why: `task ${t.id} is "${t.state}", not "ready"` };
    const unmet = unmetOf(t);
    if (unmet.length) {
      return {
        task: null,
        skipped: [{ id: t.id, why: `dependsOn not done: ${unmet.join(', ')}` }],
        considered: tasks.length,
        why: `task ${t.id} depends on ${unmet.join(', ')}, which ${unmet.length === 1 ? 'is' : 'are'} not done`,
      };
    }
    return { task: t, skipped: [], considered: tasks.length, why: null };
  }

  const skipped = [];
  for (const t of tasks) {
    if (t.state !== 'ready') { skipped.push({ id: t.id, why: `state is "${t.state}", not "ready"` }); continue; }
    const unmet = unmetOf(t);
    if (unmet.length) { skipped.push({ id: t.id, why: `dependsOn not done: ${unmet.join(', ')}` }); continue; }
    return { task: t, skipped, considered: tasks.length, why: null };
  }
  return { task: null, skipped, considered: tasks.length, why: 'no row in the queue is ready with all of its dependsOn done' };
}

// =================================================================================================
// the prompt
// =================================================================================================

/**
 * The one message the fresh session receives. It carries the TASK RECORD and the pack's own boot
 * instruction, and nothing that could be mistaken for permission to declare itself finished.
 *
 * ⭐ WHAT IT DELIBERATELY DOES NOT CARRY YET. The hooks-and-install audit §6 item 2 also names the STATE facts,
 * the CONTINUITY note and the active contract. Those arrive with P5-T-16c, when
 * `session-routing-nudge.js` learns to STOP injecting its own boot block inside a task session.
 * Composing them here today would double the boot budget against a hook that still injects them, and
 * two copies of the same facts that can disagree is worse than one.
 */
function composePrompt({ task, freshness }) {
  const bullets = (label, xs) => (xs && xs.length ? `${label}\n${xs.map((x) => `  - ${x}`).join('\n')}` : `${label}\n  - (none declared)`);
  return [
    'You are running as ONE fresh RespawnPack task session. Start by booting: run `/respawn` before',
    'anything else, so you read this project from its generated state rather than from assumption.',
    '',
    `The projection you are booting from was verified CURRENT before this session was started (${freshness.detail || freshness.label}).`,
    '',
    '=== TASK RECORD ===',
    `id           : ${task.id}`,
    `title        : ${task.title}`,
    `spec pointer : ${task.specPointer}`,
    `risk         : ${task.risk}`,
    '',
    `intent:\n  ${task.intent}`,
    '',
    bullets('scope — files you may touch:', task.scope.files),
    bullets('scope — directories you may touch:', task.scope.dirs),
    '',
    bullets('acceptance criteria — every one of these must be true before this task is done:', task.acceptance),
    '=== END TASK RECORD ===',
    '',
    'When a criterion is genuinely met, attest it:',
    ...task.acceptance.map((a) => `  node .claude/respawnpack/respawnpack.js contract complete --met ${JSON.stringify(a)}`),
    '',
    '⛔ Your own statement that the work is done is NOT the proof and will not be read as one. The',
    'runner that started you verifies the gates OUT OF BAND, in its own process, after this session',
    'ends. A timeout, an exit code or elapsed time is never a completion signal. If a criterion cannot',
    'be established, say so plainly and leave it unattested — "could not determine" and "failed" are',
    'different facts, and reporting the first as the second is the failure this pack exists to prevent.',
    '',
    'Stay inside the declared scope. If the work needs a file outside it, stop and say which file and why.',
  ].join('\n');
}

// =================================================================================================
// the kernel, as a child process
// =================================================================================================

/**
 * Which `respawnpack.js` speaks for this project: an explicit override, then the TARGET's own
 * installed kernel, then this pack's. A target's installed kernel is preferred because the contract
 * it records is the one that target's own hooks and verbs will read back.
 */
function resolveKernel(dir, kernelPath = null) {
  const candidates = [
    kernelPath,
    path.join(dir, '.claude', 'respawnpack', 'respawnpack.js'),
    path.join(__dirname, '..', '..', '..', 'kernel', 'respawnpack.js'),
  ].filter(Boolean);
  for (const c of candidates) {
    try { if (fs.statSync(c).isFile()) return { ok: true, path: c, searched: candidates }; } catch { /* next */ }
  }
  return { ok: false, path: null, searched: candidates, why: `no respawnpack.js was found. Looked at: ${candidates.join(', ')}` };
}

/**
 * The exact argv for the delegation. PURE and exported, so a test asserts the invocation instead of
 * trusting a comment about it.
 *
 * ⛔ `--acceptance` IS ONE `;`-SEPARATED STRING, WHICH IS THE KERNEL'S SPLIT AND NOT OURS
 * (`kernel/respawnpack.js` `list()`). A criterion containing a semicolon would therefore be recorded
 * as two, and P5-T-16b's "one `--met` per RECORDED criterion" would then need an attestation for a
 * criterion nobody wrote. The caller refuses that case before it reaches here rather than silently
 * changing what the queue said.
 */
function buildContractArgs({ dir, task }) {
  return [
    'contract', 'delegate',
    '--task', task.title,
    '--acceptance', task.acceptance.join(';'),
    '--dir', dir,
    '--json',
  ];
}

/** The real kernel surface. Tests may pass an object of the same shape. */
const realKernel = {
  kind: 'spawn',
  run({ dir, task, kernelPath = null, env = process.env, timeoutMs = 120000 }) {
    const k = resolveKernel(dir, kernelPath);
    if (!k.ok) return { ok: false, code: null, stdout: '', stderr: '', json: null, argv: [], kernelPath: null, why: k.why };
    const args = buildContractArgs({ dir, task });
    const r = spawnSync(process.execPath, [k.path, ...args], { encoding: 'utf8', env, timeout: timeoutMs, windowsHide: true });
    let json = null;
    try { json = JSON.parse(r.stdout); } catch { /* left null; the raw text still travels */ }
    return {
      ok: r.status === 0,
      code: r.status,
      stdout: r.stdout || '',
      stderr: r.stderr || '',
      json,
      argv: [process.execPath, k.path, ...args],
      kernelPath: k.path,
      why: r.status === 0 ? null : `\`contract delegate\` exited ${r.status}`,
    };
  },
};

// =================================================================================================
// the turn
// =================================================================================================

/**
 * PURE. What this project's declared posture and projectType add on top of the floor, and why.
 * Exported so a test can enumerate every combination directly, with no filesystem involved.
 *
 * The floor is `DEFAULT_ALLOWED_TOOLS` byte for byte; `posture === 'light'` adds
 * `LIGHT_POSTURE_ADDITIONS`; `projectType === 'ops-infra'` adds `OPS_INFRA_ADDITIONS`;
 * `'greenfield-app'` and `'mature-product'` add `NODE_APP_ADDITIONS`; `'docs-only'`, an unrecognised
 * value, and `null`/absent all add nothing — so `deriveAllowedTools({})` equals the floor exactly,
 * which is the byte-for-byte migration guarantee for a project that declares neither.
 *
 * @param {{posture?:string|null, projectType?:string|null}} [input]
 * @returns {{list:string[], derivedFrom:{posture:string|null, projectType:string|null}, why:string}}
 */
function deriveAllowedTools({ posture = null, projectType = null } = {}) {
  const list = [...DEFAULT_ALLOWED_TOOLS];
  const notes = [];
  if (posture === 'light') {
    list.push(...LIGHT_POSTURE_ADDITIONS);
    notes.push('posture `light` adds read-write git (add, commit)');
  }
  if (projectType === 'ops-infra') {
    list.push(...OPS_INFRA_ADDITIONS);
    notes.push('projectType `ops-infra` adds the declared validators (terraform validate/fmt, ansible-lint, shellcheck)');
  } else if (projectType === 'greenfield-app' || projectType === 'mature-product') {
    list.push(...NODE_APP_ADDITIONS);
    notes.push(`projectType \`${projectType}\` adds npm test/lint/build`);
  }
  // `docs-only`, an undeclared projectType, and an unrecognised one all read identically ON PURPOSE —
  // resolveToolDerivation below never passes an unrecognised declared value in here (see its own
  // header), so the "unrecognised" and "undeclared" cases collapse to the same, honest "adds nothing".
  return {
    list: Object.freeze(list),
    derivedFrom: { posture, projectType },
    why: notes.length
      ? `the floor (${DEFAULT_ALLOWED_TOOLS.length} entries) plus ${notes.join('; ')}`
      : `the floor only (${DEFAULT_ALLOWED_TOOLS.length} entries) — no posture or projectType addition applies`,
  };
}

/**
 * The I/O half of P3-I-2: read this project's posture through `hooks/_posture.js`'s ONE resolver, read
 * `projectType` through the SAME classified boundary that resolver reads its own config through
 * (`hooks/_artifact.js`, never a raw read), and derive the allow list from what came back.
 *
 * ⛔ AN UNRECOGNISED DECLARED VALUE NEVER REACHES `deriveAllowedTools`. `respawnpack.config.json`
 * declaring `projectType: "banana"` is a real, distinct fact from declaring nothing — `projectType`
 * below carries BOTH the raw `declared` value and the `value` actually used (null for anything not in
 * `KNOWN_PROJECT_TYPES`), so a reader can tell "nobody declared a type" from "somebody declared one
 * this pack does not know" while the DERIVED LIST treats them the same, exactly as install.js's own
 * CLAUDE.md composer refuses to guess at an unknown project type rather than approximating one.
 *
 * ⛔ AN UNREADABLE CONFIG DERIVES THE FLOOR AND SAYS SO. `hooks/_posture.js` already resolves an
 * unreadable or absent config to `strict` and names the reason; `projectType.detail` here names the
 * same fact for the field this file alone is responsible for reading.
 *
 * @returns the shape `deriveAllowedTools` returns, plus `posture:{profile,source,detail}` (from
 *   `hooks/_posture.js`'s own resolution) and `projectType:{value,declared,detail}`.
 */
function resolveToolDerivation(dir) {
  const resolved = postureLib.resolve(dir);
  const cfg = artifactReader.readJSONClassified(atRel(dir, CONFIG_REL));

  let declaredValue = null;
  let value = null;
  let detail;
  if (cfg.status === 'OK' && isPlainObject(cfg.doc) && typeof cfg.doc.projectType === 'string') {
    declaredValue = cfg.doc.projectType;
    if (KNOWN_PROJECT_TYPES.includes(declaredValue)) {
      value = declaredValue;
      detail = `projectType ${JSON.stringify(declaredValue)} is declared in ${CONFIG_REL}`;
    } else {
      detail = `projectType ${JSON.stringify(declaredValue)} is declared in ${CONFIG_REL} but is not one of `
        + `${KNOWN_PROJECT_TYPES.join(', ')} — an unrecognised project type adds nothing`;
    }
  } else if (cfg.status === 'ABSENT') {
    detail = `no ${CONFIG_REL}, so no projectType is declared — no projectType addition applies`;
  } else if (cfg.status === 'OK') {
    detail = `${CONFIG_REL} declares no \`projectType\` — no projectType addition applies`;
  } else {
    detail = `${CONFIG_REL} is ${cfg.status}${cfg.detail ? `: ${cfg.detail}` : ''} — projectType could not be `
      + 'read, so this run derives the floor plus any posture addition only';
  }

  const derived = deriveAllowedTools({ posture: resolved.profile, projectType: value });
  return {
    ...derived,
    posture: { profile: resolved.profile, source: resolved.source, detail: resolved.detail },
    projectType: { value, declared: declaredValue, detail },
  };
}

/**
 * The first entry in a task row's own `tools` that is outside the list this project derives, or null.
 * Meaningful only for a `task-row` source: `option` (the owner's `--allowed-tools`) may widen past the
 * derived list on purpose, and `default` (no row `tools`) IS the derived list, so neither can violate
 * this rule by construction.
 */
function firstUnderivedTool(rowTools, derivedList) {
  const allowed = new Set(derivedList);
  for (const entry of rowTools || []) {
    if (!allowed.has(String(entry))) return String(entry);
  }
  return null;
}

/**
 * Which allow list this session gets, and FROM WHERE — never from a guess.
 *
 * Three declared sources, in the order a reader would expect them to win: the owner typing
 * `--allowed-tools`, then the queue row's own `tools`, then the list this project's posture and
 * projectType DERIVE (`derived`, from `resolveToolDerivation` — P3-I-2). The source travels with the
 * list because "why was this session allowed to Write" is a question the receipt has to be able to
 * answer, and `derivedFrom` travels with it regardless of source, because "what would this project
 * have derived" is worth knowing even when the owner's own override or the row's narrowing decided the
 * effective list. An EMPTY `tools` array is not a source: the queue reader refuses it (a
 * declared-but-empty list is a session that can do nothing, which is not something a planner means),
 * so it can never silently fall through to the default. Whether a `task-row` list is actually a SUBSET
 * of `derived.list` is judged by the caller (`firstUnderivedTool`), not here — this function only
 * composes the list, so a caller that skips the subset check gets exactly what it asked for and no
 * silent narrowing.
 *
 * @returns {{list:string[], source:'option'|'task-row'|'default', why:string, derivedFrom:{posture:string|null, projectType:string|null}}}
 */
function resolveAllowedTools({ task = null, option = null, derived = null } = {}) {
  const derivedList = derived && Array.isArray(derived.list) ? derived.list : DEFAULT_ALLOWED_TOOLS;
  const derivedFrom = derived ? derived.derivedFrom : { posture: null, projectType: null };
  if (Array.isArray(option) && option.length) {
    return {
      list: option.map(String), source: 'option',
      why: '--allowed-tools was passed on the command line — the owner\'s explicit override, which may widen past the derived list',
      derivedFrom,
    };
  }
  if (task && Array.isArray(task.tools) && task.tools.length) {
    return {
      list: task.tools.map(String), source: 'task-row',
      why: `the queue row declares its own \`tools\` (${task.tools.length} entr${task.tools.length === 1 ? 'y' : 'ies'}), narrowing the list derived for this project`,
      derivedFrom,
    };
  }
  return {
    list: derivedList.slice(), source: 'default',
    why: derived ? derived.why : 'no `tools` was declared for this row, so the list derived for this project applies',
    derivedFrom,
  };
}

/*
 * ⛔ THE ENTRIES A TASK SESSION NEVER RECEIVES, WHATEVER DECLARED THEM.
 *
 * Three rules, and each one is a shape that turns a bounded task into an unbounded one:
 *
 *   1. `Bash` with no program, and `Bash(*)` — every shell command there is. A session that may run
 *      anything is a session whose scope is the machine, and the queue row that declared it said
 *      nothing about what it intended to run.
 *   2. a push — the one action this pack refuses hardest everywhere else (push-guard tier 2 is `deny`
 *      in every posture). A task session's work is judged by gates in the runner's own process, so
 *      nothing it sends to a remote can make its verdict truer.
 *   3. a forcing flag (`--force`, or a `-` cluster containing `f`, which is how `rm -rf` and
 *      `checkout -f` get past their own refusals) — the flag whose entire purpose is to skip the
 *      confirmation someone put there.
 *
 * This is a FLOOR, not a sandbox: the host's own permission layer is what actually enforces a rule,
 * and a determined entry can still describe something regrettable. What the floor buys is that the
 * three shapes with no legitimate use in a bounded task cannot arrive by accident.
 *
 * @returns {string|null} why the entry is refused, or null if it is acceptable
 */
function forbiddenToolReason(entry) {
  const raw = String(entry == null ? '' : entry).trim();
  const m = /^Bash\s*(?:\(([\s\S]*)\))?$/i.exec(raw);
  if (!m) return null;                                   // not a Bash grant; nothing here judges Read or Edit
  const body = (m[1] === undefined ? '' : m[1]).trim();
  if (!body || body === '*' || body === ':*') {
    return 'grants Bash with no program named, which is every shell command there is';
  }
  if (/(^|[\s;|&(])push(\s|$|[;|&)])/i.test(body)) {
    return 'grants a push, which this pack refuses in every posture (push-guard tier 2) and which no task verdict depends on';
  }
  if (/--force\b/i.test(body) || /(^|\s)-[a-z]*f[a-z]*(\s|$)/i.test(body)) {
    return 'grants a forcing flag, whose whole purpose is to skip a refusal someone put there';
  }
  return null;
}

/** The first refused entry in a list, with its reason, or null when every entry is acceptable. */
function firstForbiddenTool(list) {
  for (const entry of list || []) {
    const why = forbiddenToolReason(entry);
    if (why) return { entry: String(entry), why };
  }
  return null;
}

/** Every `--allowedTools` / `--allowed-tools` value in a composed argv, split the way cli.js joins it. */
function allowedToolsIn(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] !== '--allowedTools' && argv[i] !== '--allowed-tools') continue;
    for (const part of String(argv[i + 1] === undefined ? '' : argv[i + 1]).split(',')) {
      const t = part.trim();
      if (t) out.push(t);
    }
  }
  return out;
}

// =================================================================================================
// the route (P4-M-5) — which model this task session runs on, and why
// =================================================================================================

/**
 * Where this project's capability register lives: the TARGET's own installed copy first
 * (`docs/reference/models/capability-register.json` — M-1 ships it under `spine/reference/models/`,
 * which the installer places under `docs/reference/models/`), then this pack's own
 * (`spine/reference/models/capability-register.json`, resolved from THIS FILE's own location rather
 * than from `dir` — the same `__dirname`-relative technique `resolveKernel` above already uses). A
 * project that has not installed the standards, or a pack checkout with neither present, is a real and
 * expected state, reported as `'none'` rather than thrown.
 *
 * `candidates` is accepted as an override so a test can prove the "neither resolves" branch without
 * needing to defeat this pack's own tracked file, the same reason `resolveKernel` accepts `kernelPath`.
 */
function resolveCapabilityRegisterPath(dir, candidates = [
  { path: path.join(dir, 'docs', 'reference', 'models', 'capability-register.json'), source: 'installed' },
  { path: path.join(__dirname, '..', '..', '..', 'spine', 'reference', 'models', 'capability-register.json'), source: 'pack' },
]) {
  for (const c of candidates) {
    try { if (fs.statSync(c.path).isFile()) return { path: c.path, source: c.source, searched: candidates.map((x) => x.path) }; } catch { /* next */ }
  }
  return { path: null, source: 'none', searched: candidates.map((x) => x.path) };
}

/**
 * Read the register JSON, or say plainly why there is none to read. A missing or unreadable register
 * does not stop this runner: `core.routing.route()` already gives the general fallback answer for a
 * register it was not handed, so this returns `register: null` and a `why` for the receipt to carry
 * rather than throwing.
 *
 * ⛔ RAW READ, CLASSIFIED IN kernel/schema.test.mjs's RAW_READS. `JSON.parse(fs.readFileSync(...))`
 * rather than `core.io.readJSONClassified`, because the register is a STATIC reference file this pack
 * or its target ships — never written concurrently, never mid-rename — the same class of read
 * `kernel/lib/gate.js`'s founder-config read already carries.
 */
function loadCapabilityRegister(dir, opts = {}) {
  const resolved = resolveCapabilityRegisterPath(dir, opts.candidates);
  if (!resolved.path) {
    return { register: null, source: 'none', path: null, why: `no capability register found. Looked at: ${resolved.searched.join(', ')}` };
  }
  try {
    const register = JSON.parse(fs.readFileSync(resolved.path, 'utf8'));
    return { register, source: resolved.source, path: resolved.path, why: null };
  } catch (e) {
    return { register: null, source: 'none', path: resolved.path, why: `${resolved.path} could not be read as JSON: ${e && e.message}` };
  }
}

/**
 * PURE-ISH (one read of a static file). Which model this task session runs on, from `core.routing`
 * (`core/index.js`, so this file requires core/ rather than the reverse — anti-drift item 36) — never
 * reimplemented here. `taskClass` is the row's own declared class, or `DEFAULT_TASK_CLASS` ('coding')
 * when the row declares none. `requiresHooks: true` is passed unconditionally (see the banner above
 * `TASK_SESSION_AVAILABILITY`): the answer's `family` is always `core.routing.HOOKED_FAMILY`, whatever
 * the register rates `preferred` for another family.
 *
 * @returns {{taskClass:string, family:string, model:string|null, rating:string, why:string,
 *   asOf:string|null, practice:string|null, alternatives:Array, skipped:Array,
 *   register:{source:'installed'|'pack'|'none', path:string|null, why:string|null}}}
 */
function resolveTaskRoute(dir, task, opts = {}) {
  const taskClass = task && typeof task.taskClass === 'string' ? task.taskClass : DEFAULT_TASK_CLASS;
  const loaded = loadCapabilityRegister(dir, opts);
  const routed = core.routing.route(taskClass, loaded.register, TASK_SESSION_AVAILABILITY, { requiresHooks: true });
  return {
    taskClass,
    family: routed.family,
    model: routed.model,
    rating: routed.rating,
    why: routed.why,
    asOf: routed.asOf,
    practice: routed.practice,
    alternatives: routed.alternatives,
    skipped: routed.skipped,
    register: { source: loaded.source, path: loaded.path, why: loaded.why },
  };
}

/**
 * ⛔ THE LAST FENCE BEFORE A PROCESS EXISTS. `buildTurnArgs` is pure and this runner never adds
 * `extraArgs`, so neither forbidden flag can appear today — which is exactly why the check is here
 * rather than in a comment: the day someone threads an option through, this refuses instead of
 * spawning a session with the anti-drift core switched off.
 *
 * The allow list is judged here too, on the argv rather than on the object that produced it, because
 * the argv is the only thing the host will actually read — and because a list threaded in by some
 * future caller that never went through `resolveAllowedTools` still has to meet the same floor.
 */
function assertArgvIsSafe(argv, { allowDangerouslySkipPermissions = false } = {}) {
  const found = FORBIDDEN_ARGS.filter((f) => argv.includes(f)
    && !(allowDangerouslySkipPermissions && f === '--dangerously-skip-permissions'));
  if (argv.includes('--resume')) {
    return { ok: false, why: 'the composed argv carries `--resume`, and a task session is a FRESH session by definition' };
  }
  if (found.length) {
    return {
      ok: false,
      why: `the composed argv carries ${found.join(' and ')}. `
        + '`--bare` skips hooks, CLAUDE.md discovery and auto-memory, which ARE the anti-drift core; '
        + '`--dangerously-skip-permissions` is the owner\'s own choice and is never set by this runner.',
    };
  }
  const bad = firstForbiddenTool(allowedToolsIn(argv));
  if (bad) {
    return { ok: false, why: `the composed argv allows ${JSON.stringify(bad.entry)}, which ${bad.why}` };
  }
  return { ok: true, why: null };
}

/**
 * The host's account of a workspace it will not read a settings file for, taken VERBATIM off the
 * child's stderr (the field run of 2026-09-03, D3). This is the one line that turns a
 * mysterious refusal into a one-line fix, and it never enters the JSON stream, so the session that
 * hit it could not see it and misdiagnosed the denial from the only evidence it had.
 *
 * ⭐ THIS IS DETECTION ONLY. P5-N-6a owns surfacing the child's stderr generally; this reads the one
 * stream this runner already holds and names the one sentence, rather than building a second copy of
 * that work beside it.
 *
 * @returns {{detected:boolean, verbatim:string|null}}
 */
function detectTrustRefusal(stderr) {
  const text = String(stderr == null ? '' : stderr);
  if (!text.toLowerCase().includes(TRUST_REFUSAL_PHRASE)) return { detected: false, verbatim: null };
  const line = text.split(/\r?\n/).find((l) => l.toLowerCase().includes(TRUST_REFUSAL_PHRASE));
  return { detected: true, verbatim: (line || text).trim() };
}

/** Where this task's turns live, and the next unused sequence number in it. */
function turnsDirFor(dir, taskId) { return path.join(atRel(dir, RUNTIME_TASKS_REL), io.safeSegment(taskId)); }

function nextTurnSeq(turnsDir) {
  let max = 0;
  try {
    for (const f of fs.readdirSync(turnsDir)) {
      const m = /^turn-(\d+)\.json$/.exec(f);
      if (m) max = Math.max(max, Number(m[1]));
    }
  } catch { /* no directory yet — seq 1 */ }
  return max + 1;
}

/**
 * Write the turn VERBATIM, before anything is interpreted — the same record
 * `sdk-supervisor/supervisor.js` `persistTurn` writes, in the same shape, so a reader of one has read
 * the other. `lines` are the protocol lines exactly as the host emitted them.
 */
function persistTurn({ dir, task, seq, prompt, turn, observation }) {
  const turnsDir = turnsDirFor(dir, task.id);
  const doc = {
    kind: 'claude-cli-turn',
    profile: 'claude-code/task-runner',
    seq,
    label: `task:${task.id}`,
    at: new Date().toISOString(),
    taskId: task.id,
    argv: turn.argv || [],
    exePath: turn.exePath || null,
    promptDigest: io.digest(String(prompt || '')),
    promptBytes: Buffer.byteLength(String(prompt || ''), 'utf8'),
    exit: { code: turn.code ?? null, signal: turn.signal ?? null, timedOut: Boolean(turn.timedOut), spawnError: turn.spawnError || null },
    durationMs: turn.durationMs ?? null,
    // VERBATIM. Not reformatted, not re-serialised from the parsed objects.
    lines: (turn.stdoutLines || []).slice(),
    stderr: turn.stderr || '',
    sessionId: observation ? stream.sessionIdOf(observation) : null,
    unparsedLines: observation ? observation.unparsed : [],
  };
  const file = path.join(turnsDir, `turn-${String(seq).padStart(3, '0')}.json`);
  const written = io.writeAtomicJSON(file, doc);
  return { seq, file, written: written.ok, digest: written.digest || null, detail: written.detail, doc };
}

/** Last N lines, then a character cap so one enormous line cannot defeat the line cap. */
const STDERR_SUMMARY_MAX_LINES = 20;
const STDERR_SUMMARY_MAX_CHARS = 4000;

/*
 * ⛔ A SHORTER VIEW FOR A READER, NEVER FOR A VERDICT (anti-drift item 38). `persistTurn` above already
 * kept `turn.stderr` verbatim and in full; this is a SEPARATE, bounded summary of the same bytes for the
 * report and the printed summary, because the 2026-09-03 dogfood run
 * (the field run of 2026-09-03, defect D2) found the one line that explained a FAIL — a
 * permission/trust refusal the host wrote only to stderr — was captured in the turn record and nowhere
 * else, so an owner had to already know to open the transcript file to find it. Nothing this produces is
 * read back as a completion signal or a verdict anywhere in this file; it is text for a person.
 *
 * @returns {{text:string, truncated:boolean, totalLines:number, shownLines:number}}
 */
function boundStderr(raw, { maxLines = STDERR_SUMMARY_MAX_LINES, maxChars = STDERR_SUMMARY_MAX_CHARS } = {}) {
  const text = String(raw || '');
  if (!text) return { text: '', truncated: false, totalLines: 0, shownLines: 0 };
  const allLines = text.split(/\r?\n/);
  if (allLines.length > 1 && allLines[allLines.length - 1] === '') allLines.pop(); // a trailing newline is not a line anyone wrote
  const totalLines = allLines.length;
  const kept = allLines.slice(-maxLines);
  let truncated = kept.length < totalLines;
  let joined = kept.join('\n');
  if (joined.length > maxChars) {
    joined = joined.slice(-maxChars); // keep the TAIL — the explanation is usually the last line the host wrote
    truncated = true;
  }
  return { text: joined, truncated, totalLines, shownLines: kept.length };
}

// =================================================================================================
// the gates · OUT OF BAND, IN THIS PROCESS, AND NEVER BY ASKING THE SESSION
// =================================================================================================

/*
 * ⛔ WINDOWS BATCH SHIMS, AND WHY THIS IS A SECOND COPY ON PURPOSE. `npm`, `pnpm`, `ruff` and friends
 * are `.cmd`/`.bat` files, which Node has refused to spawn directly since the 2024 command-injection
 * hardening; `shell: true` would fix it and reopen exactly that hole, because Node does not escape
 * arguments in shell mode. `kernel/lib/gate.js` resolveBin/defaultExec proves the alternative — resolve
 * through PATH/PATHEXT here, invoke a shim through cmd.exe with arguments we quote. This file cannot
 * REQUIRE that one (the kernel is a child process to this runner, never a library — see the header),
 * so the technique is copied and `runner.test.mjs` asserts the original is still there, which is what
 * keeps the copy traceable to the file that argues for it rather than becoming folklore.
 */
function resolveBin(bin) {
  if (process.platform !== 'win32') return bin;
  if (path.isAbsolute(bin) || bin.includes('/') || bin.includes('\\')) return bin;
  const exts = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  for (const entry of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const ext of [...exts, '']) {
      const candidate = path.join(entry, bin + ext);
      try { if (fs.statSync(candidate).isFile()) return candidate; } catch { /* keep looking */ }
    }
  }
  return bin; // unresolved — let spawn report ENOENT, which this file reports as CANNOT_DETERMINE
}

const winQuote = (a) => (/[\s"^&|<>()]/.test(a) ? `"${String(a).replace(/"/g, '\\"')}"` : a);

/**
 * Run one gate as a child process and report what happened, WITHOUT deciding what it means.
 * @returns {{ran:boolean, code:number|null, signal:string|null, timedOut:boolean, why:string|null, output:string}}
 */
function runGateProcess({ cwd, command, args, timeoutMs = GATE_TIMEOUT_MS, env = process.env }) {
  const resolved = resolveBin(command);
  const isBatch = process.platform === 'win32' && /\.(cmd|bat)$/i.test(resolved);
  const common = { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs, env, windowsHide: true };
  let r;
  try {
    r = isBatch
      ? spawnSync(process.env.ComSpec || 'cmd.exe',
        ['/d', '/s', '/c', `"${winQuote(resolved)} ${args.map(winQuote).join(' ')}"`],
        { ...common, windowsVerbatimArguments: true })
      : spawnSync(resolved, args, { ...common, shell: false });
  } catch (e) {
    return { ran: false, code: null, signal: null, timedOut: false, why: `the process could not be started: ${e && e.message}`, output: '' };
  }
  const output = `${r.stdout || ''}${r.stderr || ''}`.trim();
  if (r.error && r.error.code === 'ENOENT') return { ran: false, code: null, signal: null, timedOut: false, why: `command not found: ${command}`, output };
  if (r.error && r.error.code === 'ETIMEDOUT') return { ran: false, code: null, signal: r.signal || null, timedOut: true, why: `the deadline (${timeoutMs}ms) passed and the child was killed`, output };
  if (r.error) return { ran: false, code: null, signal: null, timedOut: false, why: `could not run ${command}: ${r.error.message}`, output };
  // A null status with no `error` is a child killed by a signal — a fact about the machine, not about
  // the check, so it is "could not run" rather than a failure of whatever it was checking.
  if (r.status === null) return { ran: false, code: null, signal: r.signal || null, timedOut: false, why: `the check was killed${r.signal ? ` by ${r.signal}` : ''} before it reported`, output };
  return { ran: true, code: r.status, signal: null, timedOut: false, why: null, output };
}

const gateRow = (over) => ({
  id: null, kind: null, outcome: null, exitCode: null, command: null, args: [], detail: null, output: null, ...over,
});

/** Truncated the way the savepoint receipt truncates its blocker details, and for the same reason. */
const trim = (s, n = 300) => String(s || '').split(/\r?\n/).join(' | ').slice(0, n);

/**
 * The kernel gate: `savepoint --verify`, run against the SAME kernel that recorded the delegation.
 *
 * ⛔ THIS ONE VERB DOES SPEAK 0/1/2. It is the pack's own, so its exit code IS the outcome vocabulary
 * and `--json` carries the same answer as a word. A project's own check does not speak it (below).
 */
function runSavepointGate({ dir, task, kernelPath = null, env = process.env }) {
  if (task.gates && task.gates.savepoint === false) {
    return gateRow({
      id: 'savepoint --verify', kind: 'kernel', outcome: OUTCOME.NOT_APPLICABLE,
      detail: `${QUEUE_REL} declares gates.savepoint false for ${task.id}, so no savepoint verdict is part of this task's answer`,
    });
  }
  const k = resolveKernel(dir, kernelPath);
  if (!k.ok) {
    return gateRow({ id: 'savepoint --verify', kind: 'kernel', outcome: OUTCOME.CANNOT_DETERMINE, detail: k.why });
  }
  const args = [k.path, 'savepoint', '--verify', '--dir', dir, '--json'];
  const r = runGateProcess({ cwd: dir, command: process.execPath, args, env });
  if (!r.ran) {
    return gateRow({
      id: 'savepoint --verify', kind: 'kernel', outcome: OUTCOME.CANNOT_DETERMINE,
      command: process.execPath, args, detail: r.why, output: trim(r.output),
    });
  }
  let json = null;
  try { json = JSON.parse(r.output); } catch { /* the exit code below is still the answer */ }
  const byCode = { 0: OUTCOME.PASS, 1: OUTCOME.FAIL, 2: OUTCOME.CANNOT_DETERMINE }[r.code] || OUTCOME.CANNOT_DETERMINE;
  const outcome = json && json.outcome && OUTCOME[json.outcome] ? json.outcome : byCode;
  const blockers = json && Array.isArray(json.checks)
    ? json.checks.filter((c) => c.outcome === OUTCOME.FAIL || c.outcome === OUTCOME.CANNOT_DETERMINE).map((c) => `${c.check} ${c.outcome}`)
    : [];
  return gateRow({
    id: 'savepoint --verify', kind: 'kernel', outcome, exitCode: r.code, command: process.execPath, args,
    detail: outcome === OUTCOME.PASS
      ? `the kernel verified the projection and every rendered claim (exit ${r.code})`
      : `the kernel exited ${r.code} — ${blockers.length ? `blocked by: ${trim(blockers.join('; '))}` : trim(r.output)}`,
    output: trim(r.output),
  });
}

/**
 * The project's OWN checks, from its `respawnpack.config.json` `qualityGate`, each spawned here.
 *
 * ⛔ EXIT 0 IS PASS, ANY OTHER EXIT IS FAIL, AND "COULD NOT RUN" IS NEITHER. That is
 * `kernel/lib/gate.js`'s own mapping (`r.code === 0 ? 'PASS' : 'FAIL'`, and `!r.ran` ⇒ COULD_NOT_RUN),
 * kept identical here so the runner and `respawnpack gate` cannot come to different verdicts about one
 * project. A founder's `npm test` does not speak this pack's 0/1/2 vocabulary, so reading ITS exit 2 as
 * CANNOT_DETERMINE would invent a claim the check never made.
 *
 * ⛔ AND AN UNDECLARED GATE IS NOT A PASSED ONE. Absent, empty, or opted out without a reason is
 * CANNOT_DETERMINE — `kernel/lib/gate.js`'s NOT_CONFIGURED at the same exit 2, and anti-drift items 12
 * and 13. This runner deliberately does NOT inherit gate.js's stack auto-detection: it runs what the
 * project DECLARED, so nothing it reports was chosen by a guess about the build system.
 */
function planQualityGate({ dir, task }) {
  if (task.gates && task.gates.gate === false) {
    return { rows: [gateRow({ id: 'qualityGate', kind: 'project', outcome: OUTCOME.NOT_APPLICABLE, detail: `${QUEUE_REL} declares gates.gate false for ${task.id}` })], checks: [] };
  }
  const cfg = io.readJSONClassified(atRel(dir, CONFIG_REL));
  if (cfg.status === 'ABSENT') {
    return { rows: [gateRow({ id: 'qualityGate', kind: 'project', outcome: OUTCOME.CANNOT_DETERMINE, detail: `${CONFIG_REL} is not present, so this project has declared no quality gate. Finding nothing is not the same as a project declaring it needs no gate.` })], checks: [] };
  }
  if (cfg.status !== 'OK') {
    return { rows: [gateRow({ id: 'qualityGate', kind: 'project', outcome: OUTCOME.CANNOT_DETERMINE, detail: `${CONFIG_REL} is ${cfg.status}: ${cfg.detail || 'no detail'}` })], checks: [] };
  }
  const raw = cfg.doc && cfg.doc.qualityGate;
  if (raw === undefined || raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { rows: [gateRow({ id: 'qualityGate', kind: 'project', outcome: OUTCOME.CANNOT_DETERMINE, detail: raw === undefined ? `no qualityGate in ${CONFIG_REL} — nobody has declared what "green" means here, and this runner never guesses one from the build system` : `qualityGate in ${CONFIG_REL} is ${Array.isArray(raw) ? 'an array' : typeof raw}, expected an object` })], checks: [] };
  }
  if (raw.notApplicable === true) {
    const reason = typeof raw.reason === 'string' ? raw.reason.trim() : '';
    return {
      rows: [gateRow({
        id: 'qualityGate', kind: 'project',
        outcome: reason ? OUTCOME.NOT_APPLICABLE : OUTCOME.CANNOT_DETERMINE,
        detail: reason
          ? `declared not applicable: ${reason}`
          : 'qualityGate.notApplicable is true with no reason — an opt-out nobody has to justify is an opt-out nobody reviews',
      })],
      checks: [],
    };
  }
  if (!Array.isArray(raw.checks) || !raw.checks.length) {
    return { rows: [gateRow({ id: 'qualityGate', kind: 'project', outcome: OUTCOME.CANNOT_DETERMINE, detail: `qualityGate declares no checks in ${CONFIG_REL} — either configure one, or declare {"notApplicable": true, "reason": "…"}` })], checks: [] };
  }
  return { rows: [], checks: raw.checks };
}

function runQualityGate({ dir, task, env = process.env }) {
  const planned = planQualityGate({ dir, task });
  const rows = [...planned.rows];
  for (const [i, c] of planned.checks.entries()) {
    const id = `qualityGate:${(c && typeof c === 'object' && c.name) || `check-${i + 1}`}`;
    if (!c || typeof c !== 'object' || typeof c.command !== 'string' || !c.command.trim()) {
      rows.push(gateRow({ id, kind: 'project', outcome: OUTCOME.CANNOT_DETERMINE, detail: 'the declared check has no string `command`, so there is nothing to run' }));
      continue;
    }
    const args = Array.isArray(c.args) ? c.args.map(String) : [];
    const cwd = path.join(dir, c.root || '.');
    const r = runGateProcess({ cwd, command: c.command, args, timeoutMs: Number.isFinite(c.timeoutMs) ? c.timeoutMs : GATE_TIMEOUT_MS, env });
    if (!r.ran) {
      // ⛔ ITEM 2, AT THE ONE LINE THAT MATTERS. A missing tool or a killed child is an unanswered
      // question, not a failing check, and the two get different repairs.
      rows.push(gateRow({ id, kind: 'project', outcome: OUTCOME.CANNOT_DETERMINE, command: c.command, args, detail: r.why, output: trim(r.output) }));
      continue;
    }
    rows.push(gateRow({
      id, kind: 'project', outcome: r.code === 0 ? OUTCOME.PASS : OUTCOME.FAIL, exitCode: r.code,
      command: c.command, args,
      detail: r.code === 0 ? `ran in ${c.root || '.'} and exited 0` : `ran in ${c.root || '.'} and exited ${r.code}`,
      output: trim(r.output),
    }));
  }
  return rows;
}

/**
 * Every gate, plus the ONE thing this half deliberately does not do yet.
 *
 * ⛔ THE `gates.only` SEAM · P4-K-08 ATTACHES HERE. The queue may declare `gates.only: ["test"]` to
 * SCOPE the gate to part of the project. This runner still applies NO scoping, and the wrong way to
 * handle an unapplied narrowing is to apply a guessed version of it: a scope that skipped the wrong
 * check would hide a real failure behind a field nobody wired. So the declaration is RECORDED, the
 * FULL gate runs, and the report says both. Running more than was asked cannot hide anything; running
 * less silently can.
 *
 * ⛔ HALF THE MECHANISM NOW EXISTS AND THIS IS STILL NOT WIRED TO IT, ON PURPOSE. P4-K-08 landed
 * `savepoint --only <stages>` / `--skip`, so the kernel row above could be narrowed by passing a stage
 * list through. It is not, because `gates.only` names PROJECT gate ids (`"test"`, `"lint"`) and
 * `--only` names SAVEPOINT STAGES, and mapping one vocabulary onto the other is a decision, not a
 * plumbing detail. Two properties of the kernel side are worth knowing when it is wired: a scoped
 * savepoint emits a NOT_APPLICABLE `stage:<name>` row for every stage it skipped, so `scopeApplied`
 * can be read back off the run rather than asserted; and a scoped run's receipt deliberately carries
 * no `sourceRevision`, so it never reads as a completed closeout. Until then `scopeApplied: null` is
 * the true answer and the note below says why in the present tense.
 */
function runGates({ dir, task, kernelPath = null, env = process.env }) {
  const rows = [runSavepointGate({ dir, task, kernelPath, env }), ...runQualityGate({ dir, task, env })];
  const scopeRequested = task.gates && Array.isArray(task.gates.only) ? task.gates.only.slice() : null;
  return {
    outcome: rollup(rows.map((r) => r.outcome)),
    scopeRequested,
    scopeApplied: null,
    scopeNote: scopeRequested
      ? `${QUEUE_REL} declares gates.only ${JSON.stringify(scopeRequested)}; this runner applies no gate scoping, so the FULL gate ran instead of a narrower one`
      : null,
    checks: rows,
  };
}

// =================================================================================================
// the attestation · read from the kernel's own record, never from the transcript
// =================================================================================================

/*
 * The kernel's comparison, reproduced: `kernel/lib/closeout.js` matches a `--met` string against the
 * recorded criterion through `kernel/lib/assert.js` foldCase, because the criterion a caller types
 * back differs in case and wrapping from the one that was recorded. This file cannot require the
 * kernel (header), so it folds the same two ways — collapse whitespace, lower the case — and nothing
 * more. Anything cleverer would ACCEPT more than the kernel does, which would let this runner report an
 * attestation the kernel would have refused.
 */
const foldCriterion = (s) => String(s === undefined || s === null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Did the session leave a `contract complete --met` attestation for every recorded criterion?
 *
 * ⛔ AN OPEN CONTRACT IS CANNOT_DETERMINE, NEVER SILENTLY DONE. A session that ended without closing
 * its delegation established nothing about the task: it may have finished and forgotten to attest, or
 * stopped halfway. Those are different, and the only honest answer to "which" is that nobody knows.
 *
 * ⛔ AND AN UNREADABLE CONTRACT IS NOT A CLOSED ONE. `hooks/_runtime.js` readContract degrades an
 * unreadable file to `collaborate`, which is the conservative answer for a HOOK deciding how much
 * ceremony a session owes. Here it would be the opposite: `collaborate` is what a CLOSED delegation
 * looks like, so degrading would turn a read failure into "the task was completed". So this reads the
 * document through `core/_io.js`'s classifying boundary and keeps the five answers apart.
 */
function readAttestation({ dir, task, recorded }) {
  const criteria = (recorded && recorded.length ? recorded : task.acceptance).slice();
  /*
   * ⛔ EVERY CRITERION IS RECORDED CANNOT_DETERMINE AS AN EVALUATION, INCLUDING THE ATTESTED ONES.
   * These rows are the honest answer to "did a machine check this": no. They are recorded and are
   * deliberately NOT rolled into the outcome — rolling them in would make exit 0 unreachable for any
   * task written in prose, which is every task. What IS rolled in is the two mechanical facts beside
   * them: the gates ran and passed, and the kernel holds an attestation for each of these.
   */
  const evaluation = criteria.map((c) => ({
    criterion: c,
    attested: false,
    evaluation: OUTCOME.CANNOT_DETERMINE,
    why: 'a prose acceptance criterion is not something this runner can evaluate; the attestation beside it is a claim the closing caller made, not a proof',
  }));
  const base = { recorded: criteria, attested: [], unattested: criteria.slice(), evaluation, attestedAt: null };

  const rt = io.readJSONClassified(atRel(dir, CONTRACT_REL));
  if (rt.status === 'ABSENT') {
    return { ...base, outcome: OUTCOME.CANNOT_DETERMINE, contractStatus: 'ABSENT', detail: `${CONTRACT_REL} is not present, and this runner recorded a delegation into it before the session started — the record it would read back is gone` };
  }
  if (rt.status !== 'OK' || !rt.doc || typeof rt.doc !== 'object' || Array.isArray(rt.doc)) {
    return { ...base, outcome: OUTCOME.CANNOT_DETERMINE, contractStatus: rt.status === 'OK' ? 'MALFORMED' : rt.status, detail: `${CONTRACT_REL} could not be read as a contract: ${rt.detail || rt.status}` };
  }
  if (rt.doc.mode === 'delegate') {
    return {
      ...base, outcome: OUTCOME.CANNOT_DETERMINE, contractStatus: 'OPEN',
      detail: `the delegation is still open in ${CONTRACT_REL}: no \`contract complete --met\` attestation was recorded for ${criteria.length} criterion(s)`,
    };
  }

  const arch = io.readJSONClassified(atRel(dir, DELEGATIONS_REL));
  if (arch.status !== 'OK' || !arch.doc || !Array.isArray(arch.doc.completed)) {
    return {
      ...base, outcome: OUTCOME.CANNOT_DETERMINE, contractStatus: 'CLOSED',
      detail: `the delegation is closed and its attestation archive ${DELEGATIONS_REL} is ${arch.status === 'OK' ? 'not an archive' : arch.status}: ${arch.detail || 'no `completed` array'}`,
    };
  }

  /*
   * NEWEST FIRST. `completed` is append-ordered and bounded at 50 by the kernel, and a task may have
   * been attempted before — the record that answers for THIS attempt is the last one whose task and
   * recorded criteria are the ones this runner delegated.
   */
  const want = new Set(criteria.map(foldCriterion));
  const record = [...arch.doc.completed].reverse().find((r) => r
    && foldCriterion(r.task) === foldCriterion(task.title)
    && Array.isArray(r.acceptance)
    && r.acceptance.some((a) => want.has(foldCriterion(a))));
  if (!record) {
    return {
      ...base, outcome: OUTCOME.CANNOT_DETERMINE, contractStatus: 'CLOSED',
      detail: `the delegation is closed and ${DELEGATIONS_REL} holds no attestation naming this task's criteria — something closed the contract without attesting to what this runner recorded`,
    };
  }

  const have = new Set(record.acceptance.map(foldCriterion));
  const rows = criteria.map((c) => ({
    criterion: c,
    attested: have.has(foldCriterion(c)),
    evaluation: OUTCOME.CANNOT_DETERMINE,
    why: 'a prose acceptance criterion is not something this runner can evaluate; the attestation beside it is a claim the closing caller made, not a proof',
  }));
  const unattested = rows.filter((r) => !r.attested).map((r) => r.criterion);
  return {
    recorded: criteria,
    attested: rows.filter((r) => r.attested).map((r) => r.criterion),
    unattested,
    evaluation: rows,
    attestedAt: record.attestedAt || null,
    contractStatus: 'ATTESTED',
    outcome: unattested.length ? OUTCOME.CANNOT_DETERMINE : OUTCOME.PASS,
    detail: unattested.length
      ? `${unattested.length} of ${criteria.length} recorded criterion(s) carry no attestation: ${unattested.map((u) => JSON.stringify(u)).join(', ')}`
      : `the kernel archived an attestation for all ${criteria.length} recorded criterion(s) at ${record.attestedAt || 'an unrecorded time'} — a claim under the kernel's own refusal of a partial close, and not a proof`,
  };
}

// =================================================================================================
// the handoff and the receipt
// =================================================================================================

/**
 * The same write-once document + sibling verification receipt `hooks/precompact-ledger-nudge.js`
 * writes at PreCompact, so the next session reads ONE format rather than a second one invented here.
 */
function writeHandoff({ dir, task, sessionId, gates, acceptance, outcome, turnFile }) {
  if (!sessionId) {
    return { status: 'CANNOT_DETERMINE', handoffId: null, path: null, cycleId: null, verified: false, detail: 'the host reported no session id, and a handoff that cannot name the conversation it belongs to may not be written' };
  }
  const host = core.evidence.HOSTS.CLAUDE_CODE;
  const cdir = core.cycle.conversationDir(dir, host, sessionId);

  // The cycle the TASK SESSION's own hooks established, when they did. An absent record is a mint and
  // says so (core/lifecycle/cycle.js) — and a cycle that cannot be persisted does not exist, so a
  // failed persist stops the handoff rather than binding it to an id nothing recorded.
  let cycleId = null;
  const existing = core.cycle.readPersisted(cdir);
  if (existing.status === 'OK') cycleId = existing.cycle.cycleId;
  else {
    const minted = core.cycle.mint({ host, conversationId: sessionId });
    const p = core.cycle.persist(cdir, minted);
    if (!p.ok) return { status: 'CANNOT_DETERMINE', handoffId: null, path: null, cycleId: null, verified: false, detail: `no context cycle could be established for ${sessionId}: ${p.failure.detail || p.failure.code}` };
    cycleId = minted.cycleId;
  }

  const tree = durable.treeState(dir);
  /*
   * ⛔ DISTINCT PATHS, NOT DISTINCT KEYS. `tree.files` is keyed by BUCKET (`W:` unstaged diff, `S:`
   * staged diff, `U:` untracked content, `C:` current bytes — hooks/_runtime.js treeState), and one
   * path legitimately appears under more than one bucket: a path that is both modified and staged sits
   * under `W:` and `S:` at once, and almost every existing path also gets a `C:` mirror. Mapping every
   * KEY to a path without de-duplicating counted such a path twice or more — the 2026-09-03 dogfood run
   * (the field run of 2026-09-03, defect D1) saw six changed paths become twelve entries,
   * which silently halves core/state/handoff.js's MAX_LISTED_FILES budget for a real project. `new
   * Set(...)` over `durable.pathOf` — `_runtime.js`'s own key decoder, and since P5-N-6c the ONE
   * spelling of that rule rather than a second copy of it living here — keeps first-occurrence order,
   * stable for a given tree state, and the bucket keys themselves are untouched in `tree.files` for
   * every other reader. The handoff's `git.uncommittedFiles` is schema-fenced to an array of strings
   * (schemas/rollover-handoff.schema.json) with no place for the bucket a path came from, so that
   * information is not carried any further than this list — only the distinct path is.
   */
  const uncommitted = tree ? [...new Set(Object.keys(tree.files).map(durable.pathOf))] : [];
  const delta = durable.sessionDelta(dir, sessionId, tree);

  const failing = gates.checks.filter((c) => c.outcome === OUTCOME.FAIL);
  const unrunnable = gates.checks.filter((c) => c.outcome === OUTCOME.CANNOT_DETERMINE);
  const unresolved = [
    ...failing.map((c) => `gate FAILED: ${c.id} — ${c.detail}`),
    ...unrunnable.map((c) => `gate COULD NOT RUN: ${c.id} — ${c.detail}`),
    ...acceptance.unattested.map((u) => `no \`contract complete --met\` attestation for: ${u}`),
    ...(gates.scopeNote ? [gates.scopeNote] : []),
  ];

  const record = core.handoff.build({
    identity: { host, conversationId: sessionId, conversationIdField: 'session_id' },
    contextCycleId: cycleId,
    atomicActionId: task.id,
    exactNextAction: outcome === OUTCOME.PASS
      ? `task ${task.id} passed its gates and every recorded criterion is attested — pick the next ready row from ${QUEUE_REL}`
      : failing.length
        ? `task ${task.id} is NOT done: fix ${failing.map((c) => c.id).join(', ')}, then re-run the task runner against this row`
        : `task ${task.id} is NOT done and nothing was established: resolve ${unresolved.length ? unresolved[0] : 'the unanswered gate'}, then re-run the task runner against this row`,
    git: {
      head: tree ? tree.head : null,
      uncommittedFiles: uncommitted,
      sessionDelta: { status: delta.status, files: delta.files.slice(0, core.handoff.MAX_LISTED_FILES), headMoved: Boolean(delta.headMoved) },
    },
    // The gate ROWS, as records rather than as a sentence about them. This is what "the handoff names
    // which gate and why" means: the next reader gets the row, not a summary of it.
    verificationEvidence: gates.checks.map((c) => ({ gate: c.id, kind: c.kind, outcome: c.outcome, exitCode: c.exitCode, detail: c.detail })),
    unresolvedQuestions: unresolved,
    source: { kind: 'native', raw: { runner: 'claude-code/task-runner', taskId: task.id, outcome, turnFile } },
  });

  let w;
  try { w = core.handoff.writeVerified(cdir, record); }
  catch (e) { w = { ok: false, failure: { code: 'HANDOFF_WRITE_FAILED', detail: `writeVerified threw: ${e && e.message}` } }; }
  if (!w.ok) {
    return { status: 'CANNOT_DETERMINE', handoffId: record.handoffId, path: core.handoff.pathFor(cdir, record.handoffId), cycleId, verified: false, detail: `${w.failure.code}: ${w.failure.detail || 'no detail'}` };
  }
  return { status: 'WRITTEN', handoffId: record.handoffId, path: w.handoffPath, cycleId, verified: true, detail: `written and read back identical (${String(w.writtenDigest).slice(0, 12)}…)` };
}

/**
 * Where this attempt's receipt lives.
 *
 * ⛔ ONE FILE PER ATTEMPT, AND THAT IS THE DIFFERENCE FROM `savepoint-attempt.json`. The savepoint
 * receipt describes the MOST RECENT run and is replaced wholesale by the next one (its registry entry
 * says exactly that). This one is written with `open(path,'wx')` and is therefore never replaced at
 * all — anti-drift item 40 — so the two cannot share one fixed name. The attempt number instead goes
 * in the FILENAME, the way `stop-<sessionId>.json` and `precompact-<sessionId>.json` already carry
 * their subject, and it is the SAME number as the turn record this receipt describes, so
 * `tasks/<id>/turn-003.json` and `task-attempt-<id>-003.json` are trivially paired. A second attempt
 * gets `-004`; nothing ever overwrites `-003`, and a receipt path that is already taken is reported as
 * CANNOT_DETERMINE with the first record, never resolved by clobbering it.
 */
function receiptPathFor(dir, taskId, seq) {
  return path.join(atRel(dir, RUNTIME_REL), `task-attempt-${io.safeSegment(taskId)}-${String(seq).padStart(3, '0')}.json`);
}

/**
 * Write the receipt EXACTLY ONCE.
 *
 * ⛔ `open(path,'wx')`, NEVER A READ-THEN-WRITE CHECK (anti-drift item 40). The decision is the file:
 * O_EXCL on POSIX, CREATE_NEW on Windows, so exactly one caller across any number of processes creates
 * it, and every other caller gets EEXIST — which is not an error but the ANSWER. `core/_io.js`
 * createExclusive is the same primitive `core/lifecycle/consumable.js` is built on; this is a RECORD
 * rather than a consumption claim, so it uses the primitive and not the consumption wrapper.
 */
function writeTaskAttempt(dir, doc) {
  const file = receiptPathFor(dir, doc.taskId, doc.attempt);
  const created = io.createExclusive(file, `${JSON.stringify(doc, null, 2)}\n`);
  if (created.status === 'CREATED') return { status: 'WRITTEN', path: file, detail: null, firstAttempt: null };
  if (created.status === 'EXISTS') {
    const back = io.readJSONClassified(file);
    return {
      status: 'ALREADY_WRITTEN', path: file,
      detail: `a receipt already exists at ${file} and was NOT overwritten${back.status === 'OK' ? `; it records ${JSON.stringify(back.doc && back.doc.outcome)} at ${(back.doc && back.doc.at) || 'an unrecorded time'}` : ` and could not be read back (${back.detail || back.status})`}`,
      firstAttempt: back.status === 'OK' ? back.doc : null,
    };
  }
  return { status: 'CANNOT_DETERMINE', path: file, detail: `the receipt could not be created: ${created.detail}`, firstAttempt: null };
}

// =================================================================================================
// the run
// =================================================================================================

const claim = (name, outcome, detail, evidence = null) => ({ name, outcome, detail, evidence });

/**
 * Read the queue, refuse on a stale projection, and run exactly one fresh session.
 *
 * @returns {Promise<object>} the report. `exitCode` is `exitCodeFor(report.outcome)`.
 */
async function runTask(options = {}) {
  const {
    dir: rawDir = process.env.CLAUDE_PROJECT_DIR || process.cwd(),
    taskId = null,
    dryRun = false,
    cli = cliLib.realCli,
    kernel = realKernel,
    kernelPath = null,
    freshnessReader = durable.readDurableState,
    claudePath = null,
    model = null,
    allowedTools = null,
    permissionMode = null,
    timeoutMs = cliLib.DEFAULT_TIMEOUT_MS,
    allowDangerouslySkipPermissions = false,
    env = process.env,
    onLine = null,
  } = options;

  const dir = path.resolve(rawDir);
  const report = {
    kind: 'respawnpack-task-runner-attempt',
    profile: 'claude-code/task-runner',
    startedAt: new Date().toISOString(),
    endedAt: null,
    dir,
    requestedTaskId: taskId,
    dryRun,
    environment: { node: process.version, platform: process.platform },
    freshness: null,
    queue: null,
    selection: null,
    task: null,
    prompt: null,
    // What this session was permitted, and which declared source said so. Null until a task is
    // selected, because an allow list without a task is a list for nobody.
    tools: null,
    // P4-M-5: which model this session runs on, and why. Null until a task is selected and the tool
    // list clears its own refusals, for the same reason `tools` above is: a route without a task is a
    // route for nobody, and a run refused before this point owes no verdict about what it would have
    // chosen.
    route: null,
    contract: null,
    turn: null,
    auth: null,
    // The host's own account of an untrusted workspace, when it gave one (D3). Null means the host
    // said nothing about trust, which is NOT the same as "this workspace is trusted".
    trust: null,
    claims: [],
    ownerActions: [],
    /*
     * ⛔ NULL IS THE SENTINEL FOR A RUN THAT REFUSED BEFORE THE GATES COULD RUN, AND NOTHING ELSE.
     * Every refusal above returns while these are still null, which SAYS "no verdict exists" — a
     * different statement from an absent key, and one a consumer cannot mistake for agreement. A run
     * that reaches the gates fills all three, always, including when a gate could not run.
     */
    gates: null,
    receipt: null,
    handoff: null,
    outcome: null,
    exitCode: null,
    summary: null,
  };

  const finish = (outcome, summary) => {
    report.outcome = outcome;
    report.exitCode = exitCodeFor(outcome);
    report.endedAt = new Date().toISOString();
    report.summary = summary;
    return report;
  };

  // --- 0. the project directory must exist before anything claims to have read it ----------------
  let stat = null;
  try { stat = fs.statSync(dir); } catch { /* reported below */ }
  if (!stat || !stat.isDirectory()) {
    report.claims.push(claim('the project directory exists', OUTCOME.CANNOT_DETERMINE, `${dir} is not a directory`));
    report.ownerActions.push(`Point --dir at an existing project. ${dir} is not a directory.`);
    return finish(OUTCOME.CANNOT_DETERMINE, `the project directory does not exist: ${dir}`);
  }

  // --- 1. freshness, FIRST -----------------------------------------------------------------------
  /*
   * ⛔ BEFORE THE QUEUE, BEFORE THE CONTRACT, BEFORE ANY PROCESS. A refusal here must leave the
   * project byte-identical: nothing under .respawnpack/runtime/tasks/, no delegation recorded, no
   * session started. Anything else and a stale run has already changed the tree it refused to work in.
   */
  const f = freshnessReader(dir);
  // `readDurableState` reports no detail on CURRENT (there is nothing to explain), so the revision the
  // projection is bound to is named here — the same fact `stateFreshness` puts in its own CURRENT line,
  // and the one the composed prompt tells the session it is booting from.
  const boundRev = f.state && f.state.sourceRevision ? String(f.state.sourceRevision).slice(0, 7) : null;
  const detail = f.detail
    || (f.status === 'CURRENT' ? (boundRev ? `current at ${boundRev}` : 'CURRENT') : null)
    || (f.status === 'ABSENT' ? `${STATE_REL} is not present, so there is no projection to start a fresh session from` : 'no detail reported');
  // One detail, printed and recorded, so a JSON consumer and the printed line cannot disagree.
  report.freshness = { label: f.status, detail, headRev: f.headRev || null };
  if (f.status !== 'CURRENT') {
    report.claims.push(claim('the projection this session would start from is current', OUTCOME.CANNOT_DETERMINE, `${f.status} — ${detail}`));
    report.ownerActions.push('Regenerate with `savepoint` (or `state compile`), then re-run this runner.');
    return finish(OUTCOME.CANNOT_DETERMINE, [
      `RespawnPack task runner — ${path.basename(dir)}`,
      stateWarnLine(f.status, detail),
      WITHHELD_LINE,
      REGENERATE_LINE,
      '  ⛔ REFUSED TO START. A fresh session composed from a stale projection is a confident wrong answer,',
      '     which is the exact failure this pack exists to prevent. Nothing was written and nothing was spawned.',
    ].join('\n'));
  }
  report.claims.push(claim('the projection this session would start from is current', OUTCOME.PASS, detail));

  // --- 2. the queue ------------------------------------------------------------------------------
  const q = loadTaskQueue(dir);
  report.queue = { path: QUEUE_REL, status: q.status, detail: q.detail, count: q.doc ? q.doc.tasks.length : 0 };
  if (q.status !== 'OK') {
    report.claims.push(claim('the task queue was read and accepted', OUTCOME.CANNOT_DETERMINE, q.detail || q.status));
    report.ownerActions.push(`Fix ${QUEUE_REL} against schemas/tasks.schema.json, then re-run.`);
    return finish(OUTCOME.CANNOT_DETERMINE, `  ⛔ ${QUEUE_REL} is ${q.status}: ${q.detail || 'no detail'}`);
  }
  report.claims.push(claim('the task queue was read and accepted', OUTCOME.PASS, `${q.doc.tasks.length} row(s) in ${QUEUE_REL}`));

  // --- 3. selection ------------------------------------------------------------------------------
  const sel = selectTask(q.doc, { taskId });
  report.selection = { picked: sel.task ? sel.task.id : null, skipped: sel.skipped, considered: sel.considered, why: sel.why };
  if (!sel.task) {
    /*
     * ⛔ TWO DIFFERENT FACTS, TWO DIFFERENT OUTCOMES, AND COLLAPSING THEM WOULD BE THE FAMILIAR BUG.
     *
     * "The queue holds no runnable row" is NOT_APPLICABLE at exit 0: there was no work, which is a
     * legitimate and complete answer. "You named a row and it cannot be started" is
     * CANNOT_DETERMINE at exit 2: work WAS asked for and nothing was established about it. A caller
     * that asked for T-2 and got exit 0 would read "the queue was empty" and move on.
     *
     * Either way the rows that were passed over are PRINTED, because a selector that silently
     * produces no work is indistinguishable from a broken one.
     */
    const lines = [taskId === null
      ? `  no runnable task in ${QUEUE_REL} — ${sel.why}`
      : `  ⛔ the task you named cannot be started — ${sel.why}`];
    for (const s of sel.skipped) lines.push(`    skipped  ${s.id}: ${s.why}`);
    const outcome = taskId === null ? OUTCOME.NOT_APPLICABLE : OUTCOME.CANNOT_DETERMINE;
    if (taskId !== null) report.ownerActions.push(`Make ${JSON.stringify(taskId)} ready in ${QUEUE_REL} (and finish its dependsOn), or run without --task.`);
    report.claims.push(claim('a runnable task was selected', outcome, sel.why));
    return finish(outcome, lines.join('\n'));
  }
  const task = sel.task;
  report.task = { id: task.id, title: task.title, specPointer: task.specPointer, acceptance: task.acceptance.slice(), dependsOn: (task.dependsOn || []).slice() };
  report.claims.push(claim('a runnable task was selected', OUTCOME.PASS, `${task.id} — ${task.title}`));

  // --- 4. the criteria must survive the kernel's own `;` split ------------------------------------
  const splitRisk = task.acceptance.filter((a) => a.includes(';'));
  if (splitRisk.length) {
    report.claims.push(claim('every acceptance criterion survives the delegation intact', OUTCOME.CANNOT_DETERMINE,
      `${splitRisk.length} criterion(s) contain a semicolon, which \`contract delegate --acceptance\` splits on`, { criteria: splitRisk }));
    report.ownerActions.push(`Rewrite these criteria in ${QUEUE_REL} without a semicolon: ${splitRisk.map((s) => JSON.stringify(s)).join(', ')}`);
    return finish(OUTCOME.CANNOT_DETERMINE,
      `  ⛔ task ${task.id} has ${splitRisk.length} acceptance criterion(s) containing ";", which the kernel's\n`
      + '     `--acceptance` flag splits on. Recording them would change what the queue said, and the\n'
      + '     per-criterion attestation would then owe an answer for a criterion nobody wrote.');
  }

  // --- 4b. the tool allow list: DERIVED, then resolved and fenced BEFORE anything is spawned -------
  /*
   * ⛔ BEFORE `runVersion`, BEFORE THE DELEGATION, BEFORE THE SESSION. A list this runner would refuse
   * to spawn with must be refused while the project is still untouched: a delegation opened for a
   * session that was never started is a dangling obligation for the next reader, and the version probe
   * is already a process. So the derivation is read, the row is checked against it, and the floor is
   * applied — all here, and the floor again on the composed argv below.
   */
  const derivation = resolveToolDerivation(dir);
  const tools = resolveAllowedTools({ task, option: allowedTools, derived: derivation });
  report.tools = {
    source: tools.source, why: tools.why, list: tools.list.slice(), count: tools.list.length, refused: null,
    derivedFrom: tools.derivedFrom,
    derivation: {
      list: derivation.list.slice(), why: derivation.why,
      posture: derivation.posture, projectType: derivation.projectType,
    },
  };
  const badTool = firstForbiddenTool(tools.list);
  if (badTool) {
    /*
     * The source is named because the repair is different for each: a row is edited in the queue, an
     * option is retyped, and a refused DERIVED LIST is a bug in this file's `deriveAllowedTools`
     * additions rather than in anyone's project. `runner.test.mjs` asserts every derived combination
     * passes its own fence, so the third case should be unreachable — which is exactly why it says so
     * plainly instead of blaming the caller.
     */
    const where = tools.source === 'task-row' ? `${QUEUE_REL}'s \`tools\``
      : tools.source === 'option' ? '--allowed-tools'
        : 'the list this runner derived for this project, which is a bug in runner.js and not in this project';
    report.tools.refused = { entry: badTool.entry, why: badTool.why };
    report.claims.push(claim('every tool this session would be allowed is one a bounded task may have',
      OUTCOME.CANNOT_DETERMINE, `${JSON.stringify(badTool.entry)} ${badTool.why}`, { source: tools.source, entry: badTool.entry }));
    report.ownerActions.push(`Narrow ${JSON.stringify(badTool.entry)} in ${where}: name the program the task actually runs.`);
    return finish(OUTCOME.CANNOT_DETERMINE, [
      `  ⛔ refused to run task ${task.id}: the allow list from ${where} carries`,
      `     ${JSON.stringify(badTool.entry)}, which ${badTool.why}.`,
      '     Nothing was spawned, no contract was recorded, and the queue row is untouched.',
    ].join('\n'));
  }
  /*
   * ⛔ P3-I-2 · A ROW MAY ONLY NARROW WHAT ITS OWN PROJECT DERIVES. Checked only for `task-row` — a
   * `default` list IS the derived list (trivially a subset) and `option` is the owner's explicit,
   * command-line override, which may widen past the derivation on purpose. An entry here already
   * cleared the floor above, so this refusal is about SCOPE (not part of this project's derivation),
   * never about the entry being individually dangerous.
   */
  if (tools.source === 'task-row') {
    const underived = firstUnderivedTool(task.tools, derivation.list);
    if (underived) {
      report.tools.refused = {
        entry: underived,
        why: `is not in the list this project derives (posture ${derivation.posture.profile}, projectType `
          + `${derivation.projectType.value || 'undeclared'}): ${derivation.list.join(', ')}`,
      };
      report.claims.push(claim('the queue row\'s `tools` narrows the list this project derives, never widens it',
        OUTCOME.CANNOT_DETERMINE, `${JSON.stringify(underived)} is outside the derived list: ${derivation.list.join(', ')}`,
        { entry: underived, derivedFrom: derivation.derivedFrom, derivedList: derivation.list.slice() }));
      report.ownerActions.push(`Remove ${JSON.stringify(underived)} from ${QUEUE_REL}'s \`tools\` for ${task.id} — `
        + `a row may only narrow the list this project's posture and projectType derive (${derivation.list.join(', ')}), never widen it.`);
      return finish(OUTCOME.CANNOT_DETERMINE, [
        `  ⛔ refused to run task ${task.id}: \`tools\` in ${QUEUE_REL} declares ${JSON.stringify(underived)},`,
        `     which is outside the list derived for this project (posture ${derivation.posture.profile}, `
          + `projectType ${derivation.projectType.value || 'undeclared'}):`,
        `     ${derivation.list.join(', ')}`,
        '     A queue row may only narrow the derived list, never widen it. Nothing was spawned, no contract',
        '     was recorded, and the queue row is untouched.',
      ].join('\n'));
    }
  }
  report.claims.push(claim('every tool this session would be allowed is one a bounded task may have', OUTCOME.PASS,
    `${tools.list.length} entr${tools.list.length === 1 ? 'y' : 'ies'} from ${tools.source} (${tools.why}): ${tools.list.join(', ')}`,
    { source: tools.source, list: tools.list.slice(), derivedFrom: tools.derivedFrom }));

  // --- 4c. the route: which model this session runs on, and why (P4-M-5) -------------------------
  /*
   * ⛔ requiresHooks:true, ALWAYS — see the TASK_SESSION_AVAILABILITY banner above. `model` is the
   * ROUTED answer; `effectiveModel` is what the session actually gets, the owner's own `--model`
   * winning when it was typed. Both travel on the report and the receipt (P3-I-2's `derivedFrom`
   * precedent), and `--dry-run` prints the route the same way it prints the tool derivation.
   */
  const routed = resolveTaskRoute(dir, task);
  const effectiveModel = model || routed.model || null;
  report.route = {
    taskClass: routed.taskClass,
    family: routed.family,
    model: routed.model,
    rating: routed.rating,
    why: routed.why,
    asOf: routed.asOf,
    practice: routed.practice,
    alternatives: routed.alternatives,
    skipped: routed.skipped,
    register: routed.register,
    effectiveModel,
    overridden: Boolean(model),
    overriddenBy: model ? `--model ${model} on the command line` : null,
  };
  report.claims.push(claim('a model was routed for this task class', OUTCOME.PASS,
    report.route.overridden
      ? `the owner's --model ${JSON.stringify(model)} overrides the routed ${routed.model ? JSON.stringify(routed.model) : '(none)'} for ${routed.taskClass} — ${routed.why}`
      : `${routed.taskClass} → ${routed.family}${routed.model ? `/${routed.model}` : ' (no model chosen, the host default applies)'} — ${routed.why}`,
    { route: report.route }));

  // --- 5. the prompt -----------------------------------------------------------------------------
  const prompt = composePrompt({ task, freshness: report.freshness });
  report.prompt = { bytes: Buffer.byteLength(prompt, 'utf8'), digest: io.digest(prompt), text: prompt };

  if (dryRun) {
    /*
     * A dry run establishes nothing about the task — it establishes something about THIS RUNNER. So
     * the outcome is NOT_APPLICABLE (exit 0, "no verdict was owed"), never PASS.
     */
    report.claims.push(claim('one fresh session ran and its transcript was captured', OUTCOME.NOT_APPLICABLE,
      'dry run — the prompt was composed and printed; no contract was recorded and no process was spawned'));
    const routeLine = `  route (${routed.taskClass}): ${report.route.family}`
      + `${report.route.effectiveModel ? `/${report.route.effectiveModel}` : ' — no model chosen, the host default applies'}`
      + `${report.route.overridden ? ` [overrides routed ${routed.model || '(none)'}]` : ''}`
      + ` — register: ${routed.register.source}${routed.register.path ? ` (${routed.register.path})` : ''}`;
    return finish(OUTCOME.NOT_APPLICABLE, [
      `  dry run — task ${task.id} (${task.title})`,
      `  ${QUEUE_REL}: ${sel.skipped.length} row(s) passed over, ${task.acceptance.length} acceptance criterion(s)`,
      `  derived from: posture ${derivation.posture.profile} (${derivation.posture.source}), projectType `
        + `${derivation.projectType.value || 'undeclared'} — ${derivation.why}`,
      `  --allowedTools (${tools.source}): ${tools.list.join(', ')}`,
      routeLine,
      '  nothing was spawned and no contract was recorded. The composed prompt follows.',
      '',
      prompt,
    ].join('\n'));
  }

  // --- 6. pre-flight: is there a host at all? -----------------------------------------------------
  /*
   * `runVersion` is the cheap probe (no session, no model call, no cost) the hooks-and-install audit §6 names, so
   * a missing or unreachable executable fails fast and BEFORE a delegation is recorded — a contract
   * opened against a session that was never spawned is a dangling obligation for the next reader.
   */
  const version = await cli.runVersion({ claudePath, env, cwd: dir });
  report.environment.claudeVersion = version.version || null;
  report.environment.exePath = version.exePath || null;
  if (!version.ok) {
    report.claims.push(claim('the configured host is reachable', OUTCOME.CANNOT_DETERMINE, version.why || 'the version probe did not answer',
      { stdout: version.stdout || '', stderr: version.stderr || '' }));
    report.ownerActions.push(version.exePath
      ? `\`${version.exePath} --version\` did not answer. Run it by hand and resolve what it reports.`
      : 'Install Claude Code, or point RESPAWNPACK_CLAUDE_PATH at the executable.');
    return finish(OUTCOME.CANNOT_DETERMINE, `  ⛔ the host did not answer: ${version.why || 'no reason reported'}\n     Task ${task.id} was left untouched and no contract was recorded.`);
  }
  report.claims.push(claim('the configured host is reachable', OUTCOME.PASS, `claude ${version.version} at ${version.exePath}`));

  // --- 7. record the delegation, BEFORE the session exists ---------------------------------------
  const rec = kernel.run({ dir, task, kernelPath, env });
  report.contract = {
    recorded: Boolean(rec.ok),
    argv: rec.argv || [],
    kernelPath: rec.kernelPath || null,
    exitCode: rec.code ?? null,
    outcome: rec.json ? rec.json.outcome : null,
    acceptance: rec.json && rec.json.contract ? rec.json.contract.acceptance : null,
    /*
     * ⭐ THE ALLOW LIST TRAVELS WITH THE DELEGATION RECORD, not because the kernel stores it — the
     * kernel's `contract delegate` takes a task and an acceptance list and nothing else, and giving it
     * a second field here would make this runner a second writer of a document it deliberately only
     * reads. What is recorded is the runner's own account of the delegation it opened: WHICH tools the
     * session it delegated to was permitted, which declared source said so, and (P3-I-2) what this
     * project's posture and projectType derived — present regardless of source, because "what would
     * this project have derived" stays worth knowing even when a row narrowed it or the owner overrode it.
     */
    allowedTools: tools.list.slice(),
    allowedToolsSource: tools.source,
    allowedToolsDerivedFrom: tools.derivedFrom,
    stdout: rec.stdout || '',
    stderr: rec.stderr || '',
  };
  if (!rec.ok) {
    /*
     * ⛔ CANNOT_DETERMINE, NOT FAIL. The task did not run. Whether the kernel could not be reached or
     * refused the delegation outright, the fact established is "this task was not attempted" — and a
     * task marked FAIL gets re-planned, when what is owed here is a fix to the queue or the install.
     * Anti-drift item 2, in the one place a runner is most tempted to break it.
     */
    report.claims.push(claim('the delegation was recorded before the session started', OUTCOME.CANNOT_DETERMINE,
      rec.why || 'the kernel did not record the delegation', { stdout: rec.stdout || '', stderr: rec.stderr || '' }));
    report.ownerActions.push('Run the same `contract delegate` by hand against this project and resolve what the kernel reports; the argv is in this report.');
    return finish(OUTCOME.CANNOT_DETERMINE, [
      `  ⛔ the delegation for task ${task.id} was NOT recorded: ${rec.why || 'no reason reported'}`,
      ...(rec.stdout ? [`     kernel said: ${rec.stdout.trim().split('\n').join('\n     ')}`] : []),
      ...(rec.stderr ? [`     kernel stderr: ${rec.stderr.trim().split('\n').join('\n     ')}`] : []),
      '     No session was started and the task row is untouched.',
    ].join('\n'));
  }
  report.claims.push(claim('the delegation was recorded before the session started', OUTCOME.PASS,
    `contract delegate --task ${JSON.stringify(task.title)} with ${task.acceptance.length} acceptance criterion(s)`));

  // --- 8. one fresh session ----------------------------------------------------------------------
  /*
   * ⛔ NO `sessionId`, SO NO `--resume`. Omitting it IS how a fresh session starts (cli.js
   * buildTurnArgs). The prompt travels on stdin because a task record plus its acceptance list can
   * exceed a Windows argv.
   */
  const turnOpts = {
    cwd: dir,
    claudePath,
    env: { ...env, RESPAWNPACK_TASK_ID: task.id },
    prompt,
    promptVia: 'stdin',
    // ⛔ P4-M-5 · The ROUTED model, never the raw option, for the same reason the tool list below is
    // the resolved one: `effectiveModel` is `model` unless the owner's `--model` overrode it, and that
    // decision was already made and recorded on `report.route` above.
    model: effectiveModel,
    // ⛔ The RESOLVED list, never the raw option: the argv is where a task session's permissions have
    // to live, because an untrusted workspace's settings file is not read at all (D3).
    allowedTools: tools.list,
    permissionMode,
    timeoutMs,
    onLine,
  };
  const plannedArgv = cliLib.buildTurnArgs({ ...turnOpts, promptVia: 'stdin' });
  const safe = assertArgvIsSafe(plannedArgv, { allowDangerouslySkipPermissions });
  if (!safe.ok) {
    report.turn = { plannedArgv, refused: safe.why };
    report.claims.push(claim('the composed invocation keeps the anti-drift core switched on', OUTCOME.CANNOT_DETERMINE, safe.why));
    report.ownerActions.push('Remove the flag from whatever option threaded it through; a task session runs with the hooks on.');
    return finish(OUTCOME.CANNOT_DETERMINE, `  ⛔ refused to spawn: ${safe.why}`);
  }
  report.claims.push(claim('the composed invocation keeps the anti-drift core switched on', OUTCOME.PASS,
    `no ${FORBIDDEN_ARGS.join(', no ')}, and no --resume: ${plannedArgv.join(' ')}`));

  const turnsDir = turnsDirFor(dir, task.id);
  const seq = nextTurnSeq(turnsDir);
  const turn = await cli.runTurn(turnOpts);

  // The bytes are kept BEFORE any of them is interpreted.
  const observation = stream.observe(turn.stdoutLines || []);
  const persisted = persistTurn({ dir, task, seq, prompt, turn, observation });
  report.turn = {
    seq: persisted.seq,
    file: persisted.file,
    written: persisted.written,
    writeDetail: persisted.detail || null,
    digest: persisted.digest,
    plannedArgv,
    argv: turn.argv || [],
    lines: (turn.stdoutLines || []).length,
    sessionId: stream.sessionIdOf(observation),
    exit: { code: turn.code ?? null, signal: turn.signal ?? null, timedOut: Boolean(turn.timedOut), spawnError: turn.spawnError || null },
    durationMs: turn.durationMs ?? null,
    // Bounded for a reader, never for a verdict (anti-drift item 38) — see boundStderr above. The full
    // bytes stay verbatim at `persisted.file` regardless of what this summarises.
    stderrSummary: boundStderr(turn.stderr),
  };
  report.auth = observation.auth;

  /*
   * ⛔ THE TRUST SENTENCE, NAMED IN WORDS RATHER THAN LEFT IN A FILE. It is read from the stderr this
   * runner already holds and it changes NO verdict: the session's tools came from the argv, which the
   * trust dialog does not gate, so a run that hits this line is unaffected by it. What it changes is
   * what an operator is told — the first live run (D3) failed with the session guessing at a denial
   * whose explanation was sitting on a channel it never receives.
   */
  const trust = detectTrustRefusal(turn.stderr);
  if (trust.detected) {
    report.trust = { detected: true, verbatim: trust.verbatim, source: 'the child\'s stderr' };
    report.claims.push(claim('this session\'s tool permissions did not depend on the workspace\'s trust state', OUTCOME.PASS,
      `the host said, verbatim: ${trust.verbatim} — so every \`permissions.allow\` entry in this project's settings was discarded, `
      + `and the ${tools.list.length} entr${tools.list.length === 1 ? 'y' : 'ies'} this runner composed onto --allowedTools (${tools.source}) is what the session actually had`,
      { verbatim: trust.verbatim, from: 'stderr', allowedTools: tools.list.slice() }));
    report.ownerActions.push('This workspace has not accepted Claude Code\'s trust dialog, so the host ignored '
      + `\`.claude/settings.json\`'s \`permissions.allow\` entirely: ${trust.verbatim} `
      + 'The task session was unaffected because its tools travelled on --allowedTools, but every OTHER '
      + 'reader of that file (an interactive session in this project) is affected. Open the project once '
      + 'interactively and accept the dialog if you want the settings file to apply.');
  }

  if (!persisted.written) {
    report.claims.push(claim('the session transcript was captured verbatim', OUTCOME.CANNOT_DETERMINE,
      `the turn record could not be written to ${persisted.file}: ${persisted.detail || 'no detail'}`));
    report.ownerActions.push(`Make ${turnsDir} writable, then re-run. The turn happened; the evidence for it did not survive.`);
    return finish(OUTCOME.CANNOT_DETERMINE, `  ⛔ the session ran and its transcript could NOT be captured: ${persisted.detail || 'no detail'}`);
  }

  // --- 9. the one thing the stream is read for ---------------------------------------------------
  /*
   * ⛔ AN UNAUTHENTICATED HOST IS CANNOT_DETERMINE WITH THE HOST'S OWN WORDS — canary.js:8-11's rule,
   * unchanged. Never FAIL: "could not run" and "ran and failed" are different facts, and a task
   * marked FAIL is re-planned when it should be re-authenticated. The task row is left exactly as the
   * queue had it (this runner never writes the queue at all — `writer: null`, registry.json).
   */
  if (observation.auth && observation.auth.failed) {
    report.claims.push(claim('the host was authenticated for this session', OUTCOME.CANNOT_DETERMINE,
      observation.auth.verbatim, { from: observation.auth.from, phrase: observation.auth.phrase }));
    report.ownerActions.push('Authenticate the host (`claude` then /login) and re-run; nothing about this task was established.');
    return finish(OUTCOME.CANNOT_DETERMINE, [
      `  ⛔ the host reported an authentication failure, verbatim (${observation.auth.from}):`,
      `     ${observation.auth.verbatim}`,
      `  Task ${task.id} is left exactly as the queue had it. This is CANNOT_DETERMINE, not FAIL:`,
      '  "could not run" and "ran and failed" are different facts, and the second gets re-planned',
      '  when what is owed is a login.',
      `  The stream is kept verbatim at ${persisted.file}`,
    ].join('\n'));
  }

  if (turn.spawnError || turn.timedOut || turn.code !== 0) {
    /*
     * ⛔ A TIMEOUT IS NOT AN OUTCOME, AND AN EXIT CODE IS NOT A PROOF (cli.js's own header;
     * FORBIDDEN_PROOF_TOKENS, anti-drift item 38). The turn ended without the host completing it, so
     * the transcript is partial and "the session ran and was captured" is not something this run can
     * claim. What DID happen is recorded verbatim either way.
     */
    const why = turn.spawnError
      ? `the process could not be run: ${turn.spawnError}`
      : turn.timedOut
        ? `the deadline (${timeoutMs}ms) passed and the child was killed, so the transcript is partial`
        : `the host exited ${turn.code}${turn.signal ? ` (signal ${turn.signal})` : ''}`;
    report.claims.push(claim('one fresh session ran to completion and its transcript was captured', OUTCOME.CANNOT_DETERMINE, why,
      { stderr: turn.stderr || '', lines: (turn.stdoutLines || []).length }));
    report.ownerActions.push(`Read ${persisted.file} — every line the host emitted before it stopped is in it, verbatim.`);
    return finish(OUTCOME.CANNOT_DETERMINE, [
      `  ⛔ the session did not complete: ${why}`,
      ...(turn.stderr ? [`     host stderr: ${turn.stderr.trim().split('\n').join('\n     ')}`] : []),
      `  Task ${task.id} is left exactly as the queue had it. Partial transcript: ${persisted.file}`,
    ].join('\n'));
  }

  report.claims.push(claim('one fresh session ran to completion and its transcript was captured', OUTCOME.PASS,
    `session ${report.turn.sessionId || '(the host reported no id)'}, ${report.turn.lines} protocol line(s) kept verbatim at ${persisted.file}`,
    { file: persisted.file, digest: persisted.digest }));

  // ===============================================================================================
  // ⛔ EVERYTHING ABOVE IS "A SESSION RAN". EVERYTHING BELOW IS "AND HERE IS WHAT IT ACHIEVED",
  // decided IN THIS PROCESS and never by asking the session. The order is deliberate: the gates run
  // before the attestation is read, so a project that cannot even verify itself is reported that way
  // whatever the contract says; and the handoff is written before the receipt, so the receipt can
  // record whether the handoff survived.
  // ===============================================================================================

  // --- 10. the gates -----------------------------------------------------------------------------
  const gates = runGates({ dir, task, kernelPath, env });
  report.gates = gates;
  for (const g of gates.checks) {
    report.claims.push(claim(`gate ${g.id}`, g.outcome, g.detail, g.output ? { output: g.output, exitCode: g.exitCode } : null));
  }
  if (gates.scopeRequested) {
    report.claims.push(claim('the task\'s declared gate scope was applied', OUTCOME.NOT_APPLICABLE, gates.scopeNote));
  }
  for (const g of gates.checks) {
    if (g.outcome === OUTCOME.FAIL) report.ownerActions.push(`Fix what \`${g.id}\` reported, then re-run this task: ${g.detail}`);
    if (g.outcome === OUTCOME.CANNOT_DETERMINE) report.ownerActions.push(`\`${g.id}\` could not run, so nothing was established by it: ${g.detail}`);
  }

  // --- 11. the attestation -----------------------------------------------------------------------
  const acceptance = readAttestation({ dir, task, recorded: report.contract.acceptance });
  gates.acceptance = acceptance;
  report.claims.push(claim('every recorded acceptance criterion carries a `contract complete --met` attestation',
    acceptance.outcome, acceptance.detail, { unattested: acceptance.unattested }));
  if (acceptance.outcome !== OUTCOME.PASS) {
    report.ownerActions.push(`Read ${persisted.file} to see what the session did, then either finish the task or attest what is genuinely done: ${acceptance.unattested.length} criterion(s) are unattested.`);
  }

  /*
   * ⛔ THE ONE CLAIM THAT IS ABOUT WHAT WAS *NOT* READ, and it is recorded rather than assumed. The
   * transcript is evidence of what happened; it is never evidence that the task is done. This runner
   * reads it for exactly two structural facts (the session id and detectAuth) and for nothing else,
   * so a stream containing FORBIDDEN_PROOF_TOKENS or a confident "all acceptance criteria met" moves
   * no verdict here. Anti-drift item 38.
   */
  report.claims.push(claim('completion was decided from the gates and the kernel\'s attestation record only', OUTCOME.PASS,
    'the transcript was kept verbatim and was not read for completion: no session-claimed success text, timeout, elapsed time or exit code is accepted as proof (core/lifecycle/evidence.js FORBIDDEN_PROOF_TOKENS)'));

  const attemptOutcome = rollup([gates.outcome, acceptance.outcome]);

  // --- 12. the handoff ---------------------------------------------------------------------------
  const handoff = writeHandoff({
    dir, task, sessionId: report.turn.sessionId, gates, acceptance,
    outcome: attemptOutcome, turnFile: persisted.file,
  });
  report.handoff = handoff;
  report.claims.push(claim('a verified handoff was written for the next reader',
    handoff.status === 'WRITTEN' ? OUTCOME.PASS : OUTCOME.CANNOT_DETERMINE, handoff.detail));
  if (handoff.status !== 'WRITTEN') report.ownerActions.push(`No handoff was written for task ${task.id}: ${handoff.detail}`);

  // --- 13. the receipt, written exactly once -----------------------------------------------------
  const withHandoff = rollup([attemptOutcome, handoff.status === 'WRITTEN' ? OUTCOME.PASS : OUTCOME.CANNOT_DETERMINE]);
  const receiptDoc = {
    kind: TASK_ATTEMPT_KIND,
    schemaVersion: TASK_ATTEMPT_SCHEMA_VERSION,
    at: new Date().toISOString(),
    taskId: task.id,
    title: task.title,
    attempt: persisted.seq,
    sessionId: report.turn.sessionId || null,
    outcome: withHandoff,
    exitCode: exitCodeFor(withHandoff),
    /*
     * ⭐ WHAT THE SESSION WAS PERMITTED, IN THE RECEIPT ITSELF. A verdict about what a session achieved
     * is not readable without it: "could not write the file" and "was not allowed to write the file"
     * are different findings, and the first live run produced the second while looking like the first.
     * `trustRefused` is the host's own account of an untrusted workspace, or null when it said nothing.
     * `derivedFrom` (P3-I-2) is the posture and projectType this project's list was derived from, so a
     * reader can tell "the floor" from "this project's own derivation" without re-deriving it.
     */
    tools: {
      source: tools.source,
      allowed: tools.list.slice(),
      trustRefused: report.trust ? report.trust.verbatim : null,
      derivedFrom: tools.derivedFrom,
    },
    /*
     * ⭐ P4-M-5 · WHICH MODEL THE SESSION RAN ON, IN THE RECEIPT ITSELF — the same reasoning `tools`
     * above already carries. `family` is always "anthropic" (schemas/task-attempt.schema.json pins it
     * with `const`, so a future bug that forgot `requiresHooks: true` fails the schema, not just a
     * runtime assertion). `model` is what was routed; `effectiveModel` is what the session actually
     * got, which differs only when `overridden` is true.
     */
    route: {
      taskClass: report.route.taskClass,
      family: report.route.family,
      model: report.route.model,
      effectiveModel: report.route.effectiveModel,
      rating: report.route.rating,
      why: trim(report.route.why, 600),
      overridden: report.route.overridden,
      overriddenBy: report.route.overriddenBy,
      register: report.route.register,
    },
    gates: {
      outcome: gates.outcome,
      scopeRequested: gates.scopeRequested,
      scopeApplied: gates.scopeApplied,
      checks: gates.checks.map((g) => ({
        id: g.id, kind: g.kind, outcome: g.outcome, exitCode: g.exitCode,
        command: g.command, args: g.args, detail: trim(g.detail),
      })),
    },
    acceptance: {
      outcome: acceptance.outcome,
      contractStatus: acceptance.contractStatus,
      recorded: acceptance.recorded,
      attested: acceptance.attested,
      unattested: acceptance.unattested,
      attestedAt: acceptance.attestedAt,
      evaluation: acceptance.evaluation,
      detail: trim(acceptance.detail, 600),
    },
    handoff: { status: handoff.status, handoffId: handoff.handoffId, path: handoff.path, cycleId: handoff.cycleId, verified: handoff.verified, detail: trim(handoff.detail) },
    turn: { seq: persisted.seq, file: persisted.file, lines: report.turn.lines, digest: persisted.digest },
  };
  const receipt = writeTaskAttempt(dir, receiptDoc);
  report.receipt = { status: receipt.status, path: receipt.path, detail: receipt.detail, outcome: receiptDoc.outcome, exitCode: receiptDoc.exitCode };
  report.claims.push(claim('this attempt left exactly one receipt, and overwrote none',
    receipt.status === 'WRITTEN' ? OUTCOME.PASS : OUTCOME.CANNOT_DETERMINE,
    receipt.status === 'WRITTEN' ? `written once with open(path,'wx') at ${receipt.path}` : receipt.detail,
    receipt.firstAttempt ? { firstAttempt: receipt.firstAttempt } : null));
  if (receipt.status !== 'WRITTEN') report.ownerActions.push(`This attempt's verdict was NOT recorded: ${receipt.detail}`);

  /*
   * ⛔ A VERDICT NOBODY CAN READ IS NOT A VERDICT THAT WAS DELIVERED. A receipt that could not be
   * created degrades the run to CANNOT_DETERMINE — the same rule the turn record already follows
   * above — and never upgrades it, so this can only ever make the answer more cautious.
   */
  const outcome = rollup([withHandoff, receipt.status === 'WRITTEN' ? OUTCOME.PASS : OUTCOME.CANNOT_DETERMINE]);

  /*
   * ⛔ PRINTED ONLY ON A NON-PASS EXIT, AND NEVER AS A REASON — ONLY AS EVIDENCE. The bounded summary
   * above (`report.turn.stderrSummary`) is already on every run's JSON report; this is the same bounded
   * text reaching the terminal too, because the 2026-09-03 dogfood run's one explanatory line (D2) was
   * on the child's stderr and a FAIL summary that does not show it sends an owner to the transcript file
   * to find what the runner already read. A PASS prints nothing here: nobody needs to be pointed at
   * stderr for a run that needed no repair.
   */
  const stderrSummary = report.turn.stderrSummary;
  const stderrBlock = outcome !== OUTCOME.PASS && stderrSummary && stderrSummary.text
    ? [
      '',
      `  host stderr${stderrSummary.truncated ? ` (last ${stderrSummary.shownLines} of ${stderrSummary.totalLines} line(s), truncated)` : ''}:`,
      `    ${stderrSummary.text.split('\n').join('\n    ')}`,
    ]
    : [];

  const mark = { PASS: '✔', FAIL: '✘', CANNOT_DETERMINE: '?', NOT_APPLICABLE: '·' };
  return finish(outcome, [
    `  ${mark[outcome] || '?'} task ${task.id} (${task.title}) — ${outcome}`,
    `    session   : ${report.turn.sessionId || '(the host reported no id)'}`,
    `    transcript: ${persisted.file} (${report.turn.lines} line(s), verbatim)`,
    `    allowed   : ${tools.list.join(', ')} (${tools.source})`,
    `    derived   : posture ${derivation.posture.profile} (${derivation.posture.source}), projectType `
      + `${derivation.projectType.value || 'undeclared'} — ${derivation.list.length} entr${derivation.list.length === 1 ? 'y' : 'ies'} derivable`,
    `    route     : ${report.route.taskClass} → ${report.route.family}`
      + `${report.route.effectiveModel ? `/${report.route.effectiveModel}` : ' (host default)'}`
      + `${report.route.overridden ? ` [overrides routed ${report.route.model || '(none)'}]` : ''}`
      + ` — register ${report.route.register.source}`,
    ...(report.trust ? [
      '    ⚠️ trust  : this workspace has NOT been trusted, so the host discarded every `permissions.allow`',
      '                entry in .claude/settings.json. The session\'s tools came from --allowedTools above,',
      '                which the trust dialog does not gate. The host said, verbatim:',
      `                ${report.trust.verbatim}`,
    ] : []),
    '',
    `  gates, run OUT OF BAND in this process (${gates.outcome}):`,
    ...gates.checks.map((g) => `    ${mark[g.outcome] || '?'} ${g.outcome.padEnd(17)} ${g.id} — ${trim(g.detail, 160)}`),
    ...(gates.scopeNote ? [`    · scope: ${gates.scopeNote}`] : []),
    '',
    `  attestation (${acceptance.outcome}): ${acceptance.detail}`,
    ...acceptance.unattested.map((u) => `    ? unattested: ${u}`),
    '',
    `  handoff: ${handoff.status}${handoff.path ? ` at ${handoff.path}` : ''} — ${handoff.detail}`,
    `  receipt: ${receipt.status} at ${receipt.path}`,
    ...stderrBlock,
    '',
    '  ⛔ WHAT THIS DOES AND DOES NOT SAY. It says the gates above ran and reported what they reported,',
    `     and that the kernel ${acceptance.outcome === OUTCOME.PASS ? 'holds an attestation for every recorded criterion' : 'does NOT hold an attestation for every recorded criterion'}.`,
    `     It does NOT say any criterion was verified: all ${acceptance.recorded.length} are prose, every one is`,
    '     recorded CANNOT_DETERMINE as an evaluation, and an attestation is a claim, not a proof. Nothing',
    '     the session said about its own success was read.',
  ].join('\n'));
}

// =================================================================================================
// CLI
// =================================================================================================

function parseArgs(argv) {
  const out = {
    dir: null, taskId: null, dryRun: false, model: null, allowedTools: null, permissionMode: null,
    timeoutMs: null, kernelPath: null, claudePath: null, json: null,
    allowDangerouslySkipPermissions: false, help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[i += 1];
    if (a === '--dir') out.dir = next();
    else if (a === '--task') out.taskId = next();
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--model') out.model = next();
    else if (a === '--allowed-tools') out.allowedTools = String(next()).split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--permission-mode') out.permissionMode = next();
    else if (a === '--timeout') out.timeoutMs = Number(next());
    else if (a === '--kernel') out.kernelPath = next();
    else if (a === '--claude-path') out.claudePath = next();
    else if (a === '--json') out.json = next();
    else if (a === '--allow-dangerously-skip-permissions') out.allowDangerouslySkipPermissions = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`unknown option ${JSON.stringify(a)}`);
  }
  return out;
}

/**
 * The header, up to and not including the line that closes it.
 *
 * ⭐ FOUND BY ITS END RATHER THAN BY A LINE NUMBER. `canary.js` slices a fixed count, which is right
 * until the header grows by one line and the help output starts spilling `'use strict';` at the
 * reader. `runner.test.mjs` also checks this text against `parseArgs` in both directions, so an
 * option cannot be documented without being accepted or accepted without being documented.
 */
function helpText() {
  const lines = fs.readFileSync(__filename, 'utf8').split('\n');
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '*/');
  return lines.slice(1, end > 0 ? end : 80).join('\n');
}

async function main(argv) {
  let opts;
  try { opts = parseArgs(argv); } catch (e) {
    process.stderr.write(`  ${e.message}\n  Run with --help for the option list.\n`);
    return exitCodeFor(OUTCOME.CANNOT_DETERMINE);
  }
  if (opts.help) {
    process.stdout.write(`${helpText()}\n`);
    return 0;
  }

  const report = await runTask({
    dir: opts.dir || process.env.CLAUDE_PROJECT_DIR || process.cwd(),
    taskId: opts.taskId,
    dryRun: opts.dryRun,
    model: opts.model,
    allowedTools: opts.allowedTools,
    permissionMode: opts.permissionMode,
    kernelPath: opts.kernelPath,
    claudePath: opts.claudePath,
    allowDangerouslySkipPermissions: opts.allowDangerouslySkipPermissions,
    ...(Number.isFinite(opts.timeoutMs) && opts.timeoutMs !== null ? { timeoutMs: opts.timeoutMs } : {}),
  });

  if (opts.json) {
    const w = io.writeAtomicJSON(opts.json, report);
    if (!w.ok) process.stderr.write(`  the report could not be written to ${opts.json}: ${w.detail}\n`);
  }

  process.stdout.write(`RespawnPack · claude-code/task-runner\n${report.summary}\n\n  → ${report.outcome}\n`);
  return report.exitCode;
}

module.exports = {
  QUEUE_REL, STATE_REL, RUNTIME_TASKS_REL, RUNTIME_REL, CONTRACT_REL, DELEGATIONS_REL, CONFIG_REL,
  FORBIDDEN_ARGS, GATE_TIMEOUT_MS, DEFAULT_ALLOWED_TOOLS, TRUST_REFUSAL_PHRASE,
  KNOWN_PROJECT_TYPES, LIGHT_POSTURE_ADDITIONS, OPS_INFRA_ADDITIONS, NODE_APP_ADDITIONS,
  deriveAllowedTools, resolveToolDerivation, firstUnderivedTool,
  resolveAllowedTools, forbiddenToolReason, firstForbiddenTool, allowedToolsIn, detectTrustRefusal,
  TASK_SESSION_AVAILABILITY, DEFAULT_TASK_CLASS,
  resolveCapabilityRegisterPath, loadCapabilityRegister, resolveTaskRoute,
  TASK_ATTEMPT_KIND, TASK_ATTEMPT_SCHEMA_VERSION,
  WITHHELD_LINE, REGENERATE_LINE, stateWarnLine,
  STDERR_SUMMARY_MAX_LINES, STDERR_SUMMARY_MAX_CHARS, boundStderr,
  validateTaskQueue, loadTaskQueue, selectTask, composePrompt,
  resolveKernel, buildContractArgs, realKernel,
  assertArgvIsSafe, turnsDirFor, nextTurnSeq, persistTurn,
  resolveBin, runGateProcess, runSavepointGate, planQualityGate, runQualityGate, runGates,
  foldCriterion, readAttestation, writeHandoff, receiptPathFor, writeTaskAttempt,
  runTask, parseArgs, helpText, main,
};

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code)).catch((e) => {
    process.stderr.write(`  → CANNOT_DETERMINE: the task runner itself threw — ${(e && e.stack) || e}\n`);
    process.exit(exitCodeFor(OUTCOME.CANNOT_DETERMINE));
  });
}
