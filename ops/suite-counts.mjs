/*
 * RespawnPack · ops/suite-counts.mjs — run the core suites and EXTRACT their counts, refusing to guess.
 *
 * ⛔ WHY EXTRACTION IS STRICT. Every release document in this repository has, at some point, carried a
 * suite total that was true of a different commit ("591 was true of the commit that measured it").
 * This runner exists so a total can only be produced by parsing each suite's own summary at the
 * commit being measured:
 *
 *   · a suite whose output lacks any of `# tests` / `# pass` / `# fail` is a HARD FAILURE — a count
 *     that cannot be parsed is not a count, and defaulting it to zero would spell PASS;
 *   · `pass + fail == tests` is required per suite — an arithmetic that does not close is evidence
 *     of a truncated or interleaved run, not a rounding detail;
 *   · a nonzero suite exit is a failure even if the summary parses green.
 *
 * TIERS. `--tier full` (the default) runs every suite in `SUITES` — the release gate, mandatory at
 * every phase boundary, and byte-for-byte what this file always did. `--tier fast` runs `FAST`, which
 * is `SUITES` with the suites named in `EXCLUDED` taken out, each carrying its own reason (too slow for
 * a two-minute budget, or exercising a host that is not in use) — so the fast list is derived, never a
 * second hand-typed array, and cannot drift out of sync with `SUITES`. Extraction is exactly as strict
 * in both tiers: a suite that will not parse is a HARD FAILURE whichever tier ran it. The fast tier is
 * a task-session convenience for iterating quickly; nothing in this file lets it stand in for
 * `--tier full` at a release or phase boundary.
 *
 *   node ops/suite-counts.mjs [--tier fast|full] [--json <file>]
 *
 * Exit: 0 every suite parsed, arithmetic closed, zero failures · 1 anything else, including an
 * unrecognized --tier value, refused before any suite runs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PACK = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// The core suites — the v0.2.0 baseline, plus v0.3's host-neutral rollover core, its conformance
// traces, and the per-host adapter suites layered on top of it. A suite listed here is a release
// gate; one missing from here can go red without anything noticing, which is why additions land in
// the same commit as the tree they test. The array below IS the count — read it, never restate a
// number here, because this comment is exactly the kind of hand-carried figure that rots the moment
// the next suite is added and nobody remembers to update the prose beside it.
const SUITES = [
  'hooks/hooks.test.mjs',
  'kernel/kernel.test.mjs',
  'kernel/schema.test.mjs',
  'kernel/concurrency.test.mjs',
  'kernel/reconcile.test.mjs',
  // The markdown renderer behind the browsable record (task O-4a). Goldens only: it renders committed
  // fixture documents, the three project archetypes' own markdown, this pack's spine templates and a
  // real generated block, and compares whole files. No network, no install, no server. Milliseconds.
  'kernel/site.test.mjs',
  'install/install.test.mjs',
  'install/uninstall.test.mjs',
  'skills/skills.test.mjs',
  'counts-fence.test.mjs',
  'library/library.test.mjs',
  // The release smoke's PROFILE contract. Not the smoke itself — that installs the product once per
  // posture and is its own gate; this is `ops/_smoke-profiles.mjs`'s verdicts driven through their
  // failing states, plus the fence holding `release/build-public.sh`'s DEV_ONLY split. Milliseconds.
  'ops/release-smoke.test.mjs',
  // The shared project-fixture helper (task F-0): the four project archetypes every later task's
  // fixtures materialise through, proved deterministic and checked against install.js's own
  // projectType vocabulary. Milliseconds — it writes small trees to a temp dir, nothing installed.
  'ops/project-fixtures.test.mjs',
  'core/core.test.mjs',
  'conformance/conformance.test.mjs',
  'adapters/codex/codex-hooks.test.mjs',
  'adapters/claude-code/sdk-supervisor/stream.test.mjs',
  'adapters/claude-code/sdk-supervisor/supervisor.test.mjs',
  'adapters/claude-code/task-runner/runner.test.mjs',
  'adapters/claude-code/task-runner/canary.test.mjs',
  'adapters/codex/app-server/rpc.test.mjs',
  'adapters/codex/app-server/supervisor.test.mjs',
  // The generic OpenAI-compatible provider client and its probe (task P4-M-3). In the fast tier, and
  // deliberately NOT in EXCLUDED as a "host not in use": every test injects its own `fetch` and its own
  // environment, the fixture base URL is `api.example.invalid`, and the suite is unchanged with the
  // network unplugged. Measured in milliseconds. Nothing here reaches a provider, so there is no host
  // whose absence could make it irrelevant.
  'adapters/openai-compatible/client.test.mjs',
  // The offload path across the three providers (task P4-M-4). In the fast tier, and deliberately NOT in
  // EXCLUDED as a "host not in use": no real `claude` and no real `codex` is spawned, `fetch` is injected,
  // and the fixture base URL is `api.example.invalid`. It materialises two project archetypes per test
  // through ops/_project-fixtures.mjs with git off, so it is small temp trees and no child processes.
  // Measured in single-digit seconds.
  'adapters/providers/offload.test.mjs',
  'adapters/claude-code/interactive/interactive.test.mjs',
  'adapters/claude-code/statusline/statusline.test.mjs',
  'license-contract.test.mjs',
];

// The fast tier's suites, expressed as an EXCLUSION from SUITES rather than a second hand-typed list,
// so the two can never quietly drift apart the way independently maintained arrays eventually do.
// Every excluded suite carries its own reason: either it is too slow for the fast tier's two-minute
// budget (measured per-suite in the core-adapters-ops audit §4; re-measured on each machine this runs on), or
// it exercises a host adapter that is not in use here. Anti-drift item 49's four fence suites, checked
// in deriveFast() below, may never end up in this list.
//
// `adapters/claude-code/task-runner/runner.test.mjs` is deliberately NOT here: it is fixture-driven
// against the sdk-supervisor's own recorded streams and needs no live CLI. It runs in ~24s on this
// machine, up from ~8s when P5-T-16b added the out-of-band gates — each of those tests now drives a
// real `git init` fixture, a real `contract delegate`, a real `contract complete --met` and real gate
// child processes, which is the cost of not faking the kernel. Still inside the two-minute budget, and
// the number is recorded here so the next person to add a test knows how much of it is already spent.
//
// `adapters/claude-code/task-runner/canary.test.mjs` is the same call for the same reason: fixture-driven
// against the same recorded streams, no live CLI, the kernel not faked (a real `git init`, `contract
// delegate` and `contract complete --met` per test, plus a real minimal-kernel file copy). Measured
// ~7s on this machine for 19 tests.
const EXCLUDED = [
  { suite: 'hooks/hooks.test.mjs', reason: 'spawns hundreds of real child processes (measured ~279s) — too slow for the two-minute fast-tier budget; run explicitly for hooks/* work instead' },
  { suite: 'kernel/kernel.test.mjs', reason: 'too slow for the two-minute fast-tier budget (measured ~74s); run explicitly for kernel/* work instead' },
  { suite: 'install/install.test.mjs', reason: 'too slow for the two-minute fast-tier budget (measured ~151s); run explicitly for install/* work instead' },
  { suite: 'install/uninstall.test.mjs', reason: 'paired with install/install.test.mjs as the install/* owning suite; run explicitly for install/* work rather than in every fast-tier run' },
  { suite: 'adapters/codex/codex-hooks.test.mjs', reason: 'exercises the Codex host, not in use on this installation — excluded for relevance, not speed' },
  { suite: 'adapters/codex/app-server/rpc.test.mjs', reason: 'exercises the Codex host, not in use on this installation — excluded for relevance, not speed' },
  { suite: 'adapters/codex/app-server/supervisor.test.mjs', reason: 'exercises the Codex host, not in use on this installation — excluded for relevance, not speed' },
];

// Anti-drift item 49: these four fence suites stay green on every count-changing task and must never
// silently fall out of the fast tier through a future EXCLUDED edit. Checked here, not just asserted
// in a comment, so a bad edit fails loudly the next time this file runs at all.
const MUST_STAY_FAST = ['counts-fence.test.mjs', 'skills/skills.test.mjs', 'library/library.test.mjs', 'license-contract.test.mjs'];

function deriveFast() {
  const inSuites = new Set(SUITES);
  const excludedNames = new Set();
  for (const { suite, reason } of EXCLUDED) {
    if (!inSuites.has(suite)) throw new Error(`ops/suite-counts.mjs: EXCLUDED names "${suite}", which is not in SUITES — a stale exclusion for a suite that moved or was removed`);
    if (!reason || !reason.trim()) throw new Error(`ops/suite-counts.mjs: EXCLUDED entry "${suite}" carries no reason — every exclusion must say why`);
    if (excludedNames.has(suite)) throw new Error(`ops/suite-counts.mjs: EXCLUDED names "${suite}" more than once`);
    excludedNames.add(suite);
  }
  const fast = SUITES.filter((s) => !excludedNames.has(s));
  if (fast.length + excludedNames.size !== SUITES.length) throw new Error('ops/suite-counts.mjs: FAST + EXCLUDED does not partition SUITES exactly — this should be unreachable given the checks above');
  for (const mustStay of MUST_STAY_FAST) {
    if (!fast.includes(mustStay)) throw new Error(`ops/suite-counts.mjs: "${mustStay}" is required in the fast tier by anti-drift item 49, but EXCLUDED (or an edit to SUITES) dropped it`);
  }
  return fast;
}
const FAST = deriveFast();

/**
 * Parse the node:test summary in either reporter form — TAP (`# tests 225`) or spec (`ℹ tests 225`),
 * since node picks by TTY. Returns {tests, pass, fail} or throws naming what is absent. Each label is
 * anchored and matched apart from the others — a regex loose enough to confuse `pass` with `tests`
 * (or `tests` with `suites`) would be the vacuous extractor this file exists to forbid.
 */
function extract(suite, output) {
  const grab = (label) => {
    const m = output.match(new RegExp(`^(?:# |\\u2139 )${label}\\s+(\\d+)\\s*$`, 'm'));
    return m ? Number(m[1]) : null;
  };
  const tests = grab('tests');
  const pass = grab('pass');
  const fail = grab('fail');
  const absent = [['tests', tests], ['pass', pass], ['fail', fail]].filter(([, v]) => v === null).map(([k]) => k);
  if (absent.length) throw new Error(`${suite}: could not extract ${absent.join(', ')} from the runner output — refusing to report a number nobody measured`);
  if (pass + fail !== tests) throw new Error(`${suite}: pass ${pass} + fail ${fail} != tests ${tests} — the arithmetic does not close, so this run cannot be reported`);
  return { tests, pass, fail };
}

// --tier parsing. Refuses an unrecognized value before any suite runs — a typo must never silently
// fall back to running everything (too slow to notice) or nothing (too quiet to notice).
function usage() {
  return 'usage: node ops/suite-counts.mjs [--tier fast|full] [--json <file>]';
}
const tierFlag = process.argv.indexOf('--tier');
const tier = tierFlag !== -1 ? process.argv[tierFlag + 1] : 'full';
if (tier !== 'fast' && tier !== 'full') {
  console.error(`unrecognized --tier "${tier}" — ${usage()}`);
  process.exit(1);
}
const list = tier === 'fast' ? FAST : SUITES;

const rows = [];
let bad = 0;
for (const suite of list) {
  // The hooks and installed-layout suites intentionally spawn hundreds of real child processes. Six
  // minutes was below an observed clean hooks run under load, so the aggregate gate killed a healthy
  // suite before its summary and then (correctly) refused to invent counts. Keep a finite ceiling, but
  // put it above the behavior we deliberately test rather than at its normal runtime.
  const r = spawnSync(process.execPath, ['--test', path.join(PACK, suite)], { encoding: 'utf8', cwd: PACK, timeout: 900000 });
  const output = `${r.stdout}\n${r.stderr}`;
  let row;
  try {
    const c = extract(suite, output);
    row = { suite, ...c, exit: r.status, ok: r.status === 0 && c.fail === 0 };
  } catch (e) {
    row = { suite, tests: null, pass: null, fail: null, exit: r.status, ok: false, error: e.message };
  }
  if (!row.ok) bad += 1;
  rows.push(row);
  console.log(`${row.ok ? 'ok  ' : 'FAIL'} ${suite.padEnd(30)} tests=${row.tests ?? '?'} pass=${row.pass ?? '?'} fail=${row.fail ?? '?'} exit=${row.exit}${row.error ? `\n       ${row.error}` : ''}`);
}

const parsed = rows.filter((r) => r.tests !== null);
const total = { suites: rows.length, parsed: parsed.length, tests: parsed.reduce((a, r) => a + r.tests, 0), pass: parsed.reduce((a, r) => a + r.pass, 0), fail: parsed.reduce((a, r) => a + r.fail, 0) };
console.log(`\ntotal: ${total.tests} tests · ${total.pass} pass · ${total.fail} fail · ${total.parsed}/${total.suites} suites parsed${bad ? ' · ⛔ NOT A CLEAN RUN' : ''}`);

const jsonFlag = process.argv.indexOf('--json');
if (jsonFlag !== -1 && process.argv[jsonFlag + 1]) {
  fs.writeFileSync(process.argv[jsonFlag + 1], JSON.stringify({ at: null, tier, rows, total, clean: bad === 0 }, null, 2));
}
process.exit(bad ? 1 : 0);
