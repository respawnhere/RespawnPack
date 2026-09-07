/*
 * RespawnPack · conformance/capability-matrix.mjs — renders CAPABILITY-MATRIX.md from the four live
 * profile-declaration modules, never from a hand-maintained table.
 *
 * ⛔ THIS FILE HAS NO OPINION OF ITS OWN ABOUT WHAT ANY PROFILE SUPPORTS. Every cell comes from calling
 * the profile's own declaration function — adapters/claude-code/interactive/profile.js,
 * adapters/claude-code/sdk-supervisor/capabilities.js, adapters/codex/profile.js, and
 * adapters/codex/app-server/capabilities.js — and reading back the {support, declaredSupport, downgraded}
 * that core/policy/capabilities.js's declare() computed.
 * A table someone edits by hand drifts the moment a capability changes; a table generated from the same
 * declare() call the adapters themselves use at runtime cannot drift without the generator itself
 * failing to reproduce it — which is exactly what conformance.test.mjs's byte-equality fence checks on
 * every run. This is the pack's signature move (kernel/lib/render.js does the same for CONTINUITY.md and
 * GAPS.md): render from source, then verify the render against the source again.
 *
 * ⛔ NO CANARY IS EVER FABRICATED HERE. Five of the six profiles have no committed activation-canary
 * evidence in this repository — the honest CANNOT_DETERMINE state every one of them documents in its own
 * README is rendered exactly as declare() produces it, from a `null` (or absent-marker) canary, never
 * synthesized into something rosier. The sixth, codex/app-server, has real evidence: three consecutive
 * in-place rollovers that ran and PASSED on this machine, checked in verbatim and digest-fenced at
 * adapters/codex/app-server/fixtures/captured/06-live-canary-report.json. That fixture's own output
 * already carries a `capabilityMatrix` field — the exact shape declare() produced when the canary ran —
 * and this file reproduces it by calling the same capabilities.js function the canary itself calls,
 * pinned to that fixture's own recorded `endedAt` timestamp rather than the wall clock, so re-running
 * this renderer next year reproduces today's bytes rather than a new "now".
 *
 * ⛔ NOTHING RENDERED HERE MAY DEPEND ON THIS MACHINE OR THIS CHECKOUT. A profile's own internal `why`
 * text for an absent canary embeds the resolved filesystem path it looked for (adapters/codex/profile.js's
 * readCanary does this) — accurate, and useless here: that path carries this machine's drive letter and
 * username, differs by OS path separator, and would make the checked-in
 * CAPABILITY-MATRIX.md fail its own byte-equality fence the moment anyone else clones this repository or
 * CI re-renders it on ubuntu-latest. So this renderer reads only the STRUCTURED, enum-shaped fields
 * declare() returns (support, declaredSupport, downgraded, rolloverCapable, unmet) and writes its OWN
 * short, static, portable prose for the human-readable "why" — see CANARY_BASIS below. Every string in
 * CANARY_BASIS is a literal written in this file; none of it is built from path.join or a resolved path.
 */
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const require_ = createRequire(import.meta.url);

const core = require_(path.join(ROOT, 'core', 'index.js'));
const claudeInteractive = require_(path.join(ROOT, 'adapters', 'claude-code', 'interactive', 'profile.js'));
const claudeSdk = require_(path.join(ROOT, 'adapters', 'claude-code', 'sdk-supervisor', 'capabilities.js'));
const codexHooks = require_(path.join(ROOT, 'adapters', 'codex', 'profile.js'));
const codexAppServer = require_(path.join(ROOT, 'adapters', 'codex', 'app-server', 'capabilities.js'));

const { CAPABILITIES } = core.capabilities;

// One-line meaning of each of core's seven capabilities, verbatim from core/policy/capabilities.js's own
// comments — repeated here so a reader of the matrix never has to open the source to know what a row means.
const CAPABILITY_MEANING = {
  probe: 'prove the configured integration is active',
  measureContext: 'return usage, capacity, source, and confidence',
  settleOrStop: 'reach a safe boundary without duplicating work',
  requestCompact: 'ask the host to compact through a documented API',
  observeCompact: 'prove completion or return a typed failure',
  injectHandoff: 'add verified continuation context',
  resume: 'continue the same conversation identity',
};

// The real, checked-in, digest-fenced evidence for the one profile that has any: three consecutive
// in-place rollovers that ran and PASSED on a real Codex thread on this machine. See the fixture's own
// MANIFEST.json for the digest and the `containsEnvironmentData` review flag. `observedAt` is pinned to
// the fixture's own recorded `endedAt`, never `new Date()` — the whole file must be reproducible from
// the checked-in tree alone, on any machine, on any day.
const LIVE_CODEX_REPORT_PATH = path.join(ROOT, 'adapters', 'codex', 'app-server', 'fixtures', 'captured', '06-live-canary-report.json');
const liveCodexReport = JSON.parse(fs.readFileSync(LIVE_CODEX_REPORT_PATH, 'utf8'));
const liveCodexCanary = codexAppServer.canaryFromReport(liveCodexReport, { observedAt: liveCodexReport.endedAt });

/*
 * A project directory for the module that reads canary markers off disk (adapters/codex/profile.js).
 * This repository IS that project — RespawnPack's own source tree, not an installed target with a live
 * conversation running against it — and it genuinely carries no .respawnpack/runtime/rollover/ canary
 * marker for that surface, so pointing it at the real repo root produces the honest, unfabricated
 * CANNOT_DETERMINE it documents in its own README. Its value never appears in the rendered output (see
 * the file banner above) — only the structured enum fields the call returns do.
 */
const NO_MARKERS_HERE = ROOT;

/** One authored-by-this-file, path-free sentence per profile: what today's declaration rests on. */
const CANARY_BASIS = {
  'claude-interactive-hooks': 'No activation canary is recorded in this repository. `probe.js` looks for '
    + 'a live SessionStart baseline and a context-monitor latch file written for a real conversation; this '
    + 'repository is the pack’s own source tree, not an installed target with one running.',
  'claude-code/sdk-supervisor': 'A live activation canary ran on this machine and answered CANNOT_DETERMINE '
    + '(exit 2): the PATH `claude` binary reported "Not logged in" (2.1.205), and the SDK’s own bundled '
    + 'binary separately reported an expired OAuth session. Both are environmental — an unauthenticated '
    + 'context, not a defect in this profile. See adapters/claude-code/sdk-supervisor/README.md.',
  'codex-interactive-hooks': 'No activation canary is recorded in this repository. Codex hooks are gated on '
    + 'BOTH `features.hooks` and a per-hook interactive `/hooks` trust decision inside a live Codex session; '
    + 'neither has been established here.',
  'codex/app-server': 'A live activation canary ran on this machine and PASSED: three consecutive in-place '
    + `rollovers on one real Codex thread (codex-cli 0.146.0, ${liveCodexReport.endedAt}). The event log and `
    + 'the structured report are checked in verbatim and digest-fenced at '
    + 'adapters/codex/app-server/fixtures/captured/05-live-canary-events.jsonl and 06-live-canary-report.json '
    + '— both flagged `containsEnvironmentData` in the fixture MANIFEST (this machine’s temp paths, the '
    + 'host’s codexHome, the userAgent, and unsolicited account/rate-limit rows are recorded unredacted, '
    + 'because a redacted evidence log is not evidence). Owner review before any publication.',
};

const PROFILES = [
  { id: 'claude-interactive-hooks', label: 'Claude Code — interactive hooks', kind: 'interactive, manual `/compact`',
    row: () => claudeInteractive.matrix(null) },
  { id: 'claude-code/sdk-supervisor', label: 'Claude Code — managed SDK supervisor', kind: 'managed, automatic',
    row: () => claudeSdk.matrix(null) },
  { id: 'codex-interactive-hooks', label: 'Codex — interactive hooks', kind: 'interactive, manual `/compact`',
    row: () => codexHooks.declareAll(NO_MARKERS_HERE) },
  { id: 'codex/app-server', label: 'Codex — managed app-server supervisor', kind: 'managed, automatic',
    row: () => codexAppServer.matrix(liveCodexCanary) },
];

/** One cell: the OBSERVED support level, with the DECLARED (target) level named only where it diverges. */
function cell(decl) {
  if (!decl) return 'undeclared';
  if (!decl.downgraded || decl.support === decl.declaredSupport) return `\`${decl.support}\``;
  return `\`${decl.support}\` _(declared \`${decl.declaredSupport}\`)_`;
}

function renderMainTable(rows) {
  const header = `| Capability | ${PROFILES.map((p) => p.label).join(' | ')} |`;
  const rule = `|---|${PROFILES.map(() => '---').join('|')}|`;
  const lines = CAPABILITIES.map((cap) => {
    const cells = rows.map((r) => cell(r.declarations.find((d) => d.capability === cap)));
    return `| \`${cap}\` — ${CAPABILITY_MEANING[cap]} | ${cells.join(' | ')} |`;
  });
  return [header, rule, ...lines].join('\n');
}

function renderSummaryTable(rows) {
  const header = '| Profile | Kind | Rollover-capable today | Unmet (if any) |';
  const rule = '|---|---|---|---|';
  const lines = PROFILES.map((p, i) => {
    const r = rows[i];
    const unmet = r.unmet && r.unmet.length ? r.unmet.map((c) => `\`${c}\``).join(', ') : '—';
    return `| ${p.label} (\`${p.id}\`) | ${p.kind} | ${r.rolloverCapable ? 'yes' : 'no'} | ${unmet} |`;
  });
  return [header, rule, ...lines].join('\n');
}

function renderCanaryBasis() {
  return PROFILES.map((p) => `- **${p.label}** (\`${p.id}\`): ${CANARY_BASIS[p.id]}`).join('\n');
}

function renderPiNote() {
  return 'Pi is not one of the profiles in this matrix. RespawnPack carries no Pi adapter; Pi support '
    + 'ships as the separate `respawn-pi` package, which builds on this pack’s host-neutral `core/` '
    + 'contract without forking it and declares its own capabilities there.';
}

/**
 * Pure. Deterministic. No wall-clock, no machine-specific path, ever — the same call must produce the
 * same bytes on every machine and on every day, because conformance.test.mjs re-runs it and asserts
 * byte-equality against what is checked in.
 */
function render() {
  const rows = PROFILES.map((p) => {
    const r = p.row();
    if (r.profile !== p.id) throw new Error(`capability-matrix.mjs: ${p.id} labeled a row whose module reported profile ${r.profile} — the id table has drifted from the source`);
    return r;
  });

  return `# RespawnPack · v0.3 capability matrix

Generated by \`node conformance/capability-matrix.mjs\` from the four live profile-declaration modules, per
the multi-host in-place rollover design. \`conformance/conformance.test.mjs\`
re-renders this file on every run and asserts it is byte-identical to what is checked in — the same
rendered-claims-verified-against-source discipline \`kernel/lib/render.js\` uses for \`CONTINUITY.md\` and
\`GAPS.md\`. A cell here that does not match what the source modules produce today is a bug in this file,
not in them.

## How to read a cell

Every claim in this repository rests on \`core/policy/capabilities.js\`'s \`declare()\`: a capability may be
declared \`SUPPORTED\` or \`SUPPORTED_WITH_LIMITATIONS\` only when a well-formed activation canary recorded
its own outcome as \`PASS\` — a canary that ran and did not pass, or never ran at all, downgrades the claim
to \`CANNOT_DETERMINE\`, naming the real verdict rather than staying silent about it. **Declared** is what a
profile is built to reach (its target, from the v0.3 design). **Observed** is what stands today, after that
downgrade rule runs against whatever canary evidence actually exists. A cell showing one value (for example
\`SUPPORTED\`) means declared and observed agree — either because the target needs no canary
(\`NOT_SUPPORTED\`, an honest claim about a missing mechanism, not an unproven one), or because a real
passing canary backs it. A cell showing \`CANNOT_DETERMINE\` _(declared \`SUPPORTED_WITH_LIMITATIONS\`)_ means
the profile is built to reach that target and nothing today proves it — see "Canary basis per profile"
below for exactly what is missing and why. Installing files is never treated as evidence; only a fired,
passing canary is.

## The matrix

${renderMainTable(rows)}

## Rollover-capable today

A profile is rollover-capable only when every capability the in-place rollover needs
(\`core/policy/capabilities.js\`'s \`ROLLOVER_REQUIRED\`, all seven above) is at least
\`SUPPORTED_WITH_LIMITATIONS\` — a profile that cannot observe completion has not "mostly" rolled over, it
has not proven one happened.

${renderSummaryTable(rows)}

## Canary basis per profile

${renderCanaryBasis()}

## Pi support

${renderPiNote()}
`;
}

const isMain = (() => {
  try { return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url); }
  catch { return false; }
})();

if (isMain) {
  const out = path.join(HERE, 'CAPABILITY-MATRIX.md');
  fs.writeFileSync(out, render());
  process.stdout.write(`wrote ${out}\n`);
}

export { render, PROFILES, CAPABILITY_MEANING };
