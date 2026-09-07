/*
 * RespawnPack · core/policy/routing.js — which model family and model a task class routes to, and why.
 *
 * ⛔ THIS MODULE DECLARES NO CAPABILITY AND PROBES NOTHING (anti-drift item 41: a SUPPORTED claim needs
 * a canary that ran; this module makes no such claim at all). `route()` is a pure function of a task
 * class, a capability register and an availability map the CALLER already gathered — nothing here opens
 * a socket, spawns anything, reads an environment variable or reads a clock to answer (anti-drift item
 * 38's "no timing or exit code is an input" holds here too, one level up from where it was written).
 * `available` is evidence the caller collected before calling in — a signed-in CLI, a resolved binary, a
 * variable's presence — never gathered by this module itself. A caller that wants to know whether a
 * family is actually reachable runs its own cheap probe first and hands the answer in as data.
 *
 * ⛔ HOOK-BEARING WORK NEVER LEAVES THE HOOKED FAMILY (anti-drift item 54, owner decision item 24). A
 * task session is a Claude Code session with the pack's own hooks armed; an offload is a bounded,
 * hookless unit with a receipt. Nothing else carries the hooks, so a caller about to run a hook-bearing
 * session — never a bounded offload — passes `requiresHooks: true`, which restricts the candidate SET to
 * `HOOKED_FAMILY` before anything else happens: before ranking, and before `prefer` is even considered.
 * A register that rates a different family `preferred` for the task class does not change this, and
 * neither does an explicit `prefer` naming a model in a different family — `requiresHooks` is a
 * structural restriction on the pool a choice can be made from, not a preference that a stronger rating
 * or an operator's override can outrank. See the item-54 test in core/core.test.mjs: a register that
 * rates another family `preferred` for coding still routes a hooked task to `HOOKED_FAMILY`.
 *
 * ⛔ A RATING IS NOT AVAILABILITY, AND AVAILABILITY IS NOT A RATING. The register says which model the
 * dated evidence favours; `available` says which family this machine can actually reach right now. A
 * family the register prefers and the caller could not reach is `skipped`, with the caller's own reason
 * carried on the result — never silently dropped, and never promoted to a choice because nothing else
 * looked better on paper. A family this module receives no report on at all is treated the same as one
 * reported `ok: false`: a caller that forgot to report on a family gets that family skipped, not
 * silently routed to.
 *
 * ⛔ NOTHING HERE IS A CLOCK, A KEY OR A PROCESS. There is no `require` in this file at all — every fact
 * this module acts on arrives as an argument, and every fact it reports is derived from that argument.
 * That is what lets a receipt writer call this from anywhere without granting it a single new capability.
 */

// The register schema's own eight-class enum, in the schema's declared order.
// kernel/schema.test.mjs fences this array against schemas/capability-register.schema.json's
// $defs.taskClass.enum in both directions, so a class this module can be asked to route and the register
// cannot answer — or the reverse — is a test failure rather than a silent fallback.
const TASK_CLASSES = ['coding', 'review', 'security-testing', 'long-context', 'planning', 'writing', 'research', 'extraction'];

// Priority order, best evidence first. A lower index always beats a higher one.
const RATINGS = ['preferred', 'capable', 'unproven'];

// The family whose sessions carry the pack's hooks. See the banner above and anti-drift item 54: a
// hook-bearing session must never route anywhere else, whatever the register or the caller prefers.
const HOOKED_FAMILY = 'anthropic';

const RATING_RANK = { preferred: 2, capable: 1, unproven: 0 };
// "restricted" carries no rank here: it is excluded from ranking entirely, below, and is reachable only
// through an explicit `prefer`.
const STATUS_RANK = { current: 1, legacy: 0 };

const isTaskClass = (v) => TASK_CLASSES.includes(v);

/**
 * The specific gap that makes this call unanswerable from the register's own declared vocabulary, or
 * null when there is none. Distinct from "no candidate remains" below: this fires before a single model
 * is looked at, and names the register itself as the thing missing evidence — never probed, only read.
 */
function vocabularyGapWhy(taskClass, register) {
  if (!register || typeof register !== 'object') {
    return 'no capability register was supplied; the general prompting practice applies';
  }
  if (!Array.isArray(register.taskClasses) || !register.taskClasses.includes(taskClass)) {
    return `the register does not carry "${taskClass}" in its task-class vocabulary; the general prompting practice applies`;
  }
  return null;
}

const registerAsOf = (register) => (register && typeof register.asOf === 'string' ? register.asOf : null);

/** The chosen family's prompting standard, read from the register's own families[] — never hard-coded. */
function practiceFor(register, familyId) {
  const families = register && Array.isArray(register.families) ? register.families : [];
  const f = families.find((x) => x && x.id === familyId);
  return f && typeof f.promptingPractice === 'string' ? f.promptingPractice : null;
}

/** A model's rating record for one task class, or null when there is none worth ranking on. */
function ratingFor(model, taskClass) {
  const r = model && model.ratings && model.ratings[taskClass];
  if (!r || !RATINGS.includes(r.rating)) return null;
  return r;
}

function isAvailable(available, familyId) {
  const a = available && Object.prototype.hasOwnProperty.call(available, familyId) ? available[familyId] : null;
  return !!(a && a.ok === true);
}

/**
 * Every family the register declares that the caller did not report as available, each with the
 * caller's own reason — never invented beyond a named default for a family the caller said nothing
 * about at all.
 */
function skippedFamilies(register, available) {
  const families = register && Array.isArray(register.families) ? register.families : [];
  const out = [];
  for (const f of families) {
    if (!f || typeof f.id !== 'string' || isAvailable(available, f.id)) continue;
    const a = available && available[f.id];
    out.push({ family: f.id, why: (a && typeof a.why === 'string' && a.why) || `no availability was reported for ${f.id}` });
  }
  return out;
}

/**
 * Rank the eligible members of `pool` for `taskClass`. Excludes `status: "restricted"` models — those
 * are reachable only through an explicit `prefer`, handled by the caller of this function, above it in
 * `route()`, never by ranking. Sort key: rating (preferred > capable > unproven), then status (current >
 * legacy), then `pool`'s own order — which is the register's own order, since nothing above this point
 * reorders it. No key this module invents ever breaks a tie; the register's order is the last word.
 */
function rankCandidates(pool, taskClass) {
  const eligible = [];
  pool.forEach((model, idx) => {
    if (!model || model.status === 'restricted') return;
    const r = ratingFor(model, taskClass);
    if (!r) return;
    eligible.push({ model, rating: r.rating, idx });
  });
  eligible.sort((a, b) => {
    const byRating = RATING_RANK[b.rating] - RATING_RANK[a.rating];
    if (byRating) return byRating;
    const byStatus = (STATUS_RANK[b.model.status] ?? 0) - (STATUS_RANK[a.model.status] ?? 0);
    if (byStatus) return byStatus;
    return a.idx - b.idx;
  });
  return eligible;
}

const toAlternative = ({ model, rating }) => ({ family: model.family, model: model.id, rating, why: `${model.id} is ${rating} (${model.status})` });

/**
 * Route one task class to a family and model, given evidence the caller already gathered.
 *
 * @param {string} taskClass - one of TASK_CLASSES. An unknown value throws: asking to route a class
 *   this module has never heard of is a programming error, not an outcome to report.
 * @param {object} register - a document shaped like spine/reference/models/capability-register.json.
 *   Read only, never validated against its schema here (kernel/schema.test.mjs owns that) and never
 *   loaded from disk here — core/ touches no host (anti-drift item 36); the caller reads the file.
 * @param {object} available - `{ [familyId]: { ok: boolean, why: string } }`, supplied by the caller
 *   and never probed here. A family absent from this map reads the same as `ok: false`.
 * @param {object} [opts]
 * @param {boolean} [opts.requiresHooks=false] - restrict routing to HOOKED_FAMILY (anti-drift item 54).
 *   Applied before `prefer` is even looked at, so `prefer` can never pull a hooked session off it.
 * @param {string|null} [opts.prefer=null] - a model id the caller wants, honoured when it survives the
 *   `requiresHooks` restriction and is available — including a `status: "restricted"` model, which no
 *   other path may select.
 * @returns {{family:string, model:string|null, rating:string, why:string, asOf:string|null,
 *   practice:string|null, alternatives:Array<{family:string,model:string,rating:string,why:string}>,
 *   skipped:Array<{family:string,why:string}>}}
 */
function route(taskClass, register, available, { requiresHooks = false, prefer = null } = {}) {
  if (!isTaskClass(taskClass)) throw new Error(`unknown task class: ${taskClass}`);

  const gap = vocabularyGapWhy(taskClass, register);
  if (gap) {
    return {
      family: HOOKED_FAMILY, model: null, rating: 'unproven', why: gap,
      asOf: registerAsOf(register), practice: practiceFor(register, HOOKED_FAMILY),
      alternatives: [], skipped: [],
    };
  }

  const models = Array.isArray(register.models) ? register.models : [];
  const skipped = skippedFamilies(register, available);

  // requiresHooks restricts the CANDIDATE SET first — before prefer, before ranking. Nothing below this
  // line ever sees a non-hooked candidate when the caller is about to run a hooked session.
  const familyPool = requiresHooks ? models.filter((m) => m && m.family === HOOKED_FAMILY) : models;
  const pool = familyPool.filter((m) => isAvailable(available, m.family));
  const ranked = rankCandidates(pool, taskClass);

  const hooksNote = requiresHooks
    ? ` requiresHooks restricted routing to ${HOOKED_FAMILY}, the family whose sessions carry the pack's hooks.`
    : '';

  if (prefer) {
    const chosen = pool.find((m) => m && m.id === prefer);
    const r = chosen && ratingFor(chosen, taskClass);
    if (chosen && r) {
      return {
        family: chosen.family, model: chosen.id, rating: r.rating,
        why: `the caller named "${prefer}" explicitly via prefer, and it is available.${hooksNote} the caller's choice stands over the ranked candidates.`,
        asOf: registerAsOf(register), practice: practiceFor(register, chosen.family),
        alternatives: ranked.filter((c) => c.model.id !== prefer).map(toAlternative),
        skipped,
      };
    }
    // prefer named a model outside the eligible pool — the wrong family under requiresHooks, an
    // unavailable family, or an id the register does not carry. prefer simply does not win, and routing
    // falls through to ordinary ranking below, exactly as if nothing had been preferred.
  }

  if (!ranked.length) {
    return {
      family: HOOKED_FAMILY, model: null, rating: 'unproven',
      why: `no available model carries evidence for ${taskClass}; the general prompting practice applies`,
      asOf: registerAsOf(register), practice: practiceFor(register, HOOKED_FAMILY),
      alternatives: [], skipped,
    };
  }

  const winner = ranked[0];
  return {
    family: winner.model.family, model: winner.model.id, rating: winner.rating,
    why: `${winner.model.id} is ${winner.rating} (${winner.model.status}) for ${taskClass}, the best-ranked available candidate.${hooksNote}`,
    asOf: registerAsOf(register), practice: practiceFor(register, winner.model.family),
    alternatives: ranked.slice(1).map(toAlternative),
    skipped,
  };
}

module.exports = { TASK_CLASSES, RATINGS, HOOKED_FAMILY, route };
