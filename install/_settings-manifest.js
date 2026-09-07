/*
 * RespawnPack · install/_settings-manifest.js — THE PROFILE MANIFEST: (profile, event) → entries.
 *
 * NOT AN INSTALLED FILE, AND NOT A HOOK (leading underscore). It is required by `install/install.js`,
 * whose settings merge composes through it, and smoke-checked by `install/upgrade.js`'s preflight so a
 * manifest that cannot compose is caught BEFORE phase 1 strips the target.
 *
 * ⛔ WHY THIS FILE EXISTS. `hooks/settings.snippet.json` is one fixed registration set: 13 groups and 22
 * entries, laid identically into every target regardless of what that project asked for. ADR-003 gives a
 * project three postures, and P3-T-10a/b/c made the rules themselves posture-aware from the inside — so
 * today a `light` project still starts a Node process for every hook on every matching tool call, and
 * some of those processes exist only to read the config and exit 0. Composition removes the entry rather
 * than the guard: an entry is omitted only where the hook behind it is WHOLLY INERT for that profile.
 *
 * ⛔ THE STRICT COLUMN IS THE SNIPPET, UNCHANGED, AND THAT IS THE POINT.
 *
 * `hooks/settings.snippet.json` is not rewritten into some new manifest format. It IS the strict column,
 * byte for byte, and this module is the projection of it onto the other two. That is the cheapest
 * possible proof of anti-drift item 35 ("an existing target with no `posture` key keeps today's exit
 * codes and a byte-identical composed `settings.json`"): under `strict` this module returns the same
 * entry objects it was handed, in the same order, so `JSON.stringify` of the composed set and of the
 * snippet cannot differ. A manifest that re-declared the strict column in a second file would have made
 * the freeze test a comparison between two hand-maintained lists — which is the defect P-002 is about,
 * one directory over.
 *
 * ⭐ INERTNESS IS DERIVED, NEVER LISTED. A hand-written "light omits mcp-reaper" table would agree with
 * ADR-003 on the day it was written and drift the first time a row moved columns. So the only thing
 * declared here is which RULE IDS each hook carries (`RULES_BY_HOOK`); whether an entry is inert is then
 * `every rule id resolves to off`, asked of `hooks/_posture.js` — the one reader, the same table every
 * rule consults at run time. Move a row in ADR-003's table, update the resolver, and composition follows
 * without anybody editing this file. `install/install.test.mjs` fences `RULES_BY_HOOK` against the
 * resolver in BOTH directions, so a new rule id that nobody assigns to a hook fails a test.
 *
 * ⛔ AN OVERRIDE NEVER CHANGES WHAT IS COMPOSED — the profile does, and only the profile.
 * The posture design note §5 item 4 is explicit: a per-guard override "changes no settings entry at all,
 * since the entry stays wired and the rule self-disables, so it is reversible by editing one file". A
 * founder who sets `mcp-reaper` to `off` by override has changed a verdict, not a wiring, and must be
 * able to change it back without an upgrade re-laying their settings.json. So `verdict()` is asked with
 * an EMPTY override map here, deliberately, and that is not an oversight to be tidied later.
 *
 * ⛔ AND AN UNKNOWN COMMAND IS NEVER OMITTED. A hook this table does not name composes into every
 * profile. The direction that cannot cause the harm this module exists to avoid is the one where a
 * mis-wired lookup keeps a guard wired; dropping an entry because nobody classified it would be a
 * silently disabled guard wearing a profile's name.
 *
 * ═══ THE TWO `if` NARROWINGS THE SPEC NAMES, AND WHY NEITHER SHIPS ═══════════════════════════════════
 *
 * The hooks-and-install audit §7 T-11 and the posture design note §4 both ask for two permission-rule narrowings, and
 * ADR-003 carries the first as its resolution 4. The `if` key itself is REAL: Claude Code documents it
 * at https://code.claude.com/docs/en/hooks under "Filter by tool name and arguments with the `if` field",
 * it takes permission-rule syntax, it is a sibling of `type`/`command`/`timeout` on an individual hook
 * object, and it works on tool events only (`PreToolUse`, `PostToolUse`, and the permission events) —
 * which is why `hooks/settings.snippet.json` already ships two of them on `secret-scan`. Support was not
 * the blocker. Both narrowings were measured against the hooks they would narrow, and both would have
 * switched off a rule that ADR-003 fixes in every posture:
 *
 *   • `docker-session-tag` with `"if": "Bash(docker *)"`. `hooks/docker-session-tag.js`'s `segLead()`
 *     strips env assignments and the benign launch prefixes `sudo|command|env|time|nice|nohup|exec`
 *     BEFORE it matches `docker run` / `docker create`, so the labelling rewrite covers `sudo docker run`
 *     and `FOO=bar docker run` today. `Bash(docker *)` filters on the command name, so those spellings
 *     would stop spawning the hook, the container would never be labelled, and `mcp-reaper` reaps BY
 *     that label — an unlabelled container is an unreaped one. That is anti-drift item 26 exactly, and
 *     item 26 is the reason the label rule is fixed in the first place. The legacy `docker-compose up -d`
 *     spelling is a second miss, live under `standard` where `docker-session-tag:advise` advises.
 *   • `index-guard`'s Bash entry with `"if": "Bash(git *)"` under `light`. The audit's premise is that
 *     index-guard's remaining rules there are git-only. They are not: the control-plane redirection
 *     refusal runs under `if (who.isSubagent && isBash)`, ahead of any git parsing, and refuses
 *     `echo … > .claude/hooks/lockdown.js` from a shared-checkout helper. `index-guard:control-plane` is
 *     fixed `deny` in every posture (anti-drift item 22), and `Bash(git *)` would silently remove it.
 *
 * A third reason covers `strict` for both: the snippet has no such key today, so adding one there would
 * break the byte-identity the freeze test pins (anti-drift item 35). The cost the narrowings were meant
 * to buy is real and the finding above does not dispose of it — narrowing `docker-session-tag` correctly
 * needs a rule that also names the wrapper spellings, which is an amendment to ADR-003's resolution 4
 * rather than something a task fenced by items 22 and 26 may decide on its own. Recorded, not silently
 * dropped: `IF_NARROWINGS_CONSIDERED` below carries it in source so the next reader finds the evidence
 * rather than the absence.
 */
const posture = require('../hooks/_posture.js');

/**
 * ⛔ EVERY RULE ID EACH HOOK CARRIES. The one thing this module declares by hand, and the fence in
 * `install/install.test.mjs` checks it against `hooks/_posture.js` in both directions: every hook-side id
 * the resolver or the fixed set names appears here exactly once, and every id here is one of those.
 *
 * Keyed by the hook file's basename, because that is what a settings entry's `command` actually carries.
 * `runtime:baseline` sits under `session-routing-nudge.js` because that is the hook that records the
 * SessionStart tree baseline (`hooks/session-routing-nudge.js`, via `_runtime.js`) — it is fixed in every
 * posture, so its placement changes no composition, and listing it is what keeps the fence total.
 */
const RULES_BY_HOOK = {
  'lockdown.js': ['lockdown'],
  'worktree-guard.js': ['worktree-guard'],
  'index-guard.js': [
    'index-guard:editor-containment', 'index-guard:no-bash', 'index-guard:unmodelled',
    'index-guard:wave-sweep', 'index-guard:foreign-staged', 'index-guard:writer-lease',
    'index-guard:control-plane',
  ],
  'push-guard.js': ['push-guard:tier1', 'push-guard:tier2'],
  'shell-guard.js': ['shell-guard:catastrophe'],
  'secret-scan.js': ['secret-scan'],
  'docker-session-tag.js': ['docker-session-tag:label', 'docker-session-tag:advise'],
  'spawn-guard.js': ['spawn-guard:ceiling'],
  'websearch-freshness.js': ['websearch-freshness'],
  'injection-scan.js': ['injection-scan'],
  'context-monitor.js': ['context-monitor'],
  'session-routing-nudge.js': ['session-routing-nudge:boot', 'runtime:baseline'],
  'stop-savepoint.js': ['stop-savepoint:detect', 'stop-savepoint:block'],
  'precompact-ledger-nudge.js': ['precompact:handoff-write', 'precompact:block'],
  'mcp-reaper.js': ['mcp-reaper'],
};

/**
 * The narrowings the spec named, the decision taken on each, and the evidence — carried in source so a
 * later reader finds a recorded refusal rather than an unexplained absence. See the header.
 */
const IF_NARROWINGS_CONSIDERED = [
  {
    hook: 'docker-session-tag.js',
    rule: 'Bash(docker *)',
    profiles: 'every profile (ADR-003 resolution 4)',
    shipped: false,
    why: 'segLead() strips sudo/command/env/time/nice/nohup/exec and FOO=bar before matching docker run, '
      + 'so the rule would stop spawning the hook on spellings the fixed docker-session-tag:label rewrite '
      + 'covers today; an unlabelled container is one mcp-reaper never reaps (anti-drift item 26). '
      + 'It would also break the strict column\'s byte-identity (anti-drift item 35).',
  },
  {
    hook: 'index-guard.js',
    rule: 'Bash(git *)',
    profiles: 'light',
    shipped: false,
    why: 'index-guard:control-plane runs for ANY Bash command from a subagent, ahead of git parsing, and '
      + 'is fixed deny in every posture (anti-drift item 22) — the audit\'s "remaining rules are git-only" '
      + 'premise does not hold against the code.',
  },
];

/*
 * ═══ THE SECOND PROJECTION: WHICH KERNEL LIBS A PROFILE PLACES (P3-K-14) ══════════════════════════════
 *
 * ⛔ A HOOK ENTRY AND A KERNEL FILE ARE THE SAME QUESTION ASKED ABOUT TWO SURFACES: "does this profile
 * carry the thing behind it". Both answers come from ADR-003's one rule table, read through
 * `hooks/_posture.js`, which is why this lives beside the hook projection rather than in a second module
 * that would have to be kept in step with it.
 *
 * ⭐ AND IT IS DERIVED FOR THE SAME REASON `isInert` IS. The only thing declared below is which ADR-003
 * ROW governs a file. Whether that file is placed is `verdict(row) !== 'n.a.'`, asked of the resolver
 * per profile — so moving a row between columns changes what the installer places without anybody
 * editing this table, and a hand-written "light omits reconcile.js" list cannot drift away from the
 * table it claims to implement.
 *
 * ⛔ EXACTLY ONE FILE IS GATED TODAY, AND THE OTHER TWO CANDIDATES ARE NAMED HERE SO THEIR ABSENCE IS A
 * RECORDED FINDING RATHER THAN AN OVERSIGHT. K-14's own scope proposed `lib/reconcile.js`,
 * `lib/living.js` and `lib/memory.js`. ADR-003's table gates only the first: `kernel:R4 reconcile` reads
 * "n.a., NOT INSTALLED" under `light`, and its resolver qualifier says so in those words. There is no
 * row for the living-skill machinery or the memory distribution in ANY column, and ADR-002 puts
 * file-backed memory in the CORE (`kernel/lib/memory.js` returns `memory:distribution ACTIVE` on a
 * default install, and "degraded fallback" was retired as a framing). Un-placing either on this task's
 * say-so would be a posture profile amending an accepted ADR from inside an installer, so both are
 * placed by every profile. Moving them is an amendment to ADR-003, which is a decision this table can
 * express in one line the day it is taken.
 */
const KERNEL_LIB_ROWS = {
  'kernel/lib/reconcile.js': 'kernel:R4',
};

/**
 * Does `profile` decline to place this source-relative kernel file?
 *
 * @param {string} rel a `install/_sources.js` KERNEL_FILES entry
 * @param {string} profile one of `hooks/_posture.js`'s PROFILES
 */
function omitsKernelFile(rel, profile) {
  const row = Object.prototype.hasOwnProperty.call(KERNEL_LIB_ROWS, rel) ? KERNEL_LIB_ROWS[rel] : null;
  if (!row) return false; // ungated: placed by every profile, exactly like an unclassified hook entry
  const known = posture.PROFILES.includes(profile) ? profile : posture.DEFAULT_PROFILE;
  // Overrides never change a placement, for the same reason they never change a wiring — see the header.
  return posture.verdict({ profile: known, overrides: {} }, row) === 'n.a.';
}

/**
 * Compose the kernel file list for one profile.
 *
 * @param {string[]} kernelFiles `install/_sources.js`'s KERNEL_FILES, in its order
 * @param {string} profile one of `hooks/_posture.js`'s PROFILES
 * @returns {{files: string[], omitted: Array<{file:string,row:string}>}}
 *
 * ⛔ UNDER `strict` THIS RETURNS THE LIST IT WAS GIVEN, IN ORDER AND COMPLETE. The freeze test's claim is
 * about `settings.json`, but the same discipline applies here: the profile that is defined as "exactly
 * what 0.3.0 does" must place exactly what 0.3.0 placed, and that is a property of the projection rather
 * than a promise about it.
 */
function composeKernelFiles(kernelFiles, profile) {
  const omitted = [];
  const files = [];
  for (const rel of kernelFiles || []) {
    if (omitsKernelFile(rel, profile)) omitted.push({ file: rel, row: KERNEL_LIB_ROWS[rel] });
    else files.push(rel);
  }
  return { files, omitted };
}

/** The hook file a settings entry's `command` names, or '' when it names none. */
function hookStemOf(command) {
  const m = /([A-Za-z0-9_.-]+\.js)\s*$/.exec(String(command || ''));
  return m ? m[1] : '';
}

/** The rule ids that hook carries, or null when this table does not name it. */
function rulesFor(command) {
  const stem = hookStemOf(command);
  return Object.prototype.hasOwnProperty.call(RULES_BY_HOOK, stem) ? RULES_BY_HOOK[stem] : null;
}

/**
 * Is this entry WHOLLY INERT under `profile` — every rule it carries silent, so removing the wiring
 * removes a process and nothing else?
 *
 * A fixed rule has no key in the resolver and `verdict()` answers `deny` for it, so a hook carrying one
 * can never be inert; that is the property that keeps every anti-drift mechanism wired in every profile
 * without this module needing to know which ids those are.
 */
function isInert(command, profile) {
  const rules = rulesFor(command);
  if (!rules || !rules.length) return false; // unknown or unclassified: composed into every profile
  const resolved = { profile, overrides: {} }; // overrides never change a wiring — see the header
  return rules.every((id) => posture.verdict(resolved, id) === 'off');
}

/*
 * ═══ THE THIRD PROJECTION: WHICH WIRING RUNS THE PreToolUse GUARDS (P4-T-15b) ========================
 *
 * ⛔ THIS IS NOT A POSTURE QUESTION, AND IT IS DELIBERATELY KEPT APART FROM ONE. `isInert` answers
 * "does this profile carry the guard behind this entry". This answers "how many processes run the
 * guards this profile carries" - same guards, same verdicts, one Node process instead of four. Folding
 * it into `omitted` would have made a wiring change look like a guard being switched off, which is the
 * one thing that list is read for, so the two travel in separate arrays all the way into the receipt.
 *
 * ⭐ AND `strict` KEEPS THE MULTI-HOOK WIRING, ON PURPOSE. ADR-003 defines `strict` as "exactly what
 * 0.3.0 does" and anti-drift item 35 makes that mechanical: a target with no `posture` key composes a
 * BYTE-IDENTICAL `settings.json`, pinned by P3-N-2's freeze test. A dispatcher entry there would change
 * those bytes, so the honest choices were "re-pin the capture and date a note onto ADR-003" or "wire the
 * dispatcher into the two profiles that are not defined as today's behaviour". The second is taken.
 * P3-N-2's capture is untouched, the freeze test is not re-pinned, and the cost is stated rather than
 * buried: a target that declares nothing keeps four processes per Bash call until it declares a posture.
 *
 * ⛔ A GROUP IS DISPATCHED ONLY WHEN THE DISPATCHER COVERS ALL OF IT. The match below is on the
 * group's WHOLE command set, exactly - not a subset, and not a group carrying an `if`. Three
 * consequences, each of them the point rather than a limitation:
 *   - `secret-scan`'s two Bash registrations keep their own `if` rules and are never folded in. Anti-
 *     drift item 29: one permission rule per entry, never deduplicated. A dispatched `git commit` is
 *     therefore 2 processes, not 1.
 *   - If a profile ever makes one member of a group WHOLLY INERT, `isInert` drops that entry first, the
 *     set no longer matches, and the group falls back to per-hook wiring rather than hiding an omission
 *     inside a dispatcher entry. Neither projection can silently absorb the other's decision.
 *   - A founder who edits a group by hand stops matching, and their edit stands.
 *
 * ⛔ AND THE TIMEOUT IS RAISED TO 60s, WHICH IS NOT A ROUNDING. Each of the four Bash entries
 * carries its own 30-second budget today and they run in parallel, so the group's real ceiling has
 * always been 30 seconds of wall clock per hook. One process runs them in sequence, so the same worst
 * case needs the sum. `stop-savepoint` already sits at 60 for the same reason, so this is the snippet's
 * own second value rather than a new one.
 */
/*
 * ⛔ THE REGISTRATION NAMES THE GUARDS IT RUNS, BECAUSE `doctor` READS SETTINGS.JSON AND CANNOT SEE
 * INSIDE A DISPATCHER. Measured before the `--covers` list existed: a target running the dispatcher had
 * five hook rows reading `SILENTLY INACTIVE - on disk and valid but NOT wired ... it will never run`,
 * every one of them false, and the report went from PASS to CANNOT_DETERMINE. `kernel/respawnpack.js`'s
 * wiring reader keeps a raw-JSON substring fallback for exactly this - "a spelling this regex does not
 * know still counts as wired" - so naming the guards is what makes the row true again. It also makes the
 * entry self-documenting for a founder reading their own settings.json. `hooks/dispatch.js` treats the
 * list as a REPORT and never lets it shorten what runs.
 */
const DISPATCH_COMMAND = (group, order) => `node \${CLAUDE_PROJECT_DIR}/.claude/hooks/dispatch.js PreToolUse ${group}`
  + `${order && order.length ? ` --covers ${order.join(',')}` : ''}`;
const DISPATCH_TIMEOUT = 60;

/** The profiles that compose the dispatcher. `strict` is absent for the reason above (item 35). */
const DISPATCH_PROFILES = ['light', 'standard'];

/**
 * ⛔ THE GROUPS, DECLARED HERE AND FENCED AGAINST `hooks/dispatch.js`'s OWN `GROUPS` TABLE.
 *
 * It is declared rather than imported because requiring `hooks/dispatch.js` from the installer would run
 * its `boot.arm('deny')` - installing a process-level `uncaughtException` handler that answers with a
 * PreToolUse DENY document and exits 0. In the installer that would turn a genuine crash into a silent
 * success wearing a hook's clothes, and `install/install.test.mjs`'s own "a fixture that cannot be
 * installed into reports the failure rather than passing vacuously" case is exactly the assertion it
 * would break. So the two tables are kept apart and compared in a CHILD process by the fence in
 * `install/install.test.mjs`, which is the same shape P4-T-15a's drivers already use.
 */
const DISPATCH_GROUPS = {
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

/** Does `profile` run the PreToolUse guards through `hooks/dispatch.js`? */
function usesDispatcher(profile) {
  return DISPATCH_PROFILES.includes(posture.PROFILES.includes(profile) ? profile : posture.DEFAULT_PROFILE);
}

/**
 * Is this composed group EXACTLY the set one dispatch group covers?
 *
 * Exactly: same matcher, same command stems as a set, same length, and no `if` on any entry. A group
 * that has lost an entry to `isInert`, gained a founder's own hook, or carries a permission-rule filter
 * is not one this dispatcher can answer for, and saying so is how the two projections stay separable.
 */
function coversGroup(group, spec) {
  const entries = (group && group.hooks) || [];
  if (((group && group.matcher) || '') !== spec.matcher) return false;
  if (entries.length !== spec.order.length) return false;
  if (entries.some((h) => h && h.if)) return false;
  const stems = entries.map((h) => hookStemOf(h && h.command)).filter(Boolean).sort();
  return JSON.stringify(stems) === JSON.stringify(spec.order.slice().sort());
}

/**
 * Substitute one dispatcher entry for each fully-covered group, on the profiles that carry it.
 *
 * @returns {{hooks: Object, dispatched: Array<{event,matcher,command,if,group,wiring}>}}
 *   `dispatched` is every tuple this profile does NOT compose because of the wiring decision - the
 *   per-hook entries a dispatching profile replaced, or the dispatcher entries a non-dispatching one
 *   declines to place. It is SYMMETRIC on purpose: install.js retires from that list and the receipt
 *   records it, so `light` -> `strict` puts the per-hook entries back and takes the dispatcher entry
 *   away, and `strict` -> `light` does the reverse. A one-way flip is the defect P3-T-11's retirement
 *   record exists to prevent, and a second wiring is a second way to reach one.
 */
function applyDispatcher(hooks, profile) {
  const known = posture.PROFILES.includes(profile) ? profile : posture.DEFAULT_PROFILE;
  const on = usesDispatcher(known);
  const dispatched = [];
  const out = {};
  for (const [event, groups] of Object.entries(hooks || {})) {
    const rebuilt = [];
    for (const group of groups) {
      const named = Object.entries(DISPATCH_GROUPS).find(([, spec]) => spec.event === event && coversGroup(group, spec));
      if (!named) { rebuilt.push(group); continue; }
      const [name, spec] = named;
      if (!on) {
        // The profile declines the dispatcher: the per-hook group stands, and the DISPATCHER tuple is
        // what a flip away from a dispatching profile has to retire.
        dispatched.push({ event, matcher: spec.matcher, command: DISPATCH_COMMAND(name, spec.order), if: '', group: name, wiring: 'dispatch' });
        rebuilt.push(group);
        continue;
      }
      for (const h of (group.hooks || [])) {
        dispatched.push({ event, matcher: spec.matcher, command: h.command, if: h.if || '', group: name, wiring: 'per-hook' });
      }
      rebuilt.push({ ...group, hooks: [{ type: 'command', command: DISPATCH_COMMAND(name, spec.order), timeout: DISPATCH_TIMEOUT }] });
    }
    out[event] = rebuilt;
  }
  return { hooks: out, dispatched };
}

/**
 * Compose the registration set for one profile.
 *
 * @param {Object} snippet the parsed `hooks/settings.snippet.json`, with its `//` key already deleted
 * @param {string} profile one of `hooks/_posture.js`'s PROFILES
 * @returns {{settings: Object, omitted: Array<{event,matcher,command,if,rules}>,
 *            dispatched: Array<{event,matcher,command,if,group,wiring}>, wiring: string}}
 *
 * ⛔ UNDER `strict` THIS RETURNS THE ENTRY OBJECTS IT WAS GIVEN, UNCOPIED AND UNREORDERED, so the
 * composed set serializes byte-for-byte as the snippet does. A group is rebuilt only when something was
 * actually dropped from it, and a group left empty is dropped rather than written as `"hooks": []`.
 */
function compose(snippet, profile) {
  const known = posture.PROFILES.includes(profile) ? profile : posture.DEFAULT_PROFILE;
  const omitted = [];
  const hooks = {};
  for (const [event, groups] of Object.entries((snippet && snippet.hooks) || {})) {
    const keptGroups = [];
    for (const group of groups) {
      const entries = (group && group.hooks) || [];
      const kept = [];
      for (const h of entries) {
        if (h && h.command && isInert(h.command, known)) {
          omitted.push({
            event,
            matcher: (group && group.matcher) || '',
            command: h.command,
            if: h.if || '',
            rules: rulesFor(h.command).slice(),
          });
          continue;
        }
        kept.push(h);
      }
      if (!kept.length) continue;
      keptGroups.push(kept.length === entries.length ? group : { ...group, hooks: kept });
    }
    if (keptGroups.length) hooks[event] = keptGroups;
  }
  /*
   * ⛔ AND THE WIRING PROJECTION RUNS LAST, ON WHAT THE INERTNESS PROJECTION LEFT. Order matters in
   * one direction only: a group that lost an entry to `isInert` must no longer match a dispatch group,
   * so the omission stays visible as an omission instead of disappearing into a dispatcher entry. Under
   * `strict` this returns the groups it was handed, untouched and unreordered, which is what keeps the
   * byte-identity claim (anti-drift item 35) a property rather than a promise.
   */
  const wired = applyDispatcher(hooks, known);
  // Spread-then-override keeps `hooks` at its original key position, so `permissions` still follows it.
  return {
    settings: { ...snippet, hooks: wired.hooks },
    omitted,
    dispatched: wired.dispatched,
    wiring: usesDispatcher(known) ? 'dispatch' : 'per-hook',
  };
}

/** Groups and entries in a composed set — the shape the manifest fence counts. */
function shapeOf(settings) {
  const groups = Object.values((settings && settings.hooks) || {}).flat();
  return { groups: groups.length, entries: groups.reduce((n, g) => n + ((g && g.hooks) || []).length, 0) };
}

module.exports = {
  RULES_BY_HOOK, IF_NARROWINGS_CONSIDERED, KERNEL_LIB_ROWS,
  DISPATCH_GROUPS, DISPATCH_PROFILES, DISPATCH_COMMAND, DISPATCH_TIMEOUT,
  hookStemOf, rulesFor, isInert, compose, shapeOf, omitsKernelFile, composeKernelFiles,
  usesDispatcher, coversGroup, applyDispatcher,
};
