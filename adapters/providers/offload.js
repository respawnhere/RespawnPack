/*
 * RespawnPack · adapters/providers/offload.js — carry ONE bounded, hookless unit of work to whichever
 * model family the evidence and this machine's reachability agree on, and leave a receipt saying which.
 *
 * Spec: the class audit Class G, "The offload path" and "Per-family prompting practice";
 * the second run's task list, P4-M-4. Anti-drift items 52 (a credential is read from the environment at call time and
 * never written) and 54 (hook-bearing work never leaves the Claude family).
 *
 *   node adapters/providers/offload.js --dir <project> --class <taskClass> --in <file>
 *        [--out <file>] [--family <f>] [--model <m>] [--dry-run]
 *
 * ⛔ AN OFFLOAD IS NOT A SESSION. Anti-drift item 54 draws the line and this file is the far side of it:
 * a task session is a Claude Code session with the pack's hooks armed, and an offload is ONE turn, with
 * no tools, no follow-up and no state left behind but a receipt. That is why `requiresHooks` defaults to
 * false here and why the command line has no flag to set it: work that needs the hooks is not offloaded
 * at all, it is run as a session by the task runner. The option exists on `runOffload()` because the
 * routing policy takes it, and because a caller that DOES pass it must get Claude and nothing else,
 * which is a property worth being able to test rather than assert.
 *
 * ⛔ THE REGISTER IS READ, NEVER WRITTEN, AND WHICH COPY WAS READ IS ON THE RECEIPT. A target that has
 * the standards installed has its own `docs/reference/models/capability-register.json`, which may be
 * older or newer than this pack's; a target that has none falls back to this pack's own
 * `spine/reference/models/capability-register.json`. Those are different documents with different `asOf`
 * dates, and a receipt that did not say which one decided the route would be unauditable six months
 * later. `register.source` and `register.path` say it in every case.
 *
 * ⛔ AVAILABILITY IS GATHERED HERE AND HANDED TO THE POLICY AS DATA. `core/policy/routing.js` probes
 * nothing and opens nothing; this file runs the three cheap probes and passes the answers in. A family
 * the probe could not reach is SKIPPED with the probe's own words on the receipt, never silently
 * dropped and never promoted to a choice because nothing else looked better on paper.
 *
 * ⛔ A FAILED TURN IS CANNOT_DETERMINE AT EXIT 2, NEVER FAIL, AND NEVER A SILENT SECOND ATTEMPT. A
 * provider that would not answer says nothing about whether the work could be done; it says this
 * provider did not do it. Retrying on another family would spend a second budget and produce an answer
 * whose provenance the operator never chose, so this path runs exactly one turn and stops. `retry` on
 * the receipt records that in words, with the fields a future fallback would have to fill in, so that
 * adding one is a visible change to the record rather than an invisible change in behaviour.
 *
 * ⛔ NO CREDENTIAL PASSES THROUGH THIS FILE (item 52). Nothing here reads `env[apiKeyEnv]`, holds a key
 * in a local, or writes one anywhere. The environment MAP is handed down to
 * `adapters/openai-compatible/client.js`, which reads the variable inside the request that needs it and
 * scrubs its own results before they come back. The receipt carries digests, a route, usage and
 * durations, and it carries neither the composed prompt nor the raw exchange, so there is no field for a
 * credential a hostile host echoed back to travel in.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const PACK_ROOT = path.join(__dirname, '..', '..');
const core = require(path.join(PACK_ROOT, 'core', 'index.js'));
const envelopes = require('./envelopes.js');
const turnClaude = require('./turn-claude.js');
const turnCodex = require('./turn-codex.js');
const turnOpenAICompatible = require('./turn-openai-compatible.js');

const { io, routing, failures } = core;
const { OUTCOME, exitCodeFor } = failures;

/**
 * This receipt's OWN version, owned here rather than by the kernel's docs/derived/* number. Every
 * offload writes its own immutable file, so older shapes stay on disk and a reader needs a version to
 * discriminate them. `kernel/schema.test.mjs` pins the schema's const against this constant.
 */
const OFFLOAD_RECEIPT_SCHEMA_VERSION = '1.0.0';

const CONFIG_NAME = 'respawnpack.config.json';
const RUNTIME_REL = path.join('.respawnpack', 'runtime');
const TARGET_REGISTER_REL = path.join('docs', 'reference', 'models', 'capability-register.json');
const PACK_REGISTER_REL = path.join('spine', 'reference', 'models', 'capability-register.json');

/** Which turn module speaks for which register family. A family with no entry cannot be offloaded to. */
const PROVIDERS = {
  anthropic: turnClaude.PROVIDER,
  openai: turnCodex.PROVIDER,
  minimax: turnOpenAICompatible.PROVIDER,
};

/** The `kind` a receipt carries when routing itself could not settle on a model, so no turn was run. */
const NO_ROUTE = 'NO_ROUTE';
/** The `kind` a receipt carries when a family routed to has no turn module in this pack. */
const NO_PROVIDER = 'NO_PROVIDER';

const nowISO = () => new Date().toISOString();
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// --- the command line -----------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { dir: null, taskClass: null, in: null, out: null, family: null, model: null, dryRun: false, help: false, unknown: [] };
  const list = Array.isArray(argv) ? argv.slice() : [];
  while (list.length) {
    const a = list.shift();
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--dir') out.dir = list.shift() || null;
    else if (a === '--class') out.taskClass = list.shift() || null;
    else if (a === '--in') out.in = list.shift() || null;
    else if (a === '--out') out.out = list.shift() || null;
    else if (a === '--family') out.family = list.shift() || null;
    else if (a === '--model') out.model = list.shift() || null;
    else out.unknown.push(a);
  }
  return out;
}

function helpText() {
  return [
    'RespawnPack offload — one bounded, hookless unit of work on the model the evidence favours.',
    '',
    '  node adapters/providers/offload.js --dir <project> --class <taskClass> --in <file> \\',
    '       [--out <file>] [--family <f>] [--model <m>] [--dry-run]',
    '',
    `  --class    one of: ${routing.TASK_CLASSES.join(', ')}`,
    '  --in       the file whose contents are the unit of work. Read, never written.',
    '  --out      where the answer is written. Without it the answer goes to stdout.',
    '  --family   consider only this register family. The others are recorded as skipped, with the reason.',
    '  --model    prefer this model id. It wins when it is available and rated; otherwise ranking decides.',
    '  --dry-run  print the route and the composed prompt. Spawns nothing, writes nothing.',
    '',
    'Exit codes: 0 the turn produced an answer; 2 it could not be determined (no route, an unreachable',
    'provider, a turn that failed, or a receipt id already taken). Never 1: a provider that would not',
    'answer is not a finding about the work.',
    '',
    'A receipt lands at <project>/.respawnpack/runtime/offload-<id>.json, created with O_EXCL and never',
    'replaced. The id is derived from the input and the task class, so re-running the same unit of work',
    'against the same project is refused rather than silently recorded twice.',
  ].join('\n');
}

// --- the register ----------------------------------------------------------------------------------

/**
 * Read the capability register: the target's installed standards first, this pack's own copy second.
 *
 * ⛔ THE ORDER IS THE POINT. A project that installed the standards has a register its own owner may
 * have edited or upgraded, and routing against the pack's copy while the project holds a different one
 * would decide from a document nobody in that project has read. The fallback exists because the models
 * subtree is not placed by the installer yet, so most targets today legitimately have none.
 *
 * @returns {{ok:true, doc, source:'target'|'pack', path:string, asOf:string|null}
 *          |{ok:false, why:string, tried:string[]}}
 */
function readRegister({ dir, packRoot = PACK_ROOT } = {}) {
  const candidates = [
    { source: 'target', file: path.join(dir, TARGET_REGISTER_REL) },
    { source: 'pack', file: path.join(packRoot, PACK_REGISTER_REL) },
  ];
  const tried = [];
  for (const c of candidates) {
    // The classifying reader, so ABSENT, UNREADABLE and MALFORMED reach the caller as three answers.
    const r = io.readJSONClassified(c.file);
    if (r.status === 'OK') {
      return { ok: true, doc: r.doc, source: c.source, path: c.file, asOf: (isObj(r.doc) && typeof r.doc.asOf === 'string') ? r.doc.asOf : null };
    }
    if (r.status === 'ABSENT') { tried.push(`${c.file}: absent`); continue; }
    // A register that exists and cannot be read is NOT skipped over: reading past a corrupt document to
    // a different one would route from a copy the operator did not mean to use.
    return { ok: false, why: `the ${c.source} capability register at ${c.file} could not be read (${r.status}: ${r.detail})`, tried: [...tried, `${c.file}: ${r.status}`] };
  }
  return { ok: false, why: 'no capability register was found in the target or in this pack', tried };
}

/** The project's declared provider blocks, or an empty map. An absent config is a legitimate state. */
function readProviders({ dir } = {}) {
  const r = io.readJSONClassified(path.join(dir, CONFIG_NAME));
  if (r.status !== 'OK' || !isObj(r.doc) || !isObj(r.doc.providers)) return {};
  return r.doc.providers;
}

/**
 * The provider block for one register family: the block named after the family, else the block whose
 * `apiKeyEnv` is the variable the register says that family authenticates with.
 */
function providerBlockFor({ providers, register, family }) {
  if (isObj(providers) && isObj(providers[family])) return { name: family, block: providers[family] };
  const fam = (isObj(register) && Array.isArray(register.families) ? register.families : []).find((f) => f && f.id === family);
  const envVar = fam && isObj(fam.access) ? fam.access.envVar : null;
  if (!envVar) return { name: family, block: null };
  for (const [name, block] of Object.entries(providers || {})) {
    if (isObj(block) && block.apiKeyEnv === envVar) return { name, block };
  }
  return { name: family, block: null };
}

// --- availability ----------------------------------------------------------------------------------

/**
 * Run the three cheap probes and shape them the way `routing.route()` reads them.
 *
 * ⛔ EVERY FAMILY THE REGISTER DECLARES IS ASKED ABOUT, INCLUDING ONE THIS PACK HAS NO PROVIDER FOR.
 * A family with no turn module is reported unavailable with that as the reason rather than left out of
 * the map, because `route()` treats a family it heard nothing about exactly as it treats an unreachable
 * one, and a reader of the receipt deserves the difference between "we cannot reach it" and "we have
 * not written the adapter".
 *
 * @param {{register:object, dir:string, providers:object, env:object, deps:object}} opts
 * @returns {Promise<{available:object, rows:Array<{family:string, ok:boolean, why:string}>}>}
 */
async function buildAvailability({ register, dir, providers, env = process.env, deps = {} } = {}) {
  const families = (isObj(register) && Array.isArray(register.families) ? register.families : []).map((f) => f && f.id).filter(Boolean);
  const rows = [];
  for (const family of families) {
    let r;
    if (family === turnClaude.FAMILY) {
      r = turnClaude.probe({ cli: deps.claudeCli, env });
    } else if (family === turnCodex.FAMILY) {
      r = await turnCodex.probe({
        resolveCodexJs: deps.resolveCodexJs,
        connect: deps.codexConnect,
        env,
        cwd: dir,
        handshake: deps.codexHandshake !== false,
      });
    } else if (PROVIDERS[family] === turnOpenAICompatible.PROVIDER) {
      const { name, block } = providerBlockFor({ providers, register, family });
      r = turnOpenAICompatible.probe({ name, block, env, fetchImpl: deps.fetchImpl });
    } else {
      r = { ok: false, why: `this pack has no provider adapter for the register family "${family}", so it cannot be reached from here at all`, detail: null };
    }
    rows.push({ family, ok: Boolean(r.ok), why: r.why });
  }
  const available = Object.fromEntries(rows.map((row) => [row.family, { ok: row.ok, why: row.why }]));
  return { available, rows };
}

// --- the receipt ----------------------------------------------------------------------------------

/**
 * The receipt id, derived from the unit of work rather than supplied.
 *
 * ⛔ THIS IS WHAT MAKES "NEVER OVERWRITTEN" MEAN SOMETHING. A random id would make every run a new file
 * and the exclusivity a formality. Deriving it from the input digest and the task class means the SAME
 * unit of work against the SAME project lands on the same path, so a second run is refused by O_EXCL
 * rather than recorded twice with two different answers and no way to tell which one the operator acted
 * on (anti-drift item 40).
 */
const receiptId = (inputDigest, taskClass) => `${taskClass}-${io.digest(`${inputDigest}\n${taskClass}`).slice(0, 12)}`;

const receiptPathFor = (dir, id) => path.join(dir, RUNTIME_REL, `offload-${id}.json`);

// --- the run --------------------------------------------------------------------------------------

/**
 * One offload, end to end.
 *
 * @param {{dir:string, taskClass:string, inFile:string, outFile?:string|null, family?:string|null,
 *          model?:string|null, dryRun?:boolean, requiresHooks?:boolean, env?:object, deps?:object,
 *          packRoot?:string}} opts
 * @returns {Promise<{outcome:string, exitCode:number, summary:string, receipt:object|null,
 *                    receiptPath:string|null, receiptWritten:boolean, route:object|null,
 *                    composed:object|null, text:string|null}>}
 */
async function runOffload({
  dir,
  taskClass,
  inFile,
  outFile = null,
  family = null,
  model = null,
  dryRun = false,
  requiresHooks = false,
  env = process.env,
  deps = {},
  packRoot = PACK_ROOT,
} = {}) {
  const startedAt = Date.now();
  const stop = (outcome, summary, extra = {}) => ({
    outcome, exitCode: exitCodeFor(outcome), summary,
    receipt: null, receiptPath: null, receiptWritten: false, route: null, composed: null, text: null,
    ...extra,
  });

  // --- the arguments, checked before anything is read or spawned ---
  if (typeof dir !== 'string' || !dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    return stop(OUTCOME.CANNOT_DETERMINE, `the project directory does not exist: ${dir}`);
  }
  if (!routing.TASK_CLASSES.includes(taskClass)) {
    return stop(OUTCOME.CANNOT_DETERMINE, `unknown task class ${JSON.stringify(taskClass)} — one of: ${routing.TASK_CLASSES.join(', ')}`);
  }
  const inRead = io.readTextClassified(inFile);
  if (inRead.status !== 'OK') {
    return stop(OUTCOME.CANNOT_DETERMINE, `the input file could not be read (${inRead.status}: ${inRead.detail}): ${inFile}`);
  }
  if (!inRead.text.trim()) {
    return stop(OUTCOME.CANNOT_DETERMINE, `the input file is empty, so there is no unit of work to carry: ${inFile}`);
  }

  const inputDigest = inRead.digest;
  const id = receiptId(inputDigest, taskClass);
  const receiptPath = receiptPathFor(dir, id);

  /*
   * ⛔ CHECKED BEFORE THE TURN, AND AGAIN BY O_EXCL AFTER IT. Checking first means a repeat run does not
   * spend a budget it was never going to be allowed to record; the exclusive create is what actually
   * holds against a concurrent one. Neither is redundant: the first is courtesy, the second is the rule.
   */
  if (!dryRun && fs.existsSync(receiptPath)) {
    return stop(OUTCOME.CANNOT_DETERMINE,
      `a receipt for this unit of work already exists and is never replaced: ${receiptPath}. `
      + 'The id is derived from the input and the task class, so this exact work has already been offloaded against this project. '
      + 'Read that receipt, or change the input, or move the receipt aside deliberately.');
  }

  // --- the register ---
  const reg = readRegister({ dir, packRoot });
  if (!reg.ok) {
    return stop(OUTCOME.CANNOT_DETERMINE, `${reg.why}. Tried: ${reg.tried.join('; ')}`);
  }

  // --- availability, then the route ---
  const providers = readProviders({ dir });
  const { available, rows } = await buildAvailability({ register: reg.doc, dir, providers, env, deps });

  /*
   * `--family` narrows the CANDIDATE SET rather than expressing a preference, and it does it by marking
   * the other families unavailable — so `route()` ranks inside the named family with its own rules, and
   * the families that were not considered appear in `route.skipped` with the operator's own restriction
   * as the reason. A second ranking implementation here is exactly what that avoids.
   */
  const forRoute = family
    ? Object.fromEntries(Object.entries(available).map(([f, a]) => [f, f === family ? a : {
      ok: false,
      why: `the caller restricted this offload to the family "${family}" with --family, so ${f} was not considered${a.ok ? '' : `; it was also unavailable: ${a.why}`}`,
    }]))
    : available;

  const route = routing.route(taskClass, reg.doc, forRoute, { requiresHooks, prefer: model || null });
  const composed = envelopes.compose({ family: route.family, taskClass, input: inRead.text });

  // --- the dry run stops here, having spawned nothing and written nothing ---
  if (dryRun) {
    return {
      outcome: OUTCOME.NOT_APPLICABLE,
      exitCode: exitCodeFor(OUTCOME.NOT_APPLICABLE),
      summary: `dry run: ${route.family}${route.model ? `/${route.model}` : ' (no model)'} for ${taskClass}; nothing was spawned and nothing was written`,
      receipt: null, receiptPath, receiptWritten: false,
      route, composed, text: null,
      register: { source: reg.source, path: reg.path, asOf: reg.asOf },
      availability: rows,
      id, taskClass,
    };
  }

  // --- the turn ---
  const providerName = PROVIDERS[route.family] || null;
  let turn;
  if (!route.model) {
    turn = { ok: false, text: null, usage: { input: null, output: null }, model: null, kind: NO_ROUTE, detail: route.why, durationMs: 0 };
  } else if (!providerName) {
    turn = { ok: false, text: null, usage: { input: null, output: null }, model: route.model, kind: NO_PROVIDER, detail: `this pack has no turn module for the register family "${route.family}"`, durationMs: 0 };
  } else if (providerName === turnClaude.PROVIDER) {
    turn = await turnClaude.runTurn({ prompt: composed.text, model: route.model, cwd: dir, cli: deps.claudeCli, env, timeoutMs: deps.timeoutMs });
  } else if (providerName === turnCodex.PROVIDER) {
    turn = await turnCodex.runTurn({
      prompt: composed.text, model: route.model, cwd: dir, env,
      resolveCodexJs: deps.resolveCodexJs, connect: deps.codexConnect, timeoutMs: deps.timeoutMs,
    });
  } else {
    const { name, block } = providerBlockFor({ providers, register: reg.doc, family: route.family });
    turn = await turnOpenAICompatible.runTurn({
      prompt: composed.prompt, system: composed.system, model: route.model,
      name, block, env, fetchImpl: deps.fetchImpl, timeoutMs: deps.timeoutMs,
    });
  }

  // --- the answer, written before the receipt that describes it ---
  const text = turn.ok ? turn.text : null;
  const outputDigest = text === null ? null : io.digest(text);
  let outWritten = null;
  if (turn.ok && outFile) {
    const w = io.writeAtomicText(outFile, text);
    outWritten = w.ok ? outFile : null;
    if (!w.ok) turn = { ...turn, ok: false, kind: 'OUTPUT_WRITE', detail: `the turn produced an answer and it could not be written to ${outFile}: ${w.detail}` };
  }

  const outcome = turn.ok ? OUTCOME.PASS : OUTCOME.CANNOT_DETERMINE;
  const doc = {
    kind: 'respawnpack-offload-receipt',
    schemaVersion: OFFLOAD_RECEIPT_SCHEMA_VERSION,
    at: nowISO(),
    id,
    taskClass,
    outcome,
    exitCode: exitCodeFor(outcome),
    /*
     * The TARGET's copy is recorded relative to the project, because that is where a reader of this
     * receipt will look for it. The PACK's copy is recorded absolute, because the useful fact there is
     * WHICH checkout decided, and a relative path to a directory outside the project answers nothing.
     * Doing it by source rather than by `path.relative` alone also keeps the two shapes stable: across
     * drives, `path.relative` silently returns an absolute path anyway.
     */
    register: {
      source: reg.source,
      path: (reg.source === 'target' ? path.relative(dir, reg.path) : path.resolve(reg.path)).split(path.sep).join('/'),
      asOf: reg.asOf,
    },
    route: {
      family: route.family,
      model: route.model,
      rating: route.rating,
      why: route.why,
      asOf: route.asOf,
      practice: route.practice,
      alternatives: route.alternatives.map((a) => ({ family: a.family, model: a.model, rating: a.rating, why: a.why })),
      skipped: route.skipped.map((s) => ({ family: s.family, why: s.why })),
    },
    envelope: { name: composed.envelope, fallback: composed.fallback, practice: composed.practice, why: composed.why },
    /*
     * `name` is NULL when no turn was attempted at all. Naming the adapter that WOULD have carried a
     * route that never happened would read, to anyone scanning receipts, as a provider that was tried
     * and said nothing.
     */
    provider: { name: route.model ? providerName : null, family: route.family, model: turn.model || route.model, kind: turn.ok ? null : turn.kind, detail: turn.ok ? null : String(turn.detail || '').slice(0, 600) },
    availability: rows.map((r) => ({ family: r.family, ok: r.ok, why: r.why })),
    /*
     * ⛔ RECORDED IN WORDS, NOT LEFT TO SILENCE. Nothing here retries on a second provider. The fields a
     * fallback would need are present and empty, so implementing one means filling them in, and a
     * receipt that says `attempted: false` is a statement rather than the absence of a statement.
     */
    retry: {
      attempted: false,
      from: null,
      to: null,
      why: 'this path runs exactly one turn on the routed provider and stops. A second attempt on another family would spend a budget the operator did not choose and produce an answer whose provenance is not the one this receipt records.',
    },
    usage: { input: turn.usage ? turn.usage.input : null, output: turn.usage ? turn.usage.output : null },
    durationMs: Date.now() - startedAt,
    input: { path: path.resolve(inFile).split(path.sep).join('/'), bytes: Buffer.byteLength(inRead.text, 'utf8'), digest: inputDigest },
    output: {
      path: outWritten ? path.resolve(outWritten).split(path.sep).join('/') : null,
      bytes: text === null ? null : Buffer.byteLength(text, 'utf8'),
      digest: outputDigest,
    },
  };

  // ⛔ O_EXCL. Exactly one caller creates this file and every other learns so from EEXIST, never by
  // reading a half-written one and never by replacing a record of a different run (anti-drift item 40).
  const created = io.createExclusive(receiptPath, `${JSON.stringify(doc, null, 2)}\n`);
  if (created.status !== 'CREATED') {
    return {
      outcome: OUTCOME.CANNOT_DETERMINE,
      exitCode: exitCodeFor(OUTCOME.CANNOT_DETERMINE),
      summary: `the turn ran and its receipt could not be created at ${receiptPath} (${created.status}: ${created.detail}). `
        + 'The receipt is never replaced, so the record of the earlier run stands and this one is unrecorded.',
      receipt: doc, receiptPath, receiptWritten: false, route, composed, text,
    };
  }

  return {
    outcome,
    exitCode: doc.exitCode,
    summary: turn.ok
      ? `${route.family}/${route.model} answered ${doc.output.bytes} byte(s) for ${taskClass}; receipt ${receiptPath}`
      : `${route.family}${route.model ? `/${route.model}` : ''} did not produce an answer (${turn.kind}); receipt ${receiptPath}`,
    receipt: doc, receiptPath, receiptWritten: true, route, composed, text,
  };
}

// --- the CLI --------------------------------------------------------------------------------------

function printDryRun(result, log = console.log) {
  log('--- route ---');
  log(`  register   ${result.register.source} (${result.register.path}), asOf ${result.register.asOf}`);
  log(`  class      ${result.taskClass}`);
  log(`  family     ${result.route.family}`);
  log(`  model      ${result.route.model === null ? '(none)' : result.route.model}`);
  log(`  rating     ${result.route.rating}`);
  log(`  why        ${result.route.why}`);
  log(`  practice   ${result.route.practice || '(none)'}`);
  log(`  envelope   ${result.composed.envelope}${result.composed.fallback ? ' (the fallback)' : ''}`);
  for (const s of result.route.skipped) log(`  skipped    ${s.family}: ${s.why}`);
  log(`  receipt    ${result.receiptPath} (not written: this is a dry run)`);
  log('--- composed prompt ---');
  log(result.composed.text);
}

/**
 * The command line.
 *
 * ⭐ THE SECOND PARAMETER IS FOR THE SUITE, AND IT DEFAULTS TO NOTHING. The redaction fence has to be
 * checked on real STDOUT and real STDERR, not only on the receipt, and a suite that could only reach
 * `runOffload()` would be proving the fence on the one surface that never prints. `deps` and `env` are
 * threaded through so the offline suite can drive this exact function; the CLI itself passes neither, so
 * an operator's invocation reaches the real probes and the real providers.
 */
async function main(argv = process.argv.slice(2), { deps = {}, env = process.env } = {}) {
  const args = parseArgs(argv);
  if (args.help || !args.dir || !args.taskClass || !args.in) {
    console.log(helpText());
    if (args.help) return 0;
    console.error('offload: --dir, --class and --in are all required.');
    return exitCodeFor(OUTCOME.CANNOT_DETERMINE);
  }
  if (args.unknown.length) {
    console.error(`offload: unrecognised argument(s): ${args.unknown.join(' ')}`);
    return exitCodeFor(OUTCOME.CANNOT_DETERMINE);
  }

  const result = await runOffload({
    dir: args.dir, taskClass: args.taskClass, inFile: args.in, outFile: args.out,
    family: args.family, model: args.model, dryRun: args.dryRun, deps, env,
  });

  if (args.dryRun && result.route) { printDryRun(result); return result.exitCode; }
  if (result.text !== null && !args.out) console.log(result.text);
  (result.exitCode === 0 ? console.log : console.error)(result.summary);
  return result.exitCode;
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }).catch((e) => {
    console.error(`offload: ${e && e.stack ? e.stack : e}`);
    process.exitCode = exitCodeFor(OUTCOME.CANNOT_DETERMINE);
  });
}

module.exports = {
  OFFLOAD_RECEIPT_SCHEMA_VERSION, CONFIG_NAME, RUNTIME_REL, PROVIDERS, NO_ROUTE, NO_PROVIDER,
  TARGET_REGISTER_REL, PACK_REGISTER_REL,
  parseArgs, helpText, readRegister, readProviders, providerBlockFor, buildAvailability,
  receiptId, receiptPathFor, runOffload, printDryRun, main,
};
