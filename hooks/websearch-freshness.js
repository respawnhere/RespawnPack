#!/usr/bin/env node
/*
 * RespawnPack · websearch-freshness.js — PreToolUse hook on WebSearch. If the query pins a year older than
 * the current one, it nudges toward the current year so the agent doesn't unknowingly search stale.
 * Complements /build's source-verify-or-UNVERIFIED discipline. Concept credited to the aggregator's
 * WebSearch-year hook; the auto-rewrite tier below is credited to the aggregator's update-search-year hook
 * (both MIT) — re-derived in RespawnPack's file shape (see ATTRIBUTION.md).
 *
 * TWO TIERS, precision-ordered:
 *   1. AUTO-REWRITE (high-precision only): a stale year paired with a freshness word ("latest"/"current"/…)
 *      is a near-certain mistake, so the stale year is rewritten to the current one via the harness's
 *      `hookSpecificOutput.updatedInput` middleware field, and a `systemMessage` reports the change. This
 *      is the narrowest, highest-confidence subset — it does NOT auto-rewrite on a bare recent year with no
 *      freshness word (often deliberate), and never appends a year to a query that has none (that would
 *      pollute evergreen queries like "python list comprehension syntax").
 *   2. ADVISORY (lower-precision): a recent stale year with NO freshness word only raises a `systemMessage`
 *      suggesting the current year; nothing is rewritten, nothing blocked.
 *
 * FIELD-NAME NOTE: the upstream template emits `modifiedToolInput`, but the field the current Claude Code
 * harness actually honors is `hookSpecificOutput.updatedInput` (verified against Anthropic's official
 * plugin-dev `hook-development` skill and three Claude Code changelog entries). We use `updatedInput`,
 * paired with `permissionDecision:"allow"` per that documented contract, and keep the `systemMessage` as
 * the guaranteed layer so the nudge lands even if a harness ignores the rewrite field.
 *
 * Wire as a PreToolUse hook matching WebSearch (see settings.snippet.json).
 *
 * Contract (Claude Code hooks): stdin = PreToolUse JSON {tool_name, tool_input:{query}}.
 * Rewrite = stdout JSON {hookSpecificOutput:{hookEventName,permissionDecision:"allow",updatedInput}, systemMessage} + exit 0.
 * Advise  = stdout JSON {systemMessage} + exit 0. Never denies (a year in a query is often deliberate).
 * Off     = no stdout, exit 0 (reachable only by a declared `posture.overrides["websearch-freshness"]`).
 *
 * ⭐ POSTURE (owner decision 27, P1-I-1). `websearch-freshness` was a resolver row `hooks/README.md`
 * used to call "wired and read by no hook" — its RESOLVER row is `advise` under every one of `light`,
 * `standard` and `strict`, so wiring it changes nothing for a project that declares no posture, or one
 * that declares a profile without an override: `advise` is exactly today's two-tier behaviour above,
 * unchanged. The only reachable change is an explicit `posture.overrides["websearch-freshness"]` set to
 * `off`, which is a silent exit 0 — no rewrite, no systemMessage. An UNREADABLE or INVALID declaration
 * resolves to `strict` (`advise`) inside `_posture.js`, so it produces exactly today's rewrite too, and
 * says so on stderr, never in the decision.
 *
 * ⭐ TWO ENTRY POINTS, ONE DECISION (P4-T-15a). `check(ctx)` is the whole policy and returns the verdict
 * as data; the standalone path below builds the context from stdin and the environment and prints it.
 * See hooks/README.md, "The `check(ctx)` contract".
 */
// Advisory: this hook only ever rewrites a query or nudges about one — it never denies anything — so an
// unloadable dependency says why on stderr and exits 0 rather than failing the search with a stack.
const boot = require('./_boot.js');
boot.arm('advisory');
const posture = boot.need('./_posture.js');

const FRESH = /\b(?:latest|current|recent|newest|most[-\s]?recent|up[-\s]?to[-\s]?date|this\s+year|nowadays|today)\b/i;

const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();

/*
 * ⛔ "COULD NOT READ THE POLICY" IS SAID OUT LOUD — ON stderr, NEVER INTO THE DECISION. An UNREADABLE or
 * INVALID declaration resolves to `strict` inside `_posture.js`, whose `advise` cell for this rule is
 * exactly today's behaviour, so the OUTPUT of a broken config is the output of no config. The fact that
 * the config could not be read is still real and still has to go somewhere, so it goes to the channel
 * `_boot.js` already uses to report a hook running degraded, where it cannot alter the rewrite/advisory.
 */
function sayIfUnreadable(resolved) {
  if (resolved.source !== 'UNREADABLE' && resolved.source !== 'INVALID') return;
  try { process.stderr.write(`RespawnPack websearch-freshness: ${resolved.detail}\n`); } catch { /* stderr is gone */ }
}

/**
 * The context this check reads. This hook touches no project state at all beyond the posture — the
 * query is the whole rest of the input — so `projectDir` is carried only to keep the context shape
 * uniform across the checks a dispatcher runs together.
 *
 * ⛔ `profile` IS A LAZY GETTER THAT MEMOISES, mirroring push-guard's own, so the one read of
 * `respawnpack.config.json` happens at the exact point in the pass `check()` asks for it, never for a
 * call this hook is going to ignore anyway (a non-WebSearch tool, or an empty query).
 */
function context(input) {
  let stance;
  return {
    input: input || {},
    projectDir,
    workDir: (input && input.cwd) || projectDir,
    principal: null,
    git: null,
    get profile() {
      if (stance === undefined) stance = posture.resolve(projectDir);
      return stance;
    },
  };
}

/** The pure check. Returns this hook's PreToolUse output as data, or null. */
function check(ctx) {
  const input = ctx.input || {};
  if (input.tool_name !== 'WebSearch') return null;
  const query = (input.tool_input && input.tool_input.query) || '';
  if (!query) return null;

  /*
   * ⛔ ONE RESOLUTION PER INVOCATION, TAKEN HERE — the position the pack's other guards take their
   * `.respawnpack/<hook>.off` marker check: this hook has no marker, so it is the first point at which
   * the rule might actually have something to say. `off` (reachable only by an override) is a silent
   * exit 0; every other verdict this row can hold is `advise`, which is today's behaviour below,
   * unchanged.
   */
  const stance = ctx.profile;
  sayIfUnreadable(stance);
  if (posture.verdict(stance, 'websearch-freshness') === 'off') return null;

  const now = new Date().getFullYear();
  const stale = [...new Set([...query.matchAll(/\b(20\d{2})\b/g)].map((m) => Number(m[1])))]
    .filter((y) => y >= 2000 && y < now);
  if (!stale.length) return null;

  const fresh = FRESH.test(query);
  const recentStale = stale.some((y) => y >= now - 4); // e.g. 2024 in 2026 — plausibly meant "latest"
  if (!fresh && !recentStale) return null; // plainly historical (e.g. "2011 census") → stay quiet

  const worst = Math.max(...stale);

  // Tier 1 — high-precision auto-rewrite: stale year + explicit freshness word.
  if (fresh) {
    // Replace only the stale years (< now); leave any current-year mentions intact.
    let rewritten = query.replace(/\b(20\d{2})\b/g, (m) => {
      const n = Number(m);
      return (n >= 2000 && n < now) ? String(now) : m;
    });
    // Tidy any "2026 2026" run the substitution may have produced into a single current year.
    rewritten = rewritten.replace(new RegExp(`\\b${now}(?:\\s+${now}\\b)+`, 'g'), String(now));

    if (rewritten !== query) {
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          updatedInput: { ...input.tool_input, query: rewritten },
        },
        systemMessage:
          `🔎 RespawnPack freshness-nudge: your WebSearch query pinned ${worst} next to a freshness word, ` +
          `but the current year is ${now} — I rewrote it to search ${now} instead ("${query}" → ` +
          `"${rewritten}"). If ${worst} was deliberate, search again with the year you meant.`,
      };
    }
    // Fell through (no net change) → drop to the advisory below rather than emit a no-op rewrite.
  }

  // Tier 2 — advisory only: recent stale year, no freshness word (or a rewrite that changed nothing).
  return {
    systemMessage:
      `🔎 RespawnPack freshness-nudge: your WebSearch query pins ${worst}, but the current year is ${now}. ` +
      `If you want the most up-to-date results, search for ${now} instead (or drop the year). ` +
      `(Advisory — the search was not blocked.)`,
  };
}

module.exports = { check, context };

// --- standalone entry point ---
if (require.main === module) {
  let raw = '';
  process.stdin.on('data', (d) => (raw += d));
  process.stdin.on('end', () => {
    let input;
    try { input = JSON.parse(raw || '{}'); } catch { process.exit(0); }
    const verdict = check(context(input));
    if (verdict) process.stdout.write(JSON.stringify(verdict));
    process.exit(0);
  });
}
