#!/usr/bin/env node
/*
 * RespawnPack · ops/sweep-scratch.mjs — recover a subagent's scratch output, verifying by SIZE.
 *
 * ⛔ RELOCATED FROM THE KERNEL (P2-K-13, the kernel audit §5 K-13 / §2.1). This was the `sweep-scratch`
 * kernel verb. It moved here because it answers to nobody's CI and nobody's savepoint: it is a recovery
 * tool an operator runs by hand, once, after a subagent fan-out — not a check the kernel's three-file
 * bootstrap (respawnpack.js, outcome.js, modhealth.js) needs to carry, and not one the installed kernel
 * needs to ship to every target (`install/_sources.js`'s copy list is unchanged; this file never
 * installs). The behavior is unchanged, including the containment fix below — only the address moved.
 *
 * ⛔ WHAT THIS IS AND IS NOT FOR. the 2026-08-07 field run §3 reported subagent writes landing in
 * `.respawnpack/scratch/<agentId>/` instead of their intended absolute path, silently, and nearly lost
 * ~2.4 MB of irreplaceable research. One correction the report itself could not make: RespawnPack's own
 * guard does NOT do that — hooks/index-guard.js DENIES an out-of-scratch subagent write with an explicit
 * reason rather than redirecting it. Whatever relocated those files was not this pack. So this tool does
 * not claim to fix a defect in the guard; it makes the RECOVERY mechanical, because the sweep the
 * operator had to improvise under time pressure is where the real damage happened:
 *
 *   · a `cp -n` sweep run while agents were still writing produced `01-hunting-methodology.md` at 46 KB
 *     of an actual 203 KB, and missed seven files entirely, because "file exists at destination" read as
 *     success. It is not success. It is the single most dangerous default in a sweep.
 *
 * ⛔ SO: SIZE IS THE VERDICT, NOT EXISTENCE. Every file reports source bytes, destination bytes and what
 * was decided. A smaller source over a larger destination is REFUSED, never silently skipped and never
 * silently applied — that is the exact truncation above, and both quiet answers are wrong. Nothing is
 * deleted from scratch: a sweep that removes its own evidence cannot be checked afterwards.
 *
 * ⛔ AND IT PREVIEWS BY DEFAULT. `--write` performs it. A recovery tool that acts before you have read
 * what it is about to do is how the 46 KB file got written over the 203 KB one.
 *
 * ⛔ CONTAINMENT (the kernel audit BUG-1 / K-01, fixed by fa3307f). `--into` is checked against the SAME
 * guard trio removals.js runs on every project-relative path it takes from configuration —
 * `portableAbsolute`, `hasParentSegment`, `containedResolution` — imported from kernel/lib/removals.js
 * rather than copied. An `--into` that is absolute, contains `..`, or resolves outside `--dir` (including
 * through a symlink) is refused with CANNOT_DETERMINE naming the offending value, before any plan is
 * built — so a bare preview refuses too, and the plan this tool prints never shows an out-of-tree
 * destination as something `--write` would apply.
 *
 *   node ops/sweep-scratch.mjs [--dir <d>] [--into <d>] [--write] [--json]
 *
 * Exit: 0 PASS/NOT_APPLICABLE · 1 FAIL · 2 CANNOT_DETERMINE — the same three-valued map every verb uses
 * (kernel/lib/outcome.js `exitCodeFor`). Never deletes from scratch; never writes without `--write`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const PACK = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require_ = createRequire(import.meta.url);
const removalsLib = require_(path.join(PACK, 'kernel', 'lib', 'removals.js'));
const { OUTCOME, exitCodeFor } = require_(path.join(PACK, 'kernel', 'lib', 'outcome.js'));

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const valueOf = (name, fallback) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback; };

const DIR = path.resolve(valueOf('--dir', process.env.CLAUDE_PROJECT_DIR || process.cwd()));
const JSON_OUT = flag('--json');

/**
 * Move a subagent's scratch output to where it was supposed to go. Preview by default; `--write`
 * performs it. This is a straight port of the former `cmdSweepScratch` in kernel/respawnpack.js —
 * same refusals, same shape — reading `--write`/`--into` and `DIR` from the module scope above exactly
 * as the kernel verb read them from its own argv/DIR.
 */
function sweepScratch() {
  const write = flag('--write');
  const into = valueOf('--into', null);
  const scratchRoot = path.join(DIR, '.respawnpack', 'scratch');

  let agents = [];
  try {
    agents = fs.readdirSync(scratchRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return { outcome: OUTCOME.NOT_APPLICABLE, root: '.respawnpack/scratch', files: [], detail: 'no .respawnpack/scratch/ in this project — no subagent has written scratch output here' };
  }
  if (!into) {
    return {
      outcome: OUTCOME.CANNOT_DETERMINE, agents,
      error: 'name the destination directory: sweep-scratch --into <dir> [--write]. The intended path is ' +
        'the orchestrator\'s knowledge, not something this tool can infer from a scratch namespace — and ' +
        'guessing it is how a sweep overwrites the wrong file.',
    };
  }

  /*
   * ⛔ CONTAINMENT — the same guard trio removals.js and reconcile.js already run on every project-relative
   * path they take from configuration (`removalsLib.portableAbsolute`, `hasParentSegment`,
   * `containedResolution`). `--into` never had it until fa3307f: `path.join(DIR, into, childRel)` accepted
   * a `..`-relative value and copied bytes to a sibling of the project while reporting PASS, and an
   * absolute value produced a nonsense concatenated path that FAILed on a confusing ENOENT naming a
   * destination this tool never targeted. Checked here, once, before any plan is built.
   */
  if (removalsLib.portableAbsolute(into) || removalsLib.hasParentSegment(into)) {
    return {
      outcome: OUTCOME.CANNOT_DETERMINE, agents, into,
      error: `--into "${into}" must be a project-relative path with no parent-directory ("..") segment. ` +
        `sweep-scratch never writes outside the project root (${DIR}).`,
    };
  }
  const containment = removalsLib.containedResolution(DIR, path.resolve(DIR, into));
  if (!containment.ok) {
    const why = containment.kind === 'symlink'
      ? 'resolves outside the project through a symlink'
      : containment.kind === 'lexical'
        ? 'resolves outside the project'
        : `could not be resolved (${(containment.error && (containment.error.code || containment.error.message)) || 'unknown error'})`;
    return {
      outcome: OUTCOME.CANNOT_DETERMINE, agents, into,
      error: `--into "${into}" (resolved: ${path.resolve(DIR, into)}) ${why}. The project root is ${DIR}; ` +
        'sweep-scratch never writes outside it.',
    };
  }

  /*
   * Walk every agent namespace, keeping each path RELATIVE to its namespace: the orchestrator assigned
   * these names, so `agent_a/research/01.md` is meant to land at `<into>/research/01.md`, not at
   * `<into>/agent_a/research/01.md` — inventing a directory layout nobody asked for is its own way of
   * losing a file. The cost of that choice is that two agents CAN name the same destination, which the
   * collision pass below refuses; see it for why refusing beats picking a winner.
   */
  const files = [];
  const walk = (abs, rel, agent) => {
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const child = path.join(abs, e.name);
      const childRel = rel ? path.join(rel, e.name) : e.name;
      if (e.isDirectory()) { walk(child, childRel, agent); continue; }
      if (!e.isFile()) continue;
      const srcBytes = fs.statSync(child).size;
      const destAbs = path.join(DIR, into, childRel);
      let destBytes = null;
      try { destBytes = fs.statSync(destAbs).size; } catch { destBytes = null; }

      let action, why;
      if (destBytes === null) { action = 'MOVE'; why = 'no file at the destination'; }
      else if (destBytes === srcBytes) { action = 'SKIP'; why = `destination already holds ${destBytes} bytes — same size`; }
      else if (srcBytes < destBytes) {
        action = 'REFUSE';
        why = `source is SMALLER than the destination (${srcBytes} < ${destBytes} bytes). This is the truncation ` +
          'shape: a sweep run while the agent was still writing. Resolve it by hand — neither overwriting nor ' +
          'skipping is safe to decide here.';
      } else { action = 'OVERWRITE'; why = `source is larger (${srcBytes} > ${destBytes} bytes) — the destination looks truncated`; }

      files.push({ agent, from: path.relative(DIR, child), to: path.join(into, childRel), srcBytes, destBytes, action, why, applied: false });
    }
  };
  for (const a of agents) walk(path.join(scratchRoot, a), '', a);

  /*
   * ⛔ TWO AGENTS AIMING AT ONE DESTINATION IS A LOSS EVENT, NOT AN ORDERING QUESTION.
   *
   * Every file above is planned independently, so two helpers that both wrote `notes.md` both plan a
   * clean MOVE — and applying them in order would silently destroy the first. That is the same class of
   * silent data loss as the 46 KB truncation this tool exists to refuse, with a different cause, and
   * "last writer wins" is not a decision this tool is entitled to make on the operator's behalf. Neither
   * is picking the larger one: size settles a truncated COPY of one file, and says nothing about two
   * different files that happen to share a name.
   */
  const byDest = new Map();
  for (const f of files) byDest.set(f.to, (byDest.get(f.to) || 0) + 1);
  for (const f of files) {
    if (byDest.get(f.to) < 2) continue;
    const others = files.filter((o) => o.to === f.to && o !== f).map((o) => o.agent);
    f.action = 'REFUSE';
    f.why = `${byDest.get(f.to)} agents (${[f.agent, ...others].join(', ')}) all target ${f.to}. Sweeping them ` +
      'in any order destroys all but one. Move them by hand under distinct names, or re-run with --into ' +
      'pointing somewhere per-agent — this tool will not pick a winner.';
  }

  if (write) {
    for (const f of files) {
      if (f.action !== 'MOVE' && f.action !== 'OVERWRITE') continue;
      try {
        const destAbs = path.join(DIR, f.to);
        fs.mkdirSync(path.dirname(destAbs), { recursive: true });
        fs.copyFileSync(path.join(DIR, f.from), destAbs);
        // Verify by SIZE after the write, because "the copy returned" is not "the bytes arrived".
        const landed = fs.statSync(destAbs).size;
        if (landed !== f.srcBytes) { f.action = 'FAILED'; f.why = `wrote ${landed} bytes but the source is ${f.srcBytes} — the copy did not land intact`; }
        else f.applied = true;
      } catch (e) { f.action = 'FAILED'; f.why = `${(e && e.code) || 'ERROR'}: ${(e && e.message) || e}`; }
    }
  }

  const refused = files.filter((f) => f.action === 'REFUSE');
  const failed = files.filter((f) => f.action === 'FAILED');
  const moved = files.filter((f) => f.applied);
  return {
    outcome: failed.length || refused.length ? OUTCOME.FAIL : files.length ? OUTCOME.PASS : OUTCOME.NOT_APPLICABLE,
    agents, into, applied: write, files,
    totals: { files: files.length, moved: moved.length, movedBytes: moved.reduce((n, f) => n + f.srcBytes, 0), refused: refused.length, failed: failed.length },
    detail: (write ? `swept ${moved.length}/${files.length} file(s), ${moved.reduce((n, f) => n + f.srcBytes, 0)} bytes` : `PREVIEW ONLY — nothing was written. ${files.length} file(s) across ${agents.length} agent namespace(s)`) +
      `${refused.length ? ` · ⛔ ${refused.length} REFUSED (source smaller than destination — resolve by hand)` : ''}` +
      `${failed.length ? ` · ⛔ ${failed.length} FAILED` : ''}` +
      '. Nothing was deleted from scratch — verify the destinations before clearing it.',
  };
}

const out = sweepScratch();

if (JSON_OUT) {
  console.log(JSON.stringify(out, null, 2));
} else {
  if (out.error) console.error(`  ${out.error}`);
  for (const f of out.files || []) {
    console.log(`  ${f.action.padEnd(9)} ${f.from} -> ${f.to} (${f.srcBytes}${f.destBytes === null ? '' : ` vs ${f.destBytes}`} bytes)${f.applied ? ' [written]' : ''}`);
    if (f.action === 'REFUSE' || f.action === 'FAILED') console.log(`            ${f.why}`);
  }
  if (out.detail) console.log(`\n  ${out.detail}`);
  console.log(`\n  → ${out.outcome}`);
}
process.exit(exitCodeFor(out.outcome));
