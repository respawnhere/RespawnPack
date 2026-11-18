/*
 * RespawnPack · adapters/codex/profile.js — capability declaration for 'codex-interactive-hooks'.
 *
 * ⛔ EVERY DECLARATION BELOW NAMES ITS EVIDENCE REQUIREMENT, BECAUSE core/policy/capabilities.js WILL
 * DOWNGRADE ANY THAT DOES NOT SATISFY ITS OWN. `SUPPORTED`/`SUPPORTED_WITH_LIMITATIONS` are auto-
 * downgraded to `CANNOT_DETERMINE` when the supplied `canary` fails `canaryUsable()` — its SHAPE: no
 * kind, no observedAt, no verbatim raw, or `ran !== true` — or fails `canaryVerdict()`, its VERDICT: an
 * `outcome` that is absent or is anything other than PASS. `NOT_SUPPORTED`/`CANNOT_DETERMINE` are
 * auto-downgraded when `why` is empty. This file relies on those downgrades rather than working around
 * them — see `declareAll` below, which passes a real-or-null canary straight through and lets core/
 * decide.
 *
 * ⭐ WHY TODAY'S HONEST ANSWER IS MOSTLY CANNOT_DETERMINE. This adapter has never run inside a live,
 * trusted Codex project — Codex gates every hook on BOTH `features.hooks` and a per-hook interactive
 * trust decision (`/hooks`) this pack cannot observe from outside, and there is no scriptable
 * hooks-list command to check instead. So `readCanary` below reads a REAL marker file when one exists
 * (written by adapters/codex/hooks/respawnpack-canary.js the moment a trusted hook actually fires) and
 * returns `null` when it does not — which is the state of a freshly authored adapter. `declare()` then
 * downgrades every canary-requiring capability to CANNOT_DETERMINE on its own, honestly, with no special
 * casing needed here for "this hasn't been proven live yet."
 *
 * ⛔ FRESHNESS IS CHECKED ON TOP OF CORE'S GATES, NOT INSTEAD OF THEM. A marker can be well-formed, can
 * record a PASS, and still be stale — a project untouched by Codex for months whose LAST observed firing
 * was real, once. Core checks the canary's SHAPE (`canaryUsable`) and its VERDICT (`canaryVerdict`, which
 * is why `readCanary` below forwards the marker's `outcome` rather than dropping it); `CANARY_FRESHNESS_MS`
 * is this adapter's own added judgement call about how old is too old to keep calling it "active" without
 * a fresh observation, exactly what the brief calls "freshness-checked." AGE IS THE ONLY THING THIS FILE
 * DECIDES — everything else is core's, so a marker this adapter forwards is still refused on its own
 * merits.
 */
'use strict';
const shared = require('./hooks/_shared.js');
const { core } = shared;
const { capabilities } = core;

const PROFILE_NAME = 'codex-interactive-hooks';

// 30 days: long enough that a quiet week in a project does not falsely read as "hooks stopped working",
// short enough that a marker from a long-abandoned experiment is not still claimed live. A named,
// documented choice, not a magic number — change it here if operational experience says otherwise.
const CANARY_FRESHNESS_MS = 30 * 24 * 60 * 60 * 1000;

const DOCS = {
  hooks: ['adapters/codex/hooks.json.template', 'adapters/codex/config.toml.snippet', 'adapters/codex/README.md'],
};

/**
 * Read the activation canary and decide whether it is USABLE (present, well-formed, and fresh).
 * @returns {{present:boolean, usable:boolean, canary:object|null, why:string|null}}
 */
function readCanary(projectDir) {
  const read = shared.readCanaryDoc(projectDir);
  if (!read.present) {
    return { present: false, usable: false, canary: null, why: `no activation canary marker found at ${shared.canaryPath(projectDir)} — no wired, trusted Codex hook has fired in this project yet` };
  }
  const doc = read.doc;
  const observedAt = doc && doc.at;
  const ageMs = Date.now() - Date.parse(observedAt || '');
  if (!Number.isFinite(ageMs)) {
    return { present: true, usable: false, canary: null, why: 'the activation canary marker has no parseable observation time' };
  }
  if (ageMs > CANARY_FRESHNESS_MS) {
    const days = Math.floor(ageMs / 86400000);
    return {
      present: true, usable: false, canary: null,
      why: `the last observed hook firing was ${days} day(s) ago, past the ${CANARY_FRESHNESS_MS / 86400000}-day freshness window — trigger any trusted Codex hook (e.g. a Stop) to refresh it`,
    };
  }
  if (doc.ran !== true) {
    return { present: true, usable: false, canary: null, why: 'the activation canary marker does not assert that a hook ran' };
  }
  return {
    present: true, usable: true,
    // `outcome` travels VERBATIM from the marker: a marker written before this field existed carries
    // none, and core refuses it for that rather than this file inventing a PASS on its behalf.
    canary: { kind: doc.kind || 'codex-hooks-activation-canary', observedAt, ran: true, outcome: doc.outcome, raw: doc.raw },
    why: null,
  };
}

/**
 * `capabilities.declare()` downgrades a canary-requiring capability with NO canary using its OWN generic
 * `canaryUsable()` message ("no activation canary was supplied") — which is correct for "never fired" but
 * says nothing about a marker that exists and is simply STALE, the one case this adapter withholds on
 * its own. This wrapper calls `declare()` normally (so core/'s own validation is never bypassed) and
 * then, only for the stale-but-present case, replaces the generic `why` with this adapter's own more
 * specific diagnosis — never touching `support` or `downgraded`, which core/ already computed correctly.
 * A marker that IS forwarded and is refused on its shape or its verdict keeps core's own wording, which
 * is already the specific one.
 */
function declareCanaryGated(args, read) {
  const d = capabilities.declare(args);
  if (d.downgraded && read.present && !read.usable && read.why) {
    return { ...d, why: `${args.support} was claimed and ${read.why}` };
  }
  return d;
}

/**
 * Build all seven capability declarations for a given project.
 * @returns {{profile, declarations, undeclared, rolloverCapable, unmet, downgraded, outcome}} the matrix,
 *          exactly as core/policy/capabilities.js's `matrix()` produces it.
 */
function declareAll(projectDir) {
  const read = readCanary(projectDir);
  const canary = read.usable ? read.canary : null;
  const canaryUnavailableWhy = read.why;

  const declarations = [
    declareCanaryGated({
      capability: 'probe',
      support: capabilities.SUPPORT.SUPPORTED_WITH_LIMITATIONS,
      canary,
      mechanism: 'freshness-checked activation-canary marker, refreshed by any wired+trusted hook (respawnpack-canary.js, plus every behavioural hook)',
      limitations: [
        'proves at least ONE registered hook is trusted and fired; Codex trust is per-hook, so this does not prove every hook this adapter registers is individually trusted',
        'no scriptable hooks-list command exists — this is the only after-the-fact activation proof available',
      ],
      docs: DOCS.hooks,
    }, read),

    capabilities.declare({
      capability: 'measureContext',
      support: capabilities.SUPPORT.NOT_SUPPORTED,
      why: 'no field documented in a Codex hook payload (session_id, cwd, hook_event_name, permission_mode, turn_id, transcript_path, model) carries usage or context-window numbers; the app-server profile (thread/tokenUsage/updated, W3b) will carry it instead',
      docs: DOCS.hooks,
    }),

    capabilities.declare({
      capability: 'requestCompact',
      support: capabilities.SUPPORT.NOT_SUPPORTED,
      why: 'hooks expose no documented mechanism to CALL compaction (programmatic requestCompact is unsupported at this layer); the operator runs /compact manually — see adapters/codex/skills/respawn-rollover/SKILL.md — and PreCompact/SessionStart(compact) only ever OBSERVE that boundary, never trigger it',
      docs: DOCS.hooks.concat(['adapters/codex/skills/respawn-rollover/SKILL.md']),
    }),

    declareCanaryGated({
      capability: 'observeCompact',
      support: capabilities.SUPPORT.SUPPORTED_WITH_LIMITATIONS,
      canary,
      mechanism: 'SessionStart hook with source==="compact" (primary — additionalContext injection point) plus a PostCompact marker (corroboration only, no additionalContext)',
      limitations: [
        'neither payload has a consolidated documented schema beyond the common fields; every observation stores the raw stdin verbatim rather than trusting a typed interpretation of it',
        'evidence.js\'s declared signal for this is "session_start_compact", shared with the Claude Code profile — it is Codex-specific only in which host observed it, not in a Codex-only wire format',
      ],
      docs: DOCS.hooks,
    }, read),

    declareCanaryGated({
      capability: 'settleOrStop',
      support: capabilities.SUPPORT.SUPPORTED,
      canary,
      mechanism: 'Stop hook; an unblocked firing is the settle signal (decision:"block" forces another turn and is not a veto of anything this adapter does)',
      docs: DOCS.hooks,
    }, read),

    declareCanaryGated({
      capability: 'injectHandoff',
      support: capabilities.SUPPORT.SUPPORTED_WITH_LIMITATIONS,
      canary,
      mechanism: 'SessionStart(source=compact) additionalContext, in the {hookSpecificOutput:{hookEventName,additionalContext}} envelope',
      limitations: [
        'that exact envelope shape mirrors Claude Code\'s documented convention as a best-effort guess for Codex — it has not been independently confirmed against a live trusted Codex install (see README, "What is verified vs. what is templated")',
        'the canary proves the HOOK fired; it does not prove Codex\'s model actually consumed the injected text, which is a separate, currently unobservable question',
      ],
      docs: DOCS.hooks,
    }, read),

    declareCanaryGated({
      capability: 'resume',
      support: capabilities.SUPPORT.SUPPORTED_WITH_LIMITATIONS,
      canary,
      mechanism: 'the same session_id observed at SessionStart(compact) as before compaction; the operator keeps the same interactive Codex CLI session across the manual /compact',
      limitations: [
        'hooks-vs-app-server id interchangeability (whether a hook\'s session_id is the same value as app-server\'s thread.id/sessionId) is CANNOT_DETERMINE from documentation alone — the W3-probe observed them equal in one live app-server session, which is recorded but not treated as a hooks-layer guarantee',
      ],
      docs: DOCS.hooks,
    }, read),
  ];

  const matrix = capabilities.matrix(PROFILE_NAME, declarations);
  return { ...matrix, canaryStatus: read, canaryUnavailableWhy };
}

module.exports = { PROFILE_NAME, CANARY_FRESHNESS_MS, readCanary, declareAll };
