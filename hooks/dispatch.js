#!/usr/bin/env node
/*
 * RespawnPack · dispatch.js — ONE PROCESS PER PreToolUse REGISTRATION GROUP (P4-T-15b).
 *
 * NOT A GOVERNANCE HOOK. It enforces nothing of its own and carries no rule id. It is the entry point
 * that runs the guards, which is why `counts-fence.test.mjs` excludes it from the governance-hook count
 * by name rather than counting it as a sixteenth guard — see that file's exclusion note.
 *
 * ⛔ WHAT THIS EXISTS TO END, MEASURED. The hooks-and-install audit §4a/§4b: one plain Bash tool call spawns four
 * Node processes and one `git commit` spawns five, each re-paying the process floor, each re-reading the
 * same stdin, each resolving the same posture out of the same `respawnpack.config.json`, and three of
 * them re-establishing the same index identity through the same git subprocesses. Worse than the cost:
 * the pack's docs claimed an ORDER those parallel processes never had. Four hooks racing to stdout have
 * no declared order, so "index-guard runs before push-guard" was a sentence with nothing behind it.
 *
 * ⭐ WHAT IT DOES. For one registration group it reads stdin ONCE, resolves the posture ONCE per distinct
 * project root — and, since P1-E-1d, the project's declared EXCEPTIONS the same way — builds each
 * check's own `ctx`, calls every check's pure `check(ctx)` (P4-T-15a) in a DECLARED order, and merges
 * the verdicts most-restrictive-wins into ONE document. Every hook it calls stays runnable standalone
 * and is still wired that way under `strict`.
 *
 * ═══ THE DECLARED ORDER, AND WHY IT IS THE SNIPPET'S OWN ═══════════════════════════════════════════
 *
 * `ORDER` below is the order `hooks/settings.snippet.json` already registers these hooks in. That is a
 * decision, not a coincidence:
 *   • A founder reading `settings.json` can see the order. An order invented here would be a second
 *     ordering, visible only in this file, disagreeing with the one on their disk.
 *   • It is the order `strict` still runs them in, so a target that flips `light` → `strict` does not
 *     change which reason it reads first.
 *   • The order cannot change WHICH decision comes out. A `deny` from any check beats an `allow`, an
 *     `ask` or an `updatedInput` from any other REGARDLESS of position — that is the merge rule below
 *     and the fence in `hooks/hooks.test.mjs` drives it in both directions. Order decides only the
 *     sequence advisory text is concatenated in, and which rewrite wins if two checks ever rewrite.
 *
 * ⛔ EVERY CHECK SEES THE ORIGINAL INPUT. THE SAFE DEFAULT, TAKEN DELIBERATELY.
 *
 * A rewritten `updatedInput` from one check is NOT fed to the checks after it, and a `deny` is computed
 * against the input the host actually asked about. Two reasons, and the second is the one that matters:
 *   • It is what the four parallel processes did. Chaining rewrites would make the dispatcher decide
 *     something the multi-hook wiring never decided, inside a task whose whole promise is that both
 *     wirings reach the same verdict.
 *   • A chained rewrite is a guard-defeating channel. A check that rewrote `rm -rf /` into something
 *     benign would walk the command past every guard declared after it. Nothing in the pack does that
 *     today; the point is that the dispatcher must not be the thing that makes it POSSIBLE.
 * The cost is named rather than hidden: a rewrite is judged by nobody, so a check that rewrites must be
 * safe on its own. `docker-session-tag`'s label splice is the only rewrite in a dispatched group, it is
 * last in the declared order, and `install/install.test.mjs` fences that at most one check per group can
 * rewrite at all.
 *
 * ⛔ AND A DENY DROPS THE REWRITE. The tool will not run, so a rewritten input for it is noise; carrying
 * one would also be the only shape in which a rewrite could outlive the refusal that beat it.
 *
 * ═══ THE ARMING POSTURE — ANTI-DRIFT ITEM 27 ═══════════════════════════════════════════════════════
 *
 * `_boot.js`'s degradation posture was per-HOOK. A dispatcher makes it per-GROUP, so the posture it arms
 * must be the MOST CONSERVATIVE among the checks it is about to run. `boot.arm('deny')` fires literally,
 * on the first line of executable code, BEFORE any check module is required — because the window a
 * broken module can open is the require itself. `postureFor()` then recomputes it from the group and
 * re-arms only if the group is genuinely quieter. Both shipped groups compute `deny`, and item 27's own
 * four names (index-guard, push-guard, secret-scan, shell-guard) are fenced to `deny` in `CHECKS`.
 *
 * ⛔ THE COST, STATED. This is a single point of failure for a whole group: one check whose machinery
 * will not load takes the group's answer to `deny`, where the multi-hook wiring would have denied on
 * that hook alone and let the others speak. That is strictly more conservative, never less, and it is
 * the reason `strict` keeps the multi-hook wiring and the installer records which of the two it laid.
 *
 * ═══ WHAT IT DOES NOT COVER ════════════════════════════════════════════════════════════════════════
 *
 *   • `secret-scan`'s TWO Bash registrations stay two separate entries with their own `if` rules, in
 *     every profile. Anti-drift item 29: one permission rule per entry, never deduplicated. Folding
 *     them in would delete the host-side filter and hand `secret-scan` every Bash command instead of
 *     the two spellings it is registered for — a widening of a security scan, decided by a wiring task.
 *     So a dispatched `git commit` is 2 processes, not 1, and this file says so rather than the number
 *     the estimate wanted.
 *   • The one-hook groups (`spawn-guard` at Agent|Task, `websearch-freshness` at WebSearch) stay as
 *     they are. They are already exactly one command; wrapping them would add a module load and remove
 *     a standalone path to save nothing.
 *   • Events other than PreToolUse. `check(ctx)` exists on the PreToolUse hooks only (P4-T-15a).
 *
 * ═══ THE OUTPUT CONTRACT ═══════════════════════════════════════════════════════════════════════════
 *
 * `_harness.mjs`'s `CONTRACT` table is the DF-002 fence (anti-drift item 28) and every document this
 * file emits is validated against it in `hooks/hooks.test.mjs`. It is deliberately NOT copied here:
 * `_harness.mjs` is a test harness, is not installed, and a second transcription of the published
 * contract is the list that drifts. What this file does instead is structural — it emits only fields it
 * built, and it passes an unrecognised field through VERBATIM rather than swallowing it, so a check that
 * invents a channel fails the fence loudly instead of going quiet the way DF-002 did for months.
 *
 * ⛔ THE REGISTRATION NAMES THE GUARDS IT RUNS, AND THAT IS LOAD-BEARING TWICE OVER.
 *
 * The settings entry is
 * `node .../dispatch.js PreToolUse bash --covers push-guard.js,index-guard.js,shell-guard.js,docker-session-tag.js`,
 * not the bare group name. Measured before the `--covers` list existed: `doctor` on a target running the
 * dispatcher reported `hook:lockdown.js`, `hook:worktree-guard.js`, `hook:push-guard.js`,
 * `hook:shell-guard.js` and `hook:docker-session-tag.js` as `SILENTLY INACTIVE - on disk and valid but
 * NOT wired in .claude/settings.json - it will never run`, and the whole report went from PASS to
 * CANNOT_DETERMINE. Every one of those rows was FALSE: the guards run, in one process, through this
 * file. A diagnostic that says a live guard will never run is worse than one that says nothing, and
 * `kernel/respawnpack.js`'s own wiring reader already documents the answer - it keeps a raw-JSON
 * substring fallback "so a spelling this regex does not know still counts as wired rather than being
 * called silently inactive". Naming the guards in the command is that spelling. It also means a founder
 * reading their own `settings.json` can see which guards one entry runs, in the declared order.
 *
 * ⛔ AND THE LIST CAN NEVER REDUCE WHAT RUNS. `GROUPS` below decides; `--covers` is checked against
 * it and a disagreement is reported on stderr, never obeyed. A settings file that could shorten the
 * guard set would be a way to switch off `index-guard:control-plane` by editing one string, which is
 * anti-drift item 22 with an extra step.
 *
 * Usage:  node .claude/hooks/dispatch.js PreToolUse <group> [--covers a.js,b.js]   (stdin = the JSON)
 */
const boot = require('./_boot.js');
/*
 * ⛔ FIRST, AND LITERAL. Two things depend on this exact spelling: `_boot`'s net has to be installed
 * before the first `require` of a check can throw past it, and `install/install.test.mjs`'s degradation
 * matrix reads the posture out of this source with `/boot\.arm\('([\w-]+)'\)/`. A computed argument here
 * would leave this file with no declared posture in that matrix.
 */
boot.arm('deny');

/** The published PreToolUse decision words, most restrictive first. */
const RANK = { deny: 0, ask: 1, allow: 2 };

/**
 * ⛔ EVERY CHECK THIS FILE MAY RUN, AND THE DEGRADATION POSTURE IT DECLARES.
 *
 * The posture is the one the hook itself arms — `install/install.test.mjs` fences this table against the
 * `boot.arm('…')` literal in each hook's own source, so a hook that changes posture cannot leave a stale
 * copy here.
 *
 * ⛔ ONE OF THESE ARMS NOTHING, AND THAT IS A CHECKED FACT RATHER THAN A GUESS. `lockdown` requires
 * nothing out of this directory: no shared module, no `_boot` boundary, and therefore no posture of its
 * own to copy. The same fence asserts it, by requiring that a check with no `boot.arm()` also has no
 * `boot.need()`. What its entry has to satisfy is item 27, not a blanket value: `advisory` can only ever
 * be raised by a group-mate, never lowered, because `postureFor` takes the most conservative.
 *
 * ⛔ AND TWO OF THEM STOPPED ARMING NOTHING AT P1-E-1d. `shell-guard` and `worktree-guard` now read the
 * project's declared exceptions through `_boot.need('./_exceptions.js')`, which gives them a shared
 * dependency and therefore a posture to declare. Both arm `deny`, in the one direction that matters
 * here: a reader that will not load must leave the guard REFUSING, never lifting. `shell-guard` was
 * already `deny` in this table (item 27 names it, and item 25 puts it in the security column);
 * `worktree-guard` moved from `advisory` to `deny` to match the literal in its own source, which is a
 * tightening its group already had from `index-guard` and changes no group's armed posture.
 */
const CHECKS = {
  'lockdown.js': { posture: 'advisory' },
  'worktree-guard.js': { posture: 'deny' },
  'index-guard.js': { posture: 'deny' },
  'push-guard.js': { posture: 'deny' },
  'shell-guard.js': { posture: 'deny' },
  'docker-session-tag.js': { posture: 'deny' },
};

/**
 * ⛔ ITEM 27'S OWN FOUR NAMES, QUOTED. "…`deny` for PreToolUse whenever index-guard, push-guard,
 * secret-scan or shell-guard is enabled by the profile." Carried here so the fence in
 * `install/install.test.mjs` checks the table above against the anti-drift item rather than against a
 * second opinion about which hooks are safety-critical. `secret-scan` is in the list and not in a group,
 * which is the recorded consequence of keeping its two `if` registrations separate.
 */
const ITEM_27_DENY = ['index-guard.js', 'push-guard.js', 'secret-scan.js', 'shell-guard.js'];

/**
 * The registration groups this dispatcher answers for, keyed by the argv name the settings entry
 * carries. `matcher` is the group's matcher in `hooks/settings.snippet.json`, reproduced so
 * `install/_settings-manifest.js` can find the group it substitutes without a second hand-written map.
 * `order` IS the declared order — see the header for why it is the snippet's own.
 */
const GROUPS = {
  edit: {
    event: 'PreToolUse',
    matcher: 'Edit|Write|MultiEdit|NotebookEdit',
    order: ['lockdown.js', 'worktree-guard.js', 'index-guard.js'],
  },
  bash: {
    event: 'PreToolUse',
    matcher: 'Bash',
    order: ['push-guard.js', 'index-guard.js', 'shell-guard.js', 'docker-session-tag.js'],
  },
};

/** The declared order for one group, or null when the name is not one this file knows. */
const ORDER = (group) => (Object.prototype.hasOwnProperty.call(GROUPS, group) ? GROUPS[group].order.slice() : null);

/**
 * The most conservative declared posture among these checks (anti-drift item 27).
 * An unknown name cannot be proved quiet, so it counts as `deny`.
 */
function postureFor(names) {
  let worst = 'advisory';
  for (const n of names || []) {
    const declared = Object.prototype.hasOwnProperty.call(CHECKS, n) ? CHECKS[n].posture : 'deny';
    if (declared === 'deny') return 'deny';
    if (declared === 'session-start') worst = 'session-start';
  }
  return worst;
}

/*
 * ⛔ ONE THUNK PER CHECK, EACH SPELLING ITS REQUIRE THE PACK'S OWN WAY: `require('./x.js')`.
 *
 * Not `require(path.join(__dirname, name))`, which resolves identically and is invisible to every
 * dependency derivation in this repository — doctor's graph (`kernel/lib/modhealth.js`'s
 * `siblingRequires`), the counts fence's installer/uninstaller/docs reconciliation, and
 * `install/install.test.mjs`'s degradation matrix all read the LITERAL form. Written the other way,
 * this dispatcher would have appeared to depend on nothing but `_boot.js`, and the matrix that proves a
 * broken `_shell.js` still produces a DENY would have skipped the one entry point that answers for four
 * guards at once. That is the exact mistake `_boot.js`'s own header records, one directory over.
 *
 * They are THUNKS because the load must stay lazy: a group loads its own checks and nothing else, which
 * is most of what "one process" buys over four.
 */
const LOADERS = {
  'lockdown.js': () => require('./lockdown.js'),
  'worktree-guard.js': () => require('./worktree-guard.js'),
  'index-guard.js': () => require('./index-guard.js'),
  'push-guard.js': () => require('./push-guard.js'),
  'shell-guard.js': () => require('./shell-guard.js'),
  'docker-session-tag.js': () => require('./docker-session-tag.js'),
};

/**
 * Load the group's check modules, in declared order.
 *
 * ⛔ A CHECK THAT WILL NOT LOAD DEGRADES THE GROUP, IT DOES NOT VANISH FROM IT. `boot.need()` already
 * covers a broken SHARED module (the hook degrades as it loads, at exit 0, in the armed posture). This
 * covers the hook file itself: a missing or unparseable `index-guard.js` would otherwise throw into
 * `_boot`'s last-resort net, which degrades UNATTRIBUTABLY and tells the operator the fault may be in
 * the dispatcher. It is not, and it is named.
 */
function loadChecks(names) {
  const loaded = [];
  for (const name of names) {
    let mod;
    if (typeof LOADERS[name] !== 'function') {
      boot.degrade(`this dispatcher declares the check ${name} in a group but carries no loader for it, so it ran nothing for that check`, false);
      return loaded;
    }
    try { mod = LOADERS[name](); }
    catch (e) {
      boot.degrade(`the check ${name} could not be loaded — ${(e && e.constructor && e.constructor.name) || 'Error'}: `
        + `${String((e && e.message) || e).split(/\r?\n/)[0].trim().slice(0, 200)}. The group it belongs to cannot be judged without it`);
      return loaded; // unreachable: degrade() never returns. Kept so the control flow reads honestly.
    }
    if (!mod || typeof mod.check !== 'function' || typeof mod.context !== 'function') {
      boot.degrade(`the check ${name} loaded but exports no check(ctx)/context(input) pair, so this dispatcher has nothing to call for it`);
      return loaded;
    }
    loaded.push({ name, mod });
  }
  return loaded;
}

/**
 * ⛔ THE POSTURE IS READ ONCE PER DISTINCT PROJECT ROOT, WHICH IS NOT THE SAME CLAIM AS "ONCE".
 *
 * The nine PreToolUse hooks do not agree on how they find a project root, and `hooks/README.md`'s
 * `check(ctx)` section says so in as many words: `index-guard` takes `_runtime.projectRoot(input)`, the
 * rest take `CLAUDE_PROJECT_DIR || cwd`, and `worktree-guard` walks up from where the session sits.
 * P4-T-15a deliberately left that unreconciled and named this task as the place to decide it.
 *
 * The decision is: DO NOT RECONCILE THEM. Each check keeps its own resolution, because changing one
 * would change what that guard judges — silently, inside a wiring task, in a direction nobody measured.
 * What IS shared is the READ: the first check to touch `ctx.profile` resolves through its OWN hook's
 * getter, and every later check under the SAME root is handed that answer instead of re-reading
 * `respawnpack.config.json`. Three reads become one where the roots agree, and stay separate where they
 * do not — so one decision can never be judged under two policies, and two different roots can never be
 * judged under one.
 *
 * Laziness survives: a group whose checks consult no posture reads the config zero times, exactly as
 * `hooks/README.md` promises the lazy getter does today.
 *
 * ⭐ AND THE SAME SENTENCE NOW HOLDS FOR `ctx.exceptions` (P1-E-1d), through the same helper and a
 * SEPARATE cache. Same claim, same laziness, same per-root scope; separate because the posture and the
 * exception list are two questions answered by two modules with two fail-closed directions, and one
 * cache holding both would make an unreadable posture and a refused allowance indistinguishable.
 */
function shareLazy(ctx, key, cache) {
  const d = Object.getOwnPropertyDescriptor(ctx, key);
  // A DATA property (or none at all) is a hook that declares it has nothing to ask — the fixed-rule
  // checks hold `profile: null` on purpose, and a check that consults no declaration carries no
  // `exceptions` getter. Wrapping either would invent a consult the hook does not make.
  if (!d || typeof d.get !== 'function') return ctx;
  const own = d.get;
  const root = ctx.projectDir;
  Object.defineProperty(ctx, key, {
    configurable: true,
    enumerable: d.enumerable,
    get() {
      if (!cache.has(root)) cache.set(root, own.call(ctx));
      return cache.get(root);
    },
  });
  return ctx;
}

/** The posture, shared per distinct project root. Kept as its own name: it is what callers ask for. */
const shareProfile = (ctx, cache) => shareLazy(ctx, 'profile', cache);

/**
 * ⭐ AND THE DECLARED EXCEPTIONS, THE SAME WAY AND FOR THE SAME REASON (P1-E-1d).
 *
 * Four of the Bash and editor checks now ask `hooks/_exceptions.js` whether the founder has named the
 * subject in front of them. That is a second read of `respawnpack.config.json` per check, and it needs
 * the same guarantee the posture has: ONE resolution per distinct project root, so a file that changes
 * between two reads inside a single decision cannot let one guard lift on a declaration another guard
 * never saw. It is a SEPARATE cache from the posture's because they are separate questions read by
 * separate modules, and their fail-closed directions differ — an unreadable posture resolves to the
 * strictest profile, an unreadable exception list lifts nothing.
 */
const shareExceptions = (ctx, cache) => shareLazy(ctx, 'exceptions', cache);

/** Run the loaded checks in declared order and collect `{name, verdict}` for each. */
function runChecks(input, loaded) {
  const profiles = new Map();
  const exceptions = new Map();
  const results = [];
  for (const { name, mod } of loaded) {
    const ctx = shareExceptions(shareProfile(mod.context(input), profiles), exceptions);
    results.push({ name, verdict: mod.check(ctx) || null });
  }
  return results;
}

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const joinParts = (parts) => {
  const seen = new Set();
  const out = [];
  for (const p of parts) {
    const s = typeof p === 'string' ? p : (p === undefined || p === null ? '' : String(p));
    if (!s || seen.has(s)) continue; // a reason repeated by two checks is one reason, printed once
    seen.add(s);
    out.push(s);
  }
  return out.length ? out.join('\n\n') : null;
};

/**
 * MOST-RESTRICTIVE-WINS, over the verdicts in DECLARED order.
 *
 *   decision   the minimum rank present. `deny` < `ask` < `allow`, and a word this table does not know
 *              cannot be proved less restrictive than a deny, so it ranks with `deny` and is passed
 *              through verbatim rather than translated into one.
 *   reason     every reason at the WINNING rank, in declared order. Not just the first: two guards that
 *              both refuse have two things to tell the founder, and dropping one would make the second
 *              refusal invisible until they fixed the first.
 *   context    every `additionalContext`, in declared order.
 *   message    every top-level `systemMessage`, in declared order.
 *   rewrite    `updatedInput`, shallow-merged in declared order, and ONLY when nothing denied or asked.
 *
 * Anything else a check emits is carried through unchanged (first in declared order wins), because the
 * one behaviour a merge must never have is to make an illegal field quietly legal — that is DF-002.
 */
function merge(results, event = 'PreToolUse') {
  const kept = (results || []).filter((r) => r && isObject(r.verdict));
  if (!kept.length) return null;

  const rankOf = (word) => (Object.prototype.hasOwnProperty.call(RANK, word) ? RANK[word] : RANK.deny);
  const decided = kept.filter((r) => isObject(r.verdict.hookSpecificOutput) && r.verdict.hookSpecificOutput.permissionDecision);

  let decision = null;
  let reason = null;
  if (decided.length) {
    const best = Math.min(...decided.map((r) => rankOf(r.verdict.hookSpecificOutput.permissionDecision)));
    const winners = decided.filter((r) => rankOf(r.verdict.hookSpecificOutput.permissionDecision) === best);
    const words = winners.map((r) => r.verdict.hookSpecificOutput.permissionDecision);
    decision = words.includes('deny') ? 'deny' : words[0];
    reason = joinParts(winners.map((r) => r.verdict.hookSpecificOutput.permissionDecisionReason));
  }

  const additionalContext = joinParts(kept.map((r) => r.verdict.hookSpecificOutput && r.verdict.hookSpecificOutput.additionalContext));
  const systemMessage = joinParts(kept.map((r) => r.verdict.systemMessage));

  // ⛔ A REFUSAL DROPS EVERY REWRITE. See the header: the tool does not run, and a rewrite that outlived
  // the refusal that beat it would be the one shape in which order could change the outcome.
  let updatedInput = null;
  if (decision !== 'deny' && decision !== 'ask') {
    for (const r of kept) {
      const u = r.verdict.hookSpecificOutput && r.verdict.hookSpecificOutput.updatedInput;
      if (isObject(u)) updatedInput = { ...(updatedInput || {}), ...u };
    }
  }

  const hso = { hookEventName: event };
  if (decision) hso.permissionDecision = decision;
  if (reason) hso.permissionDecisionReason = reason;
  if (additionalContext) hso.additionalContext = additionalContext;
  if (updatedInput) hso.updatedInput = updatedInput;

  // Fields this merge did not build: carried through, never invented and never swallowed.
  const out = {};
  for (const r of kept) {
    for (const [k, v] of Object.entries(r.verdict)) {
      if (k === 'systemMessage' || k === 'hookSpecificOutput') continue;
      if (k === 'continue' && v === false) { out.continue = false; continue; } // the most restrictive answer wins
      if (!Object.prototype.hasOwnProperty.call(out, k)) out[k] = v;
    }
    for (const [k, v] of Object.entries(r.verdict.hookSpecificOutput || {})) {
      if (['hookEventName', 'permissionDecision', 'permissionDecisionReason', 'additionalContext', 'updatedInput'].includes(k)) continue;
      if (!Object.prototype.hasOwnProperty.call(hso, k)) hso[k] = v;
    }
  }
  if (systemMessage) out.systemMessage = systemMessage;
  if (Object.keys(hso).length > 1) out.hookSpecificOutput = hso;

  // Nothing to say is silence, not an empty envelope: `{hookSpecificOutput:{hookEventName}}` is a
  // document that claims to answer and answers nothing.
  return Object.keys(out).length ? out : null;
}

/**
 * The whole pass for one group: arm, load, run, merge. Returns the merged document or null.
 * Writes no stdout and exits no process — the standalone entry point below does both, exactly the way
 * every check's own `check(ctx)` leaves those to its caller.
 */
function dispatch(group, input) {
  const spec = Object.prototype.hasOwnProperty.call(GROUPS, group) ? GROUPS[group] : null;
  if (!spec) {
    boot.degrade(`this dispatcher was registered for the group "${String(group).slice(0, 60)}", which it does not know. `
      + 'It therefore ran NO check for this tool call, and "no check ran" is not "the call is safe"', false);
    return null; // unreachable: degrade() never returns.
  }
  boot.observed(spec.event);
  /*
   * ⛔ RE-ARM ONLY DOWNWARD-SAFE. `deny` is already armed above, so this call fires only for a group
   * whose checks are ALL quieter than that — never to loosen a group that holds one of item 27's four.
   * A second `arm('deny')` would also stack a duplicate process-level listener for no gain.
   */
  const armed = postureFor(spec.order);
  if (armed !== 'deny') boot.arm(armed);

  return merge(runChecks(input, loadChecks(spec.order)), spec.event);
}

/**
 * Compare the registration's `--covers` list against the group's own order.
 *
 * Returns a complaint string, or null when they agree. It NEVER changes what runs: this is a report,
 * because the only direction a settings file may move a guard set is not at all.
 */
function coverageComplaint(group, covers) {
  const spec = Object.prototype.hasOwnProperty.call(GROUPS, group) ? GROUPS[group] : null;
  if (!spec || covers === null) return null; // no list given: an older registration, or a direct call
  const declared = spec.order.slice().sort();
  const named = covers.slice().sort();
  if (JSON.stringify(declared) === JSON.stringify(named)) return null;
  const missing = declared.filter((c) => !named.includes(c));
  const extra = named.filter((c) => !declared.includes(c));
  return `the settings entry for group "${group}" says it covers [${named.join(', ')}], and this dispatcher runs [${declared.join(', ')}]`
    + `${missing.length ? ` · not named by the registration: ${missing.join(', ')} (they still ran)` : ''}`
    + `${extra.length ? ` · named but not run: ${extra.join(', ')}` : ''}`
    + ' · the dispatcher\'s own table decides what runs, so this is a stale or hand-edited registration to re-lay, not a guard that was skipped';
}

/** `--covers a.js,b.js` out of an argv tail, or null when the registration carries none. */
function coversFrom(argv) {
  const i = (argv || []).indexOf('--covers');
  if (i < 0 || typeof argv[i + 1] !== 'string') return null;
  return argv[i + 1].split(',').map((c) => c.trim()).filter(Boolean);
}

module.exports = { GROUPS, CHECKS, ITEM_27_DENY, RANK, LOADERS, ORDER, postureFor, shareLazy, shareProfile, shareExceptions, loadChecks, runChecks, merge, dispatch, coversFrom, coverageComplaint };

// --- standalone entry point: `node dispatch.js <event> <group>`, PreToolUse JSON on stdin -----------
if (require.main === module) {
  const event = process.argv[2] || 'PreToolUse';
  const group = process.argv[3] || '';
  let raw = '';
  process.stdin.on('data', (d) => (raw += d));
  process.stdin.on('end', () => {
    let input;
    // Unparseable stdin never blocks a turn — the same answer every hook in this directory gives, and
    // the reason the contract sweep feeds all of them garbage.
    try { input = JSON.parse(raw || '{}'); } catch { process.exit(0); }
    /*
     * ⛔ THE EVENT ARGUMENT MUST AGREE WITH THE GROUP, and a mismatch is a mis-wiring rather than an
     * input error: a settings entry that names this dispatcher under an event its group does not answer
     * would otherwise run PreToolUse guards and emit a PreToolUse document on, say, PostToolUse — which
     * is DF-002 with a different hook's name on it.
     */
    const spec = Object.prototype.hasOwnProperty.call(GROUPS, group) ? GROUPS[group] : null;
    if (spec && event !== spec.event) {
      /*
       * ⛔ AND `observed()` COMES FIRST, WHICH IS THE WHOLE POINT OF THE BRANCH. Without it `degrade()`
       * would still be holding `event === null`, take its PreToolUse deny path, and emit a
       * permissionDecision on an event that has no such channel — DF-002 committed by the very code
       * refusing to commit it. Told the real event, the deny posture falls through to stderr and this
       * mis-wiring says why and stays silent, which is the only legal answer on an event it cannot
       * speak on.
       */
      boot.observed(event);
      boot.degrade(`this dispatcher was registered under "${String(event).slice(0, 40)}" for the group "${group}", which answers `
        + `"${spec.event}". It ran no check, and emitting a ${spec.event} document on another event is exactly the channel DF-002 was`, false);
    }
    // Reported before the run, so the complaint survives even if a check degrades the process.
    const complaint = coverageComplaint(group, coversFrom(process.argv.slice(4)));
    if (complaint) { try { process.stderr.write(`RespawnPack dispatch: ${complaint}\n`); } catch { /* stderr is gone */ } }
    const verdict = dispatch(group, input);
    if (verdict) process.stdout.write(JSON.stringify(verdict));
    process.exit(0);
  });
}
