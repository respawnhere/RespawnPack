#!/usr/bin/env node
/*
 * RespawnPack · index-guard.js — git INDEX ownership during parallel work.
 *
 * ⛔ WHAT IT EXISTS FOR (DOGFOOD.md DF-004). Two agents in one wave committed each other's in-progress
 * work — twice, in both directions — despite strictly disjoint FILE SCOPES. The guidance was not wrong
 * so much as insufficient: **the git index is process-external and shared, so disjoint paths do not
 * yield disjoint commits.** worktree-guard.js contains editor writes to a DIRECTORY; this contains
 * index mutations to a PRINCIPAL.
 *
 * ⭐ THE CONTRACT, STATED SMALL SO IT CAN BE TRUE.
 *   1. Editor-tool containment (Edit/Write/MultiEdit/NotebookEdit) is mechanically enforced, and the
 *      pack's own control plane is closed to every subagent THROUGH THE EDITOR TOOLS — in a shared
 *      checkout and in a worktree alike, including by absolute path and through a symlink.
 *   2. DIRECT git invocations, and git reached through the explicitly supported constant shell
 *      wrappers (`sh -c`, `bash -c`, `cmd /c`, `powershell -Command`, `env`) and modelled process
 *      wrappers (`sudo`, `nice`, `command`, `exec`, `timeout`, …), are mechanically enforced.
 *   3. A shared-checkout subagent gets NO Bash. Not "no Bash by default" — no Bash. Its read path is
 *      Read/Grep/Glob, which needs no shell at all.
 *   4. Anything that builds, tests, runs an interpreter or needs arbitrary Bash gets a worktree.
 *   5. Every VISIBLE index mutation takes the writer lease for the index it targets, including an
 *      agent's own worktree. Worktrees stay convenient because their index IDENTITIES differ, not
 *      because they are exempt from the rule.
 *
 * ⛔ AND WHAT IT IS NOT, stated rather than implied.
 *   • A WORKTREE IS COLLISION ISOLATION, NOT AN OS SANDBOX. It gives a helper its own index and its own
 *     working tree so ordinary relative operations cannot collide. It does not restrict what the OS
 *     principal can address: a command spawned inside an arbitrary program can still name an absolute
 *     path outside the worktree. Anyone needing containment of that kind needs a filesystem/process
 *     sandbox, which this hook is not and cannot become.
 *   • THEREFORE THE CONTROL PLANE IS NOT PROTECTED FROM A WORKTREE SUBAGENT'S SHELL. That helper runs
 *     ARBITRARY BASH by design — it is the whole reason the worktree exists — and a PreToolUse hook
 *     sees a command line rather than a process. An adversarial gate wrote `push.allowed`,
 *     `spawn-guard.strict`, the ownership ledger and THIS FILE from a worktree helper while three
 *     surfaces claimed that was impossible; the claim was removed rather than defended. What is
 *     enforced: every editor-tool write (above), and the visible REDIRECTION spelling in a shell
 *     command. That second check is best-effort defence in depth and is not a guarantee. A project
 *     that needs the control plane held against arbitrary code must not hand out worktree Bash.
 *   • GIT HIDDEN INSIDE AN ARBITRARY PROGRAM IS INVISIBLE HERE. A package script, a Node or Python
 *     process, a compiled binary, a shell alias — a PreToolUse hook sees the command line, not the
 *     process tree. No growth of the parser changes that, which is exactly why the boundary above is
 *     small and hard instead of being an ever-longer list of binaries and flags.
 *   • A HUMAN'S OWN TERMINAL IS OUTSIDE HOOK CONTROL BY DESIGN. Between this hook allowing a command
 *     and git executing it, a human can change the same index; nothing here can lock that. What IS
 *     guaranteed: every agent index mutation is checked immediately before it runs, and any state the
 *     session cannot account for is treated as foreign at the next guarded action.
 *
 * ⭐ FOUR OF THESE RULES ANSWER TO THE PROJECT'S DECLARED POSTURE, AND THREE NEVER WILL (ADR-003).
 * `index-guard:editor-containment`, `:no-bash` and `:writer-lease` are `off` under `light` and `deny`
 * under `standard` and `strict`; `:unmodelled` advises under `light` and narrows to the hidden-program
 * clause under `standard`. `index-guard:wave-sweep`, `:foreign-staged` and `:control-plane` are the
 * anti-drift core's (items 21 and 22) and stay `deny` in every posture — `hooks/_posture.js` carries no
 * key for them, so this file has nothing it could ask about them, which is stronger than a default.
 * An absent, unreadable or invalid declaration resolves to `strict`, which is exactly what 0.3.0 did.
 *
 * ⭐ AND EXACTLY ONE OF THE SEVEN ACCEPTS A DECLARED EXCEPTION (P1-E-1d): `:unmodelled`, by the
 * fingerprint of the command line it judged, so a founder who has read one build script's `$(…)` can
 * name that one command instead of relaxing the rule for every command. A lift skips only that rule's
 * clauses, never exits the pass, and is reported on both channels. The other six are asked nothing: a
 * fence in `hooks/hooks.test.mjs` reads this source and asserts the rule ids handed to `allowed(` are
 * exactly `['index-guard:unmodelled']`, so the three FIXED ones can never be lifted by any declaration.
 *
 * Contract: stdin = PreToolUse / PostToolUse / SubagentStop / SessionEnd JSON.
 * Deny   = {hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason}}.
 * Advise = {systemMessage, hookSpecificOutput:{hookEventName:"PreToolUse",additionalContext}} + exit 0.
 */
const fs = require('fs');
const path = require('path');
/*
 * ⛔ FAIL CLOSED, THROUGH THE BOOTSTRAP BOUNDARY. These four modules ARE this guard's policy machinery.
 * With any of them unloadable the hook used to exit 1 — which the host treats as a NON-BLOCKING error
 * and then runs the tool anyway. So the index guard failed OPEN at precisely the moment it could not
 * judge anything. `deny` posture emits an explicit deny decision at exit 0 instead.
 */
const boot = require('./_boot.js');
boot.arm('deny');
const shell = boot.need('./_shell.js');
const effect = boot.need('./_git-effect.js');
const lease = boot.need('./_index-lease.js');
const rt = boot.need('./_runtime.js');
/*
 * ⛔ AND THE POSTURE READER IS POLICY MACHINERY TOO, SO IT COMES THROUGH THE SAME BOUNDARY. `_posture.js`
 * decides which of this guard's rules speak and how loudly; a build where it is missing is a build that
 * cannot say what the project asked for, and guessing there is the failure the four requires above
 * already refuse to make. `boot.need` denies at exit 0 instead, which is the conservative direction.
 */
const posture = boot.need('./_posture.js');
/*
 * ⛔ AND THE EXCEPTION READER, FOR EXACTLY ONE RULE — `index-guard:unmodelled` (P1-E-1d).
 *
 * `_cmd.dequote` is the one spelling of "the command line, with quoted spans blanked", so the
 * fingerprint this guard PRINTS on an unmodelled refusal is byte-identical to the one `shell-guard` and
 * `push-guard` print and to the one the founder pastes back. Both come through `need()` because this
 * guard is armed `deny`: a reader that will not load leaves the refusal standing rather than lifting it.
 *
 * ⛔ THE OTHER THREE IDS ARE NOT REACHABLE FROM HERE AND MUST NEVER BECOME SO. `:wave-sweep`,
 * `:foreign-staged` and `:control-plane` are anti-drift items 21 and 22: the posture table has no key
 * for them AND no subject is ever offered for them, so there is nothing to relax and nothing to declare.
 * `hooks/hooks.test.mjs` reads this file's source and asserts the rule ids handed to `allowed(` are
 * exactly `['index-guard:unmodelled']` — a fixed refusal that cannot be argued with, rather than one
 * that is merely denied by default.
 */
const cmdlib = boot.need('./_cmd.js');
const exceptionsLib = boot.need('./_exceptions.js');

/** The one sentence a lifted hit is reported on — the same literal in all four guards (E-1d). */
const allowedBy = (e) => `🔓 allowed by exception ${e.id} (${e.rule}): ${e.reason}`;

/**
 * What a refusal adds when a declaration was consulted and REFUSED WHOLE. `INVALID` only — see
 * `hooks/shell-guard.js` for why `DEFAULTED` and `UNREADABLE` must leave the refusal byte-identical.
 */
const refusedNote = (resolved) => (resolved && resolved.source === 'INVALID'
  ? `\n⛔ ${resolved.detail}`
  : '');

const EDIT_TOOLS = /^(Edit|Write|MultiEdit|NotebookEdit)$/;

/*
 * ⛔ THE READ-ONLY ALLOWLIST IS GONE, NOT SHRUNK. M.1b kept a narrow, "argument-validated" allowance
 * behind an opt-in marker and called it fully validated. M.1c probed the retained forms and found five
 * more writing shapes inside them in one pass:
 *     sort -oREADME.md README.md      the ATTACHED spelling of -o, which the validator matched only
 *                                     as a standalone token
 *     file -C -m magic                compiles and WRITES magic.mgc
 *     date --set=…                    sets the system clock
 *     GIT_PAGER="<program>" git log   runs an arbitrary program under a reading subcommand
 *     git -ccore.pager="<program>" log  the attached spelling of -c, unrecognised as an override
 * That is the third round of the same finding, and the conclusion is not another patch: proving a
 * command line safe means proving what every binary does with every argument, and a PreToolUse hook
 * cannot discharge that obligation. Read/Grep/Glob already give a shared helper its entire read path
 * with no shell at all. Anything more gets a worktree. The opt-in marker is removed rather than
 * documented, because a marker a helper might create is a boundary a helper can move.
 */

const projectDirOf = (input) => rt.projectRoot(input);

/*
 * ⛔ CANONICALISE THROUGH THE FILESYSTEM, NOT JUST THROUGH THE STRING. `path.resolve` collapses `..`
 * and separators; it does not follow a symlink or a Windows junction, so
 * `.respawnpack/scratch/<agent>/up → <project root>` made every containment test agree that a write
 * into the control plane was inside the agent's own scratch namespace. `realpath` on the nearest
 * EXISTING ancestor is what closes it: the leaf usually does not exist yet (it is about to be created),
 * so resolving the leaf alone would fail and fall back to the string answer.
 */
/*
 * ⛔ AND BEFORE RESOLVING, STRIP THE SPELLINGS WINDOWS TREATS AS THE SAME FILE AND `path` DOES NOT.
 * Three of them let a worktree subagent write the control plane through the editor tools, which is the
 * one part of that boundary the pack DOES claim:
 *   <proj>\.respawnpack\push.allowed::$DATA     an NTFS alternate-data-stream suffix; the write lands
 *                                               on the file itself, and the regex saw a different name
 *   \\localhost\C$\<proj>\.respawnpack\…        the admin share — the same bytes, a different path
 *   \\?\C:\… and \\.\C:\…                       device-namespace prefixes
 *   push.allowed. / spawn-guard.strict          trailing dots and spaces, which Win32 discards
 * Normalising is the safe direction by construction: this feeds a DENY decision, so over-matching a
 * path that is not really the control plane costs a refusal, while under-matching costs the boundary.
 */
function canonicalSpelling(target) {
  let s = String(target).replace(/\//g, '\\');
  s = s.replace(/^\\\\[?.]\\(UNC\\)?/i, (m, unc) => (unc ? '\\\\' : ''));       // \\?\C:\… · \\?\UNC\…
  s = s.replace(/^\\\\[^\\]+\\([A-Za-z])\$(?=\\|$)/, '$1:');                     // \\host\C$\… → C:\…
  const parts = s.split('\\');
  const out = parts.map((seg, i) => {
    let v = seg;
    /*
     * ⛔ `.` AND `..` ARE NAVIGATION, NOT NAMES — AND THE TRAILING-DOT STRIPPER ATE THEM. Stripping
     * trailing dots per segment turned `..` into the empty string BEFORE `path.resolve` could act on
     * it, so `.respawnpack/scratch/AG1/../../push.allowed` canonicalised to a benign in-namespace path
     * and a SHARED-checkout subagent wrote `push.allowed`, `spawn-guard.strict`, another agent's
     * scratch, `respawnpack.config.json`, `.claude/hooks/index-guard.js` and — the escalation that
     * ends the argument — `.claude/settings.json`, after which every guard was unwired and the next
     * `git add -A` from that subagent was allowed. A normalisation written to close a bypass opened a
     * wider one; the segments it exists to fold are FILENAMES, and these two are not filenames.
     */
    if (v === '.' || v === '..') return v;
    if (!(i === 0 && /^[A-Za-z]:$/.test(v))) v = v.split(':')[0];                // drop an ADS suffix
    if (process.platform === 'win32') v = v.replace(/[. ]+$/, '');               // Win32 discards these
    return v;
  });
  return out.join(path.sep);
}

function realResolve(base, target) {
  let abs = path.resolve(base, canonicalSpelling(target));
  let probe = abs;
  const tail = [];
  for (let i = 0; i < 64; i++) {
    try { return path.join(fs.realpathSync.native ? fs.realpathSync.native(probe) : fs.realpathSync(probe), ...tail); }
    catch { /* does not exist yet — step up one level and try again */ }
    const parent = path.dirname(probe);
    if (parent === probe) return abs;
    tail.unshift(path.basename(probe));
    probe = parent;
  }
  return abs;
}

/**
 * Canonical containment. `.respawnpack/../src/x`, mixed separators, absolute traversal AND symlinks or
 * junctions all resolve before comparison, so a path is inside a prefix only if it genuinely is.
 */
function containedIn(projectDir, target, prefix) {
  const abs = realResolve(projectDir, target);
  const root = realResolve(projectDir, prefix);
  const rel = path.relative(root, abs);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/*
 * ⛔ A `Write` tool grant is NOT path authorization. An earlier version read `tools:` from an agent's
 * frontmatter and let anything holding Write edit the whole project — contradicting the onboarding
 * mappers' own documented boundary. The mappers are BOUNDED here, not exempted.
 */
const ONBOARDING_AGENTS = new Set(['codebase-mapper', 'docs-ingestor']);

/*
 * ⛔ AND A SCRATCH NAMESPACE IS PER-AGENT, because two helpers sharing one scratch directory is the
 * DF-004 collision with a different file underneath it. The slug comes from the RUNTIME agent id, not
 * from anything the agent asserts about itself, and is sanitised so it can never climb out.
 */
const agentSlug = (who) => String(who.agentId || 'unknown').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
const scratchRootFor = (who) =>
  `${ONBOARDING_AGENTS.has(String(who.agentType)) ? '.respawnpack/onboarding' : '.respawnpack/scratch'}/${agentSlug(who)}`;

/*
 * ⛔ THE CONTROL PLANE IS NOT SCRATCH SPACE. A shared helper's writable namespace used to be the whole
 * of `.respawnpack/`, which is where this pack keeps the files that decide what agents may do:
 *     .respawnpack/*.allow · *.allowed · *.off · *.strict   authorization and mode markers
 *     .respawnpack/spawn-state-*.json                       the in-flight counter this hook reads
 *     .respawnpack/runtime/**                               leases, index ownership, the interaction
 *                                                           contract, session baselines, handoffs
 *     .respawnpack/wave-ledger.md, handoff*                 wave and handoff control artifacts
 * A helper could therefore write `push.allowed` and authorise a push, or `spawn-guard.strict` and
 * change the ceiling, or overwrite the ownership ledger and make foreign staged work read as its own —
 * and the marker that re-enabled shared Bash was in that same directory, so a helper with no shell
 * could grant itself one. Escalation through a scratch directory is still escalation.
 *
 * This runs for EVERY subagent, in every checkout: a helper in its own worktree can still name an
 * absolute path into the main project, and `!sharedCheckout ⇒ exit 0` let it.
 */
/*
 * ⛔ THIS LIST IS AN ALLOWLIST NOW, AND THE REASON IS THAT A DENYLIST OF FILENAMES LOST.
 *
 * It used to enumerate the control artifacts by name: `*.allow|allowed|off|strict`, `spawn-state-*`,
 * `*.lock`, `index-guard.*`, `wave-ledger.md`, `handoff*`, `*.json`. A fourth adversarial gate found
 * that `.respawnpack/push.consumed` matched none of them — and push-guard treats that file as
 * sufficient authorization for a push all by itself. A worktree helper could write it with a single
 * editor call and then push, with no human go-ahead and no `push.allowed`, one filename over from the
 * escalation this file's own header names as the thing it exists to prevent.
 *
 * The lesson is not "add push.consumed". It is that a denylist over a directory the pack keeps adding
 * files to has to be re-audited on every commit, and nobody will. So: EVERYTHING under `.respawnpack/`
 * is control plane, except the two per-agent namespaces a helper is supposed to write — and those are
 * separately fenced per-agent below, so an agent still cannot reach another agent's. A new pack
 * runtime file is now protected the moment it exists, without anyone remembering to come back here.
 */
const CONTROL_PLANE = [
  // `$` as well as `/`: a redirection literal can end AT the directory (`> $P/.respawnpack/$F` leaves
  // `.respawnpack/` as its only literal run), and a file literally named `.respawnpack` is ours too.
  /^\.respawnpack(?:$|\/(?!scratch\/|onboarding\/))/,
  /^respawnpack\.config\.json$/,
  /^docs\/derived\/state(\/|$)/,
  /^\.claude\/(settings|settings\.local)\.json$/,
  /^\.claude\/hooks(\/|$)/,
  /*
   * ⛔ THREE MORE THAT DECIDE WHAT AGENTS MAY DO, added after a fifth gate wrote all three from a
   * subagent. An agent definition's `tools:` frontmatter IS its permission grant, `.mcp.json` decides
   * which servers exist, and `.git/hooks/` is where this pack installs its own pre-push shim — a
   * helper that can rewrite any of them can widen itself. `.claude/skills/**` and `CLAUDE.md` are
   * deliberately NOT here: they are project content a helper may legitimately be asked to edit, and
   * the line this guard draws is "decides permissions", not "belongs to the pack".
   */
  /^\.claude\/agents(\/|$)/,
  /^\.mcp\.json$/,
  /*
   * ⛔ THE WHOLE OF `.git`, NOT A CURATED LIST OF ITS FILES. `.git/hooks` was added last round; a sixth
   * gate then wrote `.git/config` (which sets `core.hooksPath` — the guard denies that spelling on the
   * COMMAND LINE two hundred lines below, and left the file that does the same thing wide open) and
   * `.git/index` itself, corrupting it with a single editor Write and no git command involved. That is
   * the denylist-of-filenames lesson for the third time, so: no editor-tool write into `.git` is ever
   * legitimate project work. Git owns that directory; a helper that needs to change it runs git.
   */
  /^\.git(\/|$)/,
];

/**
 * Is `target` one of the pack's own control artifacts?
 *
 * ⛔ CASE IS FOLDED HERE AND NOWHERE ELSE. Windows resolves `.RESPAWNPACK/push.allowed` to the same
 * file; a case-sensitive comparison simply missed it. Folding on Linux can only ever DENY a
 * differently-cased directory that is not the control plane — a refusal, not a bypass — whereas the
 * containment check below must stay case-sensitive there, because folding an ALLOW decision on a
 * case-sensitive filesystem would grant a path the OS considers different.
 */
function isControlPlane(projectDir, target) {
  const rel = path.relative(realResolve(projectDir, '.'), realResolve(projectDir, target)).replace(/\\/g, '/');
  if (!rel || rel.startsWith('../') || path.isAbsolute(rel)) return null; // outside the project entirely
  const folded = rel.toLowerCase();
  const hit = CONTROL_PLANE.find((re) => re.test(folded));
  return hit ? rel : null;
}

/**
 * Is a parallel wave in flight? Reuses spawn-guard's counter rather than inventing a second one.
 *
 * ⛔ AN EXPLICIT VERDICT, because "I could not read the counter" is not "no wave is running". The
 * previous reader caught everything and returned false, so a corrupt or permission-denied counter
 * authorised exactly the sweeping `git add -A` the counter exists to refuse. A MISSING file genuinely
 * is zero — nothing has been dispatched — and that stays the low-ceremony default.
 */
function waveInFlight(projectDir, sessionId) {
  const safe = String(sessionId || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
  const file = path.join(projectDir, '.respawnpack', `spawn-state-${safe}.json`);
  /*
   * ⛔ THE SAME FILE IS NOT THE SAME READING. spawn-guard treats a counter older than its stale window
   * as zero — "a parent killed mid-wave must never wedge a future session" — and this reader had no
   * mtime check at all. So a resumed session met a spawn-guard that had self-healed the count to 0 and
   * an index-guard that refused every `git add -A`, `git add .` and `git commit -a` indefinitely with
   * the sentence "while subagents are in flight", about subagents that exited an hour ago. One counter
   * read two ways is two counters wearing a disguise; the window is imported from the writer.
   */
  let stat;
  try { stat = fs.statSync(file); }
  catch (e) {
    if (e && e.code === 'ENOENT') return { status: 'PASS', inFlight: false };
    return { status: 'CANNOT_DETERMINE', reason: `the wave counter could not be opened (${e.code || e.message})` };
  }
  if (Date.now() - stat.mtimeMs > rt.SPAWN_STALE_MS) return { status: 'PASS', inFlight: false, stale: true };
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (e) {
    if (e && e.code === 'ENOENT') return { status: 'PASS', inFlight: false };
    return { status: 'CANNOT_DETERMINE', reason: `the wave counter could not be opened (${e.code || e.message})` };
  }
  let n;
  try { n = Number(JSON.parse(text).count); }
  catch { return { status: 'CANNOT_DETERMINE', reason: 'the wave counter is corrupt or unreadable' }; }
  if (!Number.isFinite(n)) return { status: 'CANNOT_DETERMINE', reason: 'the wave counter holds no usable count' };
  return { status: 'PASS', inFlight: n > 0 };
}

/*
 * ⭐ THE PASS ENDS BY THROWING, AND THAT IS WHAT MAKES THE REFACTOR A REFACTOR (P4-T-15a).
 *
 * `emitDeny`, `deny` and `finish` are called from inside loops, from inside `ruled()`, and from inside
 * closures several frames down — and every one of those call sites was written on the promise that the
 * call NEVER RETURNS. `process.exit(0)` kept that promise; a plain `return` cannot, because a `return`
 * inside `ruled()` returns from `ruled()` and the pass keeps going. Rewriting every site to propagate a
 * sentinel would be rewriting the control flow of a guard whose whole value is that its control flow is
 * the one that was reviewed. So the non-local exit stays non-local: it throws a `Halt` carrying the
 * verdict, and `check()` — the only frame that catches it — returns that verdict as data. Anything that
 * is NOT a `Halt` is re-thrown untouched, so `_boot`'s last-resort net still sees real defects.
 */
class Halt {
  constructor(verdict) { this.verdict = verdict; }
}
const halt = (verdict) => { throw new Halt(verdict); };

const emitDeny = (reason) => halt({
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
});

/**
 * The context this check reads.
 *
 * ⛔ `profile` IS A LAZY GETTER SO THE ONE READ STAYS WHERE THE DECISION TAKES IT — at the top of
 * PreToolUse, below the lifecycle events, exactly where the comment there says. Resolving eagerly here
 * would read `respawnpack.config.json` on a SessionEnd or a PostToolUse that consults no rule at all.
 */
function context(input) {
  const projectDir = projectDirOf(input || {});
  let resolved;
  let declared;
  return {
    input: input || {},
    projectDir,
    workDir: (input && input.cwd) || projectDir,
    principal: lease.principal(input || {}),
    git: null,
    get profile() {
      if (resolved === undefined) resolved = posture.resolve(projectDir);
      return resolved;
    },
    /*
     * ⛔ LAZY FOR THE SAME REASON `profile` IS, AND SEPARATE FOR A DIFFERENT ONE. Lazy, because this
     * hook also answers SessionEnd, SubagentStop and PostToolUse, none of which consults a declaration.
     * Separate, because a posture answers "what verdict does this rule have" and an exception answers
     * "has the founder named THIS subject" — two questions with two fail-closed directions, and one
     * getter answering both would let an unreadable posture decide an allowance.
     */
    get exceptions() {
      if (declared === undefined) declared = exceptionsLib.resolve(projectDir);
      return declared;
    },
  };
}

/** The pure check. Returns this hook's output as data, or null. Writes no stdout and exits nothing. */
function check(ctx) {
  try { return decide(ctx); }
  catch (e) {
    if (e instanceof Halt) return e.verdict;
    throw e;
  }
}

function decide(ctx) {
  const input = ctx.input || {};
  const projectDir = ctx.projectDir;
  const who = ctx.principal;
  const event = input.hook_event_name;
  boot.observed(event); // so a later failure degrades in the shape THIS event actually expects
  const workDir = ctx.workDir;

  // Lifecycle. SessionEnd releases EVERY lease this session holds, not just the one under its current
  // cwd — a session may have staged into several worktrees, and the others would stay wedged.
  if (event === 'SessionEnd') { lease.releaseAll(projectDir, who); return null; }
  if (event === 'SubagentStop') {
    lease.releaseAll(projectDir, who);
    const id = lease.indexIdentity(workDir);
    if (id) lease.release(projectDir, id, who);
    return null;
  }

  const isBash = input.tool_name === 'Bash';
  const command = (input.tool_input && input.tool_input.command) || '';
  const parsed = isBash ? shell.parseProgram(command, workDir, path) : { unsupported: null, commands: [] };
  const gitCommands = parsed.commands.filter((c) => c.bin === 'git');

  /*
   * PostToolUse: record what the mutation ACTUALLY produced, against the index it ACTUALLY targeted.
   * A PreToolUse intention is not proof that staging succeeded, and `workDir` is not proof of which
   * index was touched — recording from cwd is how one worktree's ownership got claimed from another.
   * The paths recorded are repository coordinates, the same ones the intersection compares against.
   */
  if (event === 'PostToolUse') {
    if (!isBash || parsed.unsupported) return null;
    for (const c of gitCommands) {
      const cls = effect.classify(c);
      if (!cls.mutates) continue;
      // Refuse to claim ownership when the target or its paths are ambiguous — a claim against an
      // unknown index is the poisoning bug with a different cause.
      if (c.unsafeOpt || c.gitEnvOverride) continue;
      // PostToolUse only fires if the call RAN, so this is where a provisional lease becomes real.
      try { const id = lease.indexIdentity(c.dir); if (id) lease.confirm(projectDir, id, who); } catch { /* best effort */ }
      if (cls.sweeping && !cls.paths.length) { try { lease.recordOwned(projectDir, who.sessionId, c.dir, null); } catch { /* best effort */ } continue; }
      try { lease.recordOwned(projectDir, who.sessionId, c.dir, cls.paths); } catch { /* best effort */ }
    }
    return null;
  }

  if (event !== 'PreToolUse') return null;

  /*
   * ⭐ THE PROJECT'S POSTURE, READ ONCE PER DECISION (ADR-003, P3-T-10a).
   *
   * ⛔ ONE READ, NOT ONE PER RULE. Four of this guard's rules are switchable and they must all answer
   * from the SAME reading of `respawnpack.config.json`: a file that changes between two reads inside one
   * hook invocation would let one decision be judged under two policies. Every other hook makes this call
   * beside its `.off` marker check; index-guard has no `.off` marker — its own header says the boundary
   * "is not configurable", and everything under `.respawnpack/` is control plane a helper must not be
   * able to create — so the equivalent place is here, at the top of the one event that decides anything.
   *
   * ⛔ AND IT IS DELIBERATELY BELOW NOTHING AND ABOVE THE CONTROL-PLANE CHECK ONLY IN READING ORDER. The
   * control-plane refusal below is FIXED in every posture (anti-drift item 22) and is not routed through
   * `verdict()` at all — the resolver carries no key for it, so there is nothing to ask. Same for the
   * sweeping-while-a-wave-is-in-flight refusal and the foreign-staged intersection (item 21). A fixed rule
   * that a hook merely declines to ask about is one edit away from being asked; a fixed rule the table
   * cannot answer is unavailable, and that is the design.
   */
  const resolved = ctx.profile;

  /*
   * ⭐ THE ADVISORY BUFFER, AND WHY A DOWNGRADED RULE MUST NOT SPEAK AND LEAVE.
   *
   * `advise` is the NON-BLOCKING verdict, so a rule that advises has to let the decision keep running. A
   * hook writes exactly one JSON object to stdout, so an advisory emitted at its own site would have to
   * exit there — and exiting mid-pass is how a downgrade turns into a bypass: every FIXED rule below the
   * downgraded one (the wave sweep, the foreign-staged intersection) would simply never run. So an
   * advisory is collected here and written by `finish()` at whichever exit the pass actually reaches.
   *
   * With no advisories raised — every profile that resolves to `strict`, which is DEFAULTED, UNREADABLE
   * and INVALID as well as a declared `strict` — `finish()` halts with nothing to say and the tail
   * advisory is byte-for-byte the sentence it has always been.
   */
  const advisories = [];
  const advise = (text) => { advisories.push(text); };
  /*
   * ⭐ AND A SECOND BUFFER FOR A DIFFERENT FACT (P1-E-1d). A rule that ADVISED was downgraded for every
   * subject by the project's posture; a rule that was LIFTED still denies everything except the one
   * subject the founder named. Folding a lift into the advisory list would make the headline count
   * "rule(s) advised" include a rule that is advising nothing, and would put the lift's reason behind a
   * sentence about a posture that did not decide it. So the two are collected separately, and both
   * reach `finish()` — the lift must NOT exit early either, because every FIXED rule below it (the wave
   * sweep, the foreign-staged intersection, the control plane) still has to run.
   */
  const lifts = [];
  const lift = (entry) => { lifts.push(allowedBy(entry)); };
  const finish = (extra) => {
    const parts = [...(extra ? [extra] : []), ...lifts, ...advisories];
    const messages = [
      ...lifts,
      ...(advisories.length ? [`🔓 RespawnPack index-guard: ${advisories.length} rule(s) advised instead of refusing, `
        + `under this project's \`${resolved.profile}\` posture.`] : []),
    ];
    halt(parts.length ? {
      ...(messages.length ? { systemMessage: messages.join('\n') } : {}),
      hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: parts.join('\n\n') },
    } : null);
  };

  /*
   * ⛔ THE CONTROL PLANE IS CLOSED TO SUBAGENTS BEFORE ANYTHING ELSE IS DECIDED — including before the
   * "is this even a git repository" bail below. The spawn ceiling and the lockdown markers are not git
   * concepts, and a project without git still has a control plane worth protecting.
   */
  const denyControlPlane = (control, extra) => emitDeny(
    `🔒 index-guard: "${control}" is one of RespawnPack's own control artifacts, and no subagent may write it.\n` +
    `These files decide what agents are allowed to do — push and lockdown authorization, the spawn ceiling, ` +
    `index leases and ownership, the interaction contract, the wave ledger, the installed hooks and settings, ` +
    `and the durable goal contract. A helper that can write them can widen its own permissions, so a scratch ` +
    `namespace deliberately excludes them.\n` +
    `Write scratch output under ${scratchRootFor(who)}/ instead, or return the change and let the orchestrator ` +
    `— which is where these decisions belong — apply it.${extra ? `\n${extra}` : ''}`,
  );

  if (who.isSubagent && EDIT_TOOLS.test(input.tool_name || '')) {
    const target = (input.tool_input && (input.tool_input.file_path || input.tool_input.notebook_path)) || '';
    const control = target && isControlPlane(projectDir, target);
    if (control) denyControlPlane(control);

    /*
     * ⛔ AND ANOTHER AGENT'S SCRATCH IS NOT THIS AGENT'S SCRATCH, IN EITHER CHECKOUT. The per-agent
     * namespace was enforced only through the shared-checkout containment rule, so a helper in its own
     * worktree could write `<project>/.respawnpack/scratch/<other-agent>/…` by absolute path. Two
     * helpers clobbering each other's working notes is the DF-004 collision one directory further down,
     * which is exactly why the namespaces were split per agent in the first place.
     */
    const mine = scratchRootFor(who);
    for (const shared of ['.respawnpack/scratch', '.respawnpack/onboarding']) {
      if (target && containedIn(projectDir, target, shared) && !containedIn(projectDir, target, mine)) {
        emitDeny(
          `🔒 index-guard: "${path.relative(projectDir, realResolve(projectDir, target)).replace(/\\/g, '/')}" is inside another agent's ` +
          `scratch namespace. Each helper gets its own (${mine}/) so two of them cannot clobber each other's ` +
          "working notes — the same collision that disjoint file scopes were supposed to prevent, one directory down.",
        );
      }
    }
  }

  /*
   * ⛔ AND THE VISIBLE SHELL SPELLINGS TOO — BEST-EFFORT, AND LABELLED AS SUCH.
   *
   * A subagent granted its own worktree has ARBITRARY BASH by construction: that is the escape hatch,
   * and it is the reason the worktree exists. A PreToolUse hook sees a command line, not a process, so
   * it cannot contain what that shell does — an adversarial probe wrote `push.allowed`,
   * `spawn-guard.strict`, the ownership ledger and index-guard.js ITSELF from a worktree helper, then
   * used the marker to authorise a push and the ledger to make foreign staged work read as its own.
   *
   * Refusing the REDIRECTION spelling costs nothing and catches the obvious form. It is NOT a
   * guarantee. The header and README no longer state a closure they cannot deliver; containment of
   * arbitrary code needs a filesystem sandbox, which this is not.
   */
  if (who.isSubagent && isBash) {
    // Redirections from EVERY parser depth, not just the outer command string: the guard modelled
    // `sh -c "…"` for git and then stopped looking for redirections inside it, so the one spelling it
    // claimed to catch was defeated by a wrapper it already parses.
    /*
     * ⛔ A DYNAMIC TARGET USED TO BE SKIPPED ENTIRELY, AND ITS LITERAL SUFFIX GAVE IT AWAY.
     *
     * The guard read `if (!r.op.includes('>') || r.dynamic) continue`, so every one of these was
     * ALLOWED against a worktree subagent: `export P=<proj> && echo x > $P/.respawnpack/push.allowed`,
     * `P=<proj>; echo x > $P/.claude/settings.json`, `echo x > <proj>/.respawnpack/{push.allowed,z}`,
     * `echo x > ~/../.respawnpack/push.allowed`. The prefix is unknown; the SUFFIX is right there in
     * the source text. `$P/.respawnpack/push.allowed` names the control plane in plain sight, and the
     * one place in this file where an unknowable value failed OPEN was the place it mattered most.
     *
     * So a dynamic target is matched on its literal tail: strip everything up to and including the
     * last expansion, and ask whether what remains ends in a control-plane path. That cannot produce
     * a false allow (an unknown prefix cannot make `.respawnpack/push.allowed` benign) and it cannot
     * deny `> $TMP/build.log`, because no suffix of that is control plane. Genuinely opaque targets
     * (`> $EVERYTHING`) still pass — the header's "best-effort, not a guarantee" covers those, and the
     * lease and editor-tool rules remain the mechanisms that do not depend on reading a shell.
     */
    for (const r of parsed.redirections || []) {
      if (!r.op.includes('>')) continue;
      if (!r.target) continue;
      if (!r.dynamic) {
        const control = isControlPlane(projectDir, path.resolve(r.dir || workDir, r.target));
        if (control) denyControlPlane(control);
        continue;
      }
      /*
       * ⛔ AN EXPANSION MOVED ONE SEGMENT RIGHT DEFEATED THE PREVIOUS VERSION, AND ITS COMMENT SAID
       * OTHERWISE. That version stripped everything up to the LAST expansion and tested the remainder,
       * reasoning that "an unknown PREFIX cannot make `.respawnpack/push.allowed` benign" — true, and
       * beside the point, because the attack is an unknown SUFFIX or INFIX. A fifth gate wrote
       * `push.allowed` from a worktree helper and then pushed, using:
       *     > $P/.respawnpack/$F                  expansion at the END      → tail was empty
       *     > $P/.respawn${X}pack/push.allowed    expansion in the MIDDLE   → tail matched nothing
       *     > $P/.claude/settings.js${E}on        expansion inside the NAME → tail matched nothing
       *     > $P/.claude/hooks/$H
       * The absolute in that comment ("cannot produce a false allow") is the kind of sentence this whole
       * program exists to stop shipping, so it is gone along with the mechanism it described.
       *
       * What replaces it: remove the expansions and test what the author LITERALLY WROTE, two ways —
       * the concatenation of the literal runs (which reassembles `.respawn` + `pack/push.allowed` into
       * `.respawnpack/push.allowed`, catching infix and in-name expansions), and each literal run on its
       * own (which catches `$P/.respawnpack/$F`, whose concatenation ends at the directory). Both are
       * matched as project-relative paths.
       *
       * ⚠️ AND THE DENIAL SAYS WHAT IT ACTUALLY KNOWS. When the prefix is a run-time value this hook
       * cannot tell whether the target resolves inside THIS project or some other directory entirely —
       * a gate measured `~/.claude/settings.json` and an unrelated repository's path both being reported
       * as "this project's control plane", which was a false diagnosis attached to a defensible refusal.
       * It refuses because it cannot tell, and now it says so.
       */
      const literals = String(r.target)
        .split(/\$\{[^}]*\}|\$[A-Za-z_][\w]*|%[^%]*%|\{[^}]*\}|~|`[^`]*`/)
        .filter((x) => x !== '');
      const candidates = [literals.join(''), ...literals];
      for (const cand of candidates) {
        const cleaned = String(cand).replace(/^(?:[\\/]+|\.{1,2}[\\/]+)+/, '');
        if (!cleaned) continue;
        const control = isControlPlane(projectDir, path.resolve(projectDir, cleaned));
        if (control) {
          denyControlPlane(control, 'This redirection names a control-plane path with a run-time value in it, so this hook '
            + 'cannot tell whether it resolves inside this project or somewhere else — and refuses rather than guess. '
            + 'Write the path literally if it is not the control plane.');
        }
      }
    }
  }

  const projectIdentity = lease.indexIdentity(projectDir);
  const workIdentity = lease.indexIdentity(workDir);
  /*
   * ⛔ THE "NOT A REPOSITORY" BAIL IS FOR THE MAIN THREAD ONLY, AND IT IS THE NARROWEST BAIL THAT WORKS.
   *
   * Two rounds of getting this wrong, in opposite directions. First it exited before inspecting the
   * command at all, so `git -C <other repo> add -A` from a non-repo project took no lease and let a
   * subagent clobber a real principal's staged work. Then it exited unless a git command was visible —
   * which handed a SHARED-CHECKOUT SUBAGENT a full shell in two ordinary situations: a project that is
   * not a git repository at all, and a repository whose `git rev-parse` fails (a deleted .git/HEAD, an
   * interrupted operation, a `safe.directory` refusal). An adversarial gate used the second to
   * overwrite `push.allowed`, `spawn-guard.strict` and index-guard.js itself.
   *
   * The no-shell boundary and the control plane are NOT git concepts and must not be gated on git
   * working. So a subagent never takes this exit; only the main thread does, and only when there is
   * nothing repository-shaped to reason about.
   */
  if (!who.isSubagent && !workIdentity && !projectIdentity && !(isBash && gitCommands.length)) finish();

  /*
   * ⛔ "SHARED CHECKOUT" IS ABOUT THE WORKING TREE, NOT ONLY ABOUT THE INDEX FILE. Comparing index
   * identities alone made any NESTED REPOSITORY OR SUBMODULE inside the project read as isolated — a
   * different index, therefore "its own worktree" — so a helper whose cwd was `vendor/lib` got a full
   * shell inside the orchestrator's checkout, which is exactly what "a shared-checkout subagent gets no
   * Bash" is supposed to prevent. A submodule is a normal repository layout and needs no attacker.
   *
   * A helper is ISOLATED only when its checkout is a linked worktree of the SAME repository (same git
   * common directory, different index) or lives entirely outside the project tree. Anything else that
   * sits inside the project's working tree shares it.
   */
  const commonDirOf = (d) => {
    try {
      const out = require('child_process').execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'],
        { cwd: d, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      return out ? path.resolve(out).replace(/\\/g, '/').toLowerCase() : null;
    } catch { return null; }
  };
  const insideProject = (() => {
    const rel = path.relative(realResolve(projectDir, '.'), realResolve(workDir, '.'));
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  })();
  const linkedWorktreeOfProject = Boolean(
    workIdentity && projectIdentity && workIdentity !== projectIdentity
    && commonDirOf(workDir) && commonDirOf(workDir) === commonDirOf(projectDir),
  );
  const sharedCheckout = Boolean(workIdentity && workIdentity === projectIdentity)
    || (insideProject && !linkedWorktreeOfProject);

  /*
   * ⛔ ONE CLEANUP-AWARE DENIAL PATH. Leases acquired during THIS decision are released before the
   * refusal is emitted, because a refused tool call executes nothing and must therefore own nothing.
   * The previous ordering acquired index one, failed on index two, denied — and left index one wedged
   * behind a session that had mutated not a single byte. Leases the session already held before this
   * call are NOT touched: they belong to work that did run.
   */
  const acquired = [];
  const deny = (reason) => {
    for (const identity of acquired) { try { lease.release(projectDir, identity, who); } catch { /* best effort */ } }
    emitDeny(reason);
  };

  /*
   * ⭐ ONE SWITCHABLE RULE, APPLIED AT ITS SITE. `reason` is a THUNK so an `off` rule costs nothing to
   * skip: several of these sentences resolve real paths to build themselves.
   *
   *   deny    today's refusal, verbatim, and it never returns.
   *   advise  the same sentence through the non-blocking channel, buffered — the pass continues, so the
   *           fixed rules below a downgraded one still get to run.
   *   off     the rule stands down and says nothing.
   *
   * ⛔ ONLY FOUR IDS EVER REACH HERE, AND THEY ARE THE FOUR THE RESOLVER TABLE CARRIES. `verdict()`
   * answers `deny` for anything it does not know, which makes a typo tighten rather than loosen — but
   * that is a backstop, not a licence. `index-guard:wave-sweep`, `:foreign-staged` and `:control-plane`
   * are fixed by anti-drift items 21 and 22, the resolver has NO KEY for them, and this file must never
   * ask: a refusal that is unavailable cannot be argued with, while one that is merely denied by default
   * is one table row away from being granted. `hooks/hooks.test.mjs` reads this file's own source and
   * asserts the set of rule ids it names is exactly those four.
   */
  const ruled = (id, reason) => {
    const v = posture.verdict(resolved, id);
    if (v === 'deny') deny(reason());
    if (v === 'advise') {
      advise(`🔓 index-guard: \`${id}\` would have refused this call, and under the \`${resolved.profile}\` `
        + `posture declared for this project it advises instead. What it would have said:\n${reason()}`);
    }
    return v;
  };

  const WORKTREE_HINT = 'Dispatch with isolation: "worktree" for its own checkout and index. ⛔ A worktree is COLLISION isolation, not an OS sandbox: it stops ordinary relative operations from colliding, it does not stop a program from naming an absolute path outside it.';

  // --- editor-tool writes -------------------------------------------------------------------------
  if (EDIT_TOOLS.test(input.tool_name || '')) {
    if (!who.isSubagent) finish();                  // the main thread writes freely
    if (!sharedCheckout) finish();                  // isolated worktree — worktree-guard owns containment
    const target = (input.tool_input && (input.tool_input.file_path || input.tool_input.notebook_path)) || '';
    const scratch = scratchRootFor(who);
    if (target && containedIn(projectDir, target, scratch)) finish();

    /*
     * ⭐ SWITCHABLE: `index-guard:editor-containment` is `off` under `light`, `deny` under `standard`
     * and `strict` (ADR-003). What it does NOT reach: the control-plane refusal and the other-agent
     * scratch refusal, both of which have already run above and are not routed through the resolver —
     * a shared-checkout helper under `light` may write project files, and still may not write the
     * artifacts that decide what agents are allowed to do.
     */
    ruled('index-guard:editor-containment', () => (
      `🔒 index-guard: this subagent shares the orchestrator's checkout, so it may write only inside ` +
      `${scratch}/ — and "${target}" is outside it.\n` +
      `${ONBOARDING_AGENTS.has(String(who.agentType)) ? `An onboarding mapper's Write grant is scoped to ${scratch}/; a tool grant is not path authorization.\n` : ''}` +
      `The scratch root is per-agent on purpose: two helpers sharing one scratch directory is the same collision ` +
      `one directory further down.\n` +
      `Disjoint file scopes do NOT partition the git index — RespawnPack's own dogfood recorded two agents ` +
      `committing each other's in-progress work in one wave, in both directions.\n` +
      `Fix, cheapest first: dispatch with isolation: "worktree" for its own checkout and index, or have it ` +
      `RETURN the change and let the orchestrator apply it.`
    ));
  }

  if (!isBash) finish();

  const analysed = gitCommands.map((c) => ({ c, cls: effect.classify(c) }));

  /*
   * ⛔ AN UNMODELLED CONSTRUCT MUST NOT AUTHORISE A MUTATION. The previous version reported the
   * construct to the main thread as additionalContext and then allowed the command — so the warning
   * and the authorization arrived together, which is not enforcement. What changed:
   *   • the scan is QUOTE-AWARE, so `git commit -m '$(date)'` is an ordinary command with a literal
   *     message and is checked normally instead of being waved through as unanalysable;
   *   • the outer command structure is preserved, so a git index mutation standing next to an
   *     unmodelled construct is still SEEN — and refused, because its effect cannot be established;
   *   • a non-git unmodelled command stays advisory, so ordinary development is not blocked.
   */
  if (parsed.unsupported) {
    /*
     * ⭐ SWITCHABLE, AND THE ONLY ONE OF THE FOUR WHOSE CELL SAYS MORE THAN A WORD.
     * ADR-003: `advise` under `light`, `HIDDEN_PROGRAM only` under `standard`, `deny` under `strict`.
     *
     * ⛔ THE NARROWING IS READ FROM THE PROFILE, NOT FROM THE VERDICT, BECAUSE THE VOCABULARY CANNOT SAY
     * IT. `_posture.js` carries the `standard` cell as `deny` with a `qualifiers.standard` note, since
     * the four verdict words are `off`/`advise`/`deny`/`n.a.` and none of them means "denies a subset".
     * So the subset is applied here — and only when the `deny` actually came from the `standard` column:
     * a founder who writes an explicit `{"verdict": "deny"}` override for this id is asking for the whole
     * rule and gets the whole rule, which is why the override is checked rather than assumed away.
     */
    const unmodelledVerdict = posture.verdict(resolved, 'index-guard:unmodelled');
    const narrowedToHiddenProgram = unmodelledVerdict === 'deny'
      && resolved.profile === 'standard'
      && !Object.prototype.hasOwnProperty.call(resolved.overrides || {}, 'index-guard:unmodelled');

    /*
     * ⭐ THE DECLARED EXCEPTION, ASKED ONCE FOR THIS COMMAND AND FOR THIS RULE ONLY (P1-E-1d).
     *
     * The subject is the command line this guard judged, fingerprinted through the one shared spelling
     * (`_cmd.dequote` then `_exceptions.fingerprint`), so what the refusals below PRINT is what the
     * founder pastes into `respawnpack.config.json`.
     *
     * ⛔ A LIFT SKIPS THE THREE `:unmodelled` CLAUSES AND NOTHING ELSE, AND IT DOES NOT EXIT. That is
     * the same shape the `advise` verdict already has, for the same reason: the wave sweep, the
     * foreign-staged intersection and the control-plane refusal live BELOW this block and are fixed in
     * every posture (anti-drift items 21 and 22). Exiting here on a lift would relax all three by
     * omission, which is the single most likely way this feature loses an anti-drift rule by accident.
     * Nor does a lift authorise anything: the command continues into the ordinary checks, where a
     * shared-checkout helper still gets no Bash and a mutation outside a helper's own worktree is still
     * refused — exactly as the `substitutionsRead` relaxation above already behaves.
     *
     * ⛔ AND UNDER `light`, WHERE THIS RULE ADVISES RATHER THAN REFUSING, THE LIFT SILENCES THE ADVISORY.
     * An advisory about a subject the founder has already reviewed and declared is noise that trains a
     * reader to skim the channel the fixed rules also speak on.
     */
    const commandFingerprint = exceptionsLib.fingerprint(cmdlib.dequote(command));
    const unmodelledException = exceptionsLib.allowed(ctx.exceptions, 'index-guard:unmodelled', { command: commandFingerprint });
    /*
     * Today's clause, unless the founder named this exact command. `reason` stays a thunk either way, so
     * a lifted clause costs nothing to skip. The lift is RECORDED ONLY IF A CLAUSE WAS ACTUALLY SKIPPED:
     * a declaration that matched a command no clause would have refused has lifted nothing, and saying
     * otherwise would put "allowed by exception" on a decision the exception did not change.
     */
    let liftedHere = false;
    const unmodelled = (reason) => {
      if (unmodelledException) {
        if (!liftedHere) { liftedHere = true; lift(unmodelledException); }
        return 'off';
      }
      return ruled('index-guard:unmodelled', reason);
    };
    /** The paste-able tail every `:unmodelled` refusal carries, so a founder can act on the deny. */
    const declareIt = () => (
      `\nCommand fingerprint: ${commandFingerprint}. To except THIS command and nothing else, add to `
      + `respawnpack.config.json: {"id": "<a name>", "rule": "index-guard:unmodelled", `
      + `"match": {"command": "${commandFingerprint}"}, "reason": "<why you reviewed and accepted it>"}. `
      + `It lifts this one command line; the wave-sweep, foreign-staged and control-plane refusals cannot be `
      + `excepted at all.${refusedNote(ctx.exceptions)}`
    );

    /*
     * ⛔ AND THE BLANKET SUBAGENT REFUSAL IS NARROWED TO WHAT WAS ACTUALLY UNREADABLE (finding I-8).
     * It fired on the mere PRESENCE of a construct, so `echo $(git rev-parse HEAD)` — a read that
     * touches no index — was refused with "which index it would touch cannot be established", which was
     * simply not true once the parser began reading constant substitution spans. A helper told the
     * wrong reason retries the wrong way; the reason that IS true is the boundary further down.
     *
     * ⭐ `substitutionsRead` is the whole of the relaxation, and it relaxes nothing else. It is true
     * only when every construct here was a substitution span AND every one of those spans was read, so
     * an opaque or nested one still fails closed with the identical message. Nor does it authorise
     * anything: the command continues to the ordinary checks, where a shared-checkout helper still gets
     * no Bash and a worktree helper still faces the lease and ownership rules. The fail-closed reading
     * of a `_shell.js` that lost the field is the old behaviour, because only `=== true` relaxes.
     */
    if (who.isSubagent && parsed.substitutionsRead !== true && !narrowedToHiddenProgram) {
      unmodelled(() => (
        `🔒 index-guard: this command uses ${parsed.unsupported}, which the guard does not model, so which index it ` +
        `would touch cannot be established. Denied fail-closed for a subagent.\n${WORKTREE_HINT}${declareIt()}`
      ));
    }
    /*
     * ⛔ A CLAIMED WRAPPER WHOSE PROGRAM CANNOT BE LOCATED HIDES EVERYTHING, so there is nothing left to
     * check and no honest way to allow it. `sh -c "$CMD"`, `cmd /c "git -C %TARGET% add -A"` and
     * `nice --unmodelled-flag git add -- A.txt` all used to pass as ADVISORIES precisely BECAUSE the
     * parser could see no git — the hiding was rewarded. The caller chose the wrapper, so the literal
     * alternative is one edit away and the refusal names it.
     */
    if (parsed.unsupportedKind === shell.HIDDEN_PROGRAM) {
      // The one clause `standard` keeps: a wrapper that hides its program leaves NOTHING to check, so
      // there is no narrower reading of it to fall back to.
      unmodelled(() => (
        `🔒 index-guard: this command runs another program through a wrapper, and which program cannot be ` +
        `determined here — ${parsed.unsupported}. Nothing behind the wrapper is visible to this guard, so ` +
        `whether it mutates an index cannot be established, and "the guard could see no git" is what a hidden ` +
        `command looks like rather than evidence that there is none.\n` +
        `Run the literal command instead: resolve the program string yourself, use a wrapper option this guard ` +
        `models, or drop the wrapper and write the command directly — git add -- src/a.ts.${declareIt()}`
      ));
    }
    const mutating = analysed.filter((a) => a.cls.mutates);
    if (mutating.length && !narrowedToHiddenProgram) {
      unmodelled(() => (
        `🔒 index-guard: this command uses ${parsed.unsupported}, and it also runs "git ${mutating[0].c.gitSub}", ` +
        `which mutates the index. The effect of that mutation cannot be established, and a warning issued alongside ` +
        `an authorization is not a check.\n` +
        `Run the simpler equivalent: resolve the substitution yourself and pass the literal value, or run the git ` +
        `command on its own line with explicit paths — git ${mutating[0].c.gitSub} -- <path>.${declareIt()}`
      ));
    }
    /*
     * ⛔ THE ADVISORY TAIL IS THE MAIN THREAD'S, AND SAYING SO IS WHAT KEEPS THE BOUNDARY BELOW REACHABLE.
     * It has only ever been reached by the main thread — a subagent denied above — and writing that as
     * the condition rather than leaving it implicit is what stops a subagent whose substitutions WERE
     * read from exiting 0 here with an advisory, which would have handed a shared-checkout helper the
     * shell that the no-Bash rule further down exists to refuse. A subagent falls through instead.
     */
    if (!who.isSubagent && !mutating.length) {
      finish(`index-guard could not model this command (${parsed.unsupported}); it contains no git index mutation, so index-ownership checks were skipped for it.`);
    }
    /*
     * ⛔ AND WHEN THE POSTURE DOWNGRADED THE CLAUSE ABOVE, THE PASS MUST NOT END HERE EITHER — FOR THE
     * OPPOSITE REASON AND THE SAME ONE. Under `strict` a mutating git command standing beside an
     * unmodelled construct was refused two clauses up, so this line was only ever reached with nothing
     * left to check. Under `light` or `standard` that refusal is downgraded, and the command is now on
     * its way to `git add -A` with a wave in flight or to a foreign-staged intersection: both of those
     * are FIXED in every posture (anti-drift item 21) and both live below. Exiting here with an
     * advisory would have relaxed them by omission, which is a downgrade turning into a bypass.
     */
    /*
     * ⛔ AND A LIFTED CLAUSE MUST NOT LEAVE THIS SENTENCE BEHIND. It says the refusal was downgraded by
     * the PROJECT'S POSTURE, which is false when what actually happened is that the founder declared
     * this one command — under `strict`, where nothing is downgraded at all, it would be a plain
     * untruth. The lift's own note is already on both channels; this one stands down.
     */
    if (!who.isSubagent && !liftedHere) {
      advise(
        `index-guard could not model this command (${parsed.unsupported}), and it also runs `
        + `"git ${mutating[0].c.gitSub}", which mutates the index, so the effect of that mutation could not be `
        + `established. Under this project's \`${resolved.profile}\` posture that is advisory rather than a `
        + 'refusal — the ownership rules that do not depend on reading the whole command line still ran.',
      );
    }
  }

  /*
   * --- every git command, target resolved BEFORE any exemption ------------------------------------
   * The worktree exemption is granted per-command and only once that command is PROVEN to target the
   * helper's own index. Granting it up front is what let `git -C <main> add -A` through.
   */
  const pending = [];
  for (const { c, cls } of analysed) {
    /*
     * ⛔ AN OVERRIDE ON A COMMAND THAT TOUCHES NO INDEX IS NOT AN INDEX-RESOLUTION PROBLEM. This check
     * ran before the mutation test, so `git --git-dir=.git status` and `GIT_DIR=.git git status` were
     * refused with "which index it would mutate cannot be established" — about `git status`, which
     * mutates nothing. The override still fails closed for anything that DOES touch the index.
     */
    if (!cls.mutates) continue;
    if (c.unsafeOpt || c.gitEnvOverride) {
      deny(
        `🔒 index-guard: this command overrides git's index/worktree resolution ` +
        `(${c.unsafeOpt || c.gitEnvOverride}), so which index it would mutate cannot be established. Denied fail-closed.\n` +
        `An override the guard cannot resolve is exactly the case not to guess about — it is also how an isolated agent ` +
        `would reach the main checkout. Run git from the directory you mean to affect.`,
      );
    }

    // ⛔ A `-c` that redefines what git EXECUTES is an index-resolution override for a mutating command:
    // `-c core.hooksPath=…` makes the commit run someone else's script, `-c alias.x=…` makes the
    // subcommand mean something else entirely. Ordinary keys (`-c user.name=…`) stay unremarkable.
    const dangerousKey = (c.configKeys || []).find(shell.redefinesExecution);
    if (dangerousKey) {
      deny(
        `🔒 index-guard: "git -c ${dangerousKey} … ${c.gitSub}" redefines what git executes (a pager, editor, hook path, ` +
        `SSH command or alias) while mutating the index, so what this command would actually do cannot be established. Denied.\n` +
        `Set the configuration explicitly and separately if you need it, or run the command without the override.`,
      );
    }

    /*
     * ⛔ A TARGET INDEX THAT CANNOT BE IDENTIFIED IS CANNOT_DETERMINE, NOT "SOMEONE ELSE'S PROBLEM".
     * `git -C "$TARGET" add -- A.txt` resolved to a directory literally named `$TARGET`, which is not
     * a repository — and the old `continue` then skipped every check on a command that was about to
     * stage into whatever `$TARGET` really is.
     */
    if (c.dirDynamic) {
      deny(c.dirDynamicWhy === 'escape'
        ? `🔒 index-guard: "git ${c.gitSub}" names its repository with an unquoted backslash, which POSIX shells ` +
          `drop and cmd keeps — the two readings name different directories, so which index it would mutate cannot ` +
          `be established. Denied fail-closed.\n` +
          `Quote the path ("C:\\path\\to\\repo") or write it with forward slashes, then retry.`
        : `🔒 index-guard: "git ${c.gitSub}" names its repository through a value expanded at run time ` +
          `(a -C, --chdir or cd target this guard cannot resolve), so which index it would mutate cannot be ` +
          `established. Denied fail-closed.\n` +
          `Run git from the directory you mean to affect, or pass the literal path — git -C <path> ${c.gitSub}.`);
    }
    const targetIdentity = lease.indexIdentity(c.dir);
    if (!targetIdentity) {
      deny(
        `🔒 index-guard: "git ${c.gitSub}" would mutate an index, but "${c.dir}" could not be identified as a ` +
        `repository, so there is no index to check it against. Denied fail-closed.\n` +
        `If the path is right, the repository is missing or unreadable; if it came from an expansion, pass the ` +
        `literal path instead.`,
      );
    }
    const targetsProject = targetIdentity === projectIdentity;
    const targetsOwnWorktree = Boolean(workIdentity && targetIdentity === workIdentity && !sharedCheckout);

    if (who.isSubagent && !targetsOwnWorktree) {
      deny(
        `🔒 index-guard: "git ${c.gitSub}" would mutate ` +
        `${targetsProject ? "the ORCHESTRATOR'S index" : "an index outside this agent's worktree"}` +
        `${sharedCheckout ? ', which this subagent shares' : ' — redirecting git away from its own worktree'}. Denied.\n` +
        `${cls.why}\n` +
        `Dispatch with isolation: "worktree" and mutate your own index, or return the work and let the orchestrator ` +
        `stage the exact paths it owns.`,
      );
    }
    /*
     * ⛔ AN AGENT'S OWN WORKTREE IS NOT EXEMPT FROM THE LEASE. The old `continue` here skipped
     * acquisition entirely, so the "worktree writers are isolated" guarantee rested on the ASSUMPTION
     * that no two principals share one worktree — and the fixture that claimed to prove exclusivity
     * called the lease library directly, never reaching this branch. Two agents pointed at one linked
     * worktree both staged. Worktrees remain convenient because their index IDENTITIES differ, which
     * makes the lease uncontended; they are not convenient because the rule stops applying.
     */
    pending.push({ c, cls, targetIdentity });
  }

  /*
   * ⛔ POLICY CHECKS RUN BEFORE ACQUISITION. Taking the lease first meant a DENIED mutation still owned
   * the index and wedged every other session:
   *   S1 tries to overwrite foreign staged A → denied, but now holds the lease;
   *   S2 tries to stage unrelated B → denied because S1 "holds" it, having mutated nothing.
   * Nothing below acquires until the operation is going to be allowed.
   */
  for (const { c, cls } of pending) {
    if (cls.sweeping) {
      const wave = waveInFlight(projectDir, who.sessionId);
      if (wave.status !== 'PASS') {
        deny(
          `🔒 index-guard: this is a sweeping index operation ("${c.segment.trim().slice(0, 80)}") and whether a ` +
          `parallel wave is in flight could not be established — ${wave.reason}. Denied fail-closed.\n` +
          `An unreadable counter is not a count of zero, and this is the exact operation that counter exists to ` +
          `refuse. Repair or remove ${path.join('.respawnpack', `spawn-state-${String(who.sessionId).replace(/[^a-zA-Z0-9_-]/g, '_')}.json`)}, ` +
          `or stage the explicit paths instead: git add -- <path> <path>.`,
        );
      }
      if (wave.inFlight) {
        deny(
          `🔒 index-guard: sweeping index operation ("${c.segment.trim().slice(0, 80)}") while subagents are in flight.\n` +
          `${cls.why}\n` +
          `A directory-wide add is how RespawnPack's dogfood swept an unfinished file into another agent's commit. ` +
          `Stage the explicit paths this wave owns: git add -- <path> <path>.`,
        );
      }
    }

    const verdict = lease.foreignStates(projectDir, who.sessionId, c.dir);
    if (verdict.status !== 'PASS') {
      deny(
        `🔒 index-guard: "git ${c.gitSub}" would mutate this index, but its staged state could not be inspected — ` +
        `${verdict.reason}. Denied fail-closed.\n` +
        `An index this guard cannot read is not an index it can call clean: an inability to inspect is not evidence of ` +
        `emptiness. Repair or re-create the index, then retry.`,
      );
    }
    const hit = effect.intersectForeign(verdict.states, cls);
    if (!hit.length) continue;

    const show = hit.slice(0, 5).map((f) => `${f.status === 'D' ? 'deleted ' : ''}${f.path}`).join('\n  ');
    deny(
      `🔒 index-guard: "git ${c.gitSub}" would ${cls.sweeping ? 'sweep' : 'overwrite'} ${hit.length} staged change(s) ` +
      `this session did not create — someone's work in progress:\n  ${show}\n` +
      `Why this counts as ${cls.sweeping ? 'sweeping' : 'targeted'}: ${cls.why}\n` +
      /*
       * ⛔ THE CHECKOUT/SWITCH SENTENCE IS DELIBERATE, AND IT IS AN ADMISSION (M.2). Six rounds of
       * adversarial review plus an independent external gate established that "this particular branch
       * transition is harmless" cannot be decided from a command line — each proof was true for the
       * spellings its author imagined and false for the next one. The guard stopped trying. Saying so
       * here is what stops the next reader re-adding the proof to make one refusal go away.
       */
      `${c.gitSub === 'commit'
        ? 'Commit the exact paths instead — git commit -- <path> — which leaves the other staged entries untouched.'
        : c.gitSub === 'checkout' || c.gitSub === 'switch'
          ? 'A checkout/switch transition can change HEAD and therefore what staged entries mean. This guard '
            + 'does not attempt to prove a particular branch transition neutral while protected staged work '
            + 'exists. Finish the staged work, use this agent\'s own worktree, or — when paths rather than HEAD '
            + 'are what you meant — use an explicit -- <path> operation.'
          : 'Scope the operation with an explicit -- <path>, or let the human finish with these first.'}\n` +
      `If you need a clean index, use a separate worktree. ⛔ Do NOT unstage-and-restage to work around this: ` +
      `that destroys the very state it claims to protect.`,
    );
  }

  /*
   * --- the shared-checkout subagent boundary --------------------------------------------------------
   * ⛔ NO BASH. Not "no Bash by default" — no Bash. The allowlist behind the old opt-in marker was
   * probed once more in M.1c and yielded five more writing forms of nominally reading commands
   * (`sort -oFILE`, `file -C -m`, `date --set=`, `GIT_PAGER=<program> git log`,
   * `git -ccore.pager=<program> log`). Three rounds of the same finding is the finding: a PreToolUse
   * hook cannot prove what a program does with its arguments, and a marker file that re-enables the
   * attempt is itself a control-plane artifact a helper could try to create. Read/Grep/Glob cover the
   * whole read path with no shell; anything beyond that gets a worktree.
   */
  /*
   * ⭐ SWITCHABLE: `index-guard:no-bash` is `off` under `light`, `deny` under `standard` and `strict`.
   * "Not configurable" in the sentence below still holds where it was written: no marker file and no
   * subagent-reachable artifact lifts it. What lifts it is a founder's declaration in the tracked,
   * reviewable config, which is the whole difference ADR-003 draws between an override and a marker.
   * And it lifts only THIS rule: the per-command loop above has already refused any mutation of an index
   * outside the helper's own worktree, so `light` buys a shared helper a shell, never the index.
   */
  if (who.isSubagent && sharedCheckout) {
    ruled('index-guard:no-bash', () => (
      `🔒 index-guard: this subagent shares the orchestrator's checkout, and a shared-checkout subagent gets no Bash.\n` +
      `Use Read, Grep and Glob — together they cover reading, searching and listing without a shell, which is the ` +
      `whole read path a shared helper needs.\n` +
      `${WORKTREE_HINT}\n` +
      `⛔ Why there is no "read-only commands" exception: a PreToolUse hook cannot prove what a program does. ` +
      `Every iteration of an allowlist here shipped another writing form — tree -o, git log --output=, ` +
      `git symbolic-ref HEAD <ref>, sort -oFILE, file -C -m, GIT_PAGER=<program> git log. The boundary shrank ` +
      `instead of the list growing, and it is not configurable.`
    ));
  }

  /*
   * --- acquisition, all-or-nothing ------------------------------------------------------------------
   * Deterministic order by index identity, so two sessions racing the same pair of indexes cannot
   * deadlock by taking them in opposite orders. Any failure below routes through `deny`, which
   * releases everything this decision acquired.
   */
  /*
   * ⭐ SWITCHABLE: `index-guard:writer-lease` is `off` under `light`, `deny` under `standard` and
   * `strict`. `off` means the lease is not TAKEN either, not merely not enforced: a lease recorded and
   * never honoured is a record every other principal would still be refused by while this one ignores
   * it, which is worse than no lease at all. `_index-lease.confirm()` returns false for an identity with
   * no record, so the PostToolUse path stays correct with nothing acquired.
   */
  const leaseRule = posture.verdict(resolved, 'index-guard:writer-lease');
  const targets = leaseRule === 'off' || leaseRule === 'n.a.'
    ? []
    : [...new Set(pending.map((p) => p.targetIdentity))].sort();
  for (const targetIdentity of targets) {
    const held = lease.acquire(projectDir, targetIdentity, who);
    if (!held.ok) {
      // `ruled` denies (never returning) or buffers the same sentence; an advised failure holds no lease,
      // so it must not be recorded as acquired — the next identity is tried on its own merits.
      ruled('index-guard:writer-lease', () => (
        `🔒 index-guard: ${held.status === 'CANNOT_DETERMINE'
          ? `the writer lease on this index could not be established or verified (${held.reason}). Denied fail-closed — a guard that proceeds when its own guarantee is unavailable is not a guard.`
          : `another principal holds the writer lease on this index (${held.holder}, since ${held.since}).`}\n` +
        `Two sessions staging into one index is the DF-004 failure with different actors. Wait for it to finish, ` +
        `or work in a separate worktree — \`git worktree add ../side -b side\` — which has its own index.`
      ));
      continue;
    }
    if (!held.alreadyHeld) acquired.push(targetIdentity);
  }

  /*
   * Re-check under the lock: state can move between the policy pass and acquisition. Same intersection.
   *
   * ⛔ AND IT RUNS WHETHER OR NOT A LEASE WAS TAKEN. This is the foreign-staged intersection, which is
   * FIXED in every posture (anti-drift item 21); making it conditional on the switchable lease rule
   * would relax a fixed rule through the back door, which is the one direction that costs. With
   * `index-guard:writer-lease` off there is no lock to be under, so this is a second reading rather than
   * a locked one — a redundant pass, never a missing check.
   */
  for (const { c, cls } of pending) {
    const verdict = lease.foreignStates(projectDir, who.sessionId, c.dir);
    if (verdict.status !== 'PASS') {
      deny(`🔒 index-guard: the staged state could not be inspected under the writer lease — ${verdict.reason}. Denied fail-closed.`);
    }
    const hit = effect.intersectForeign(verdict.states, cls);
    if (hit.length) {
      deny(`🔒 index-guard: staged state changed between the check and the lock — ${hit.length} foreign entr(y/ies) now intersect this operation. Re-read the index before retrying.`);
    }
  }

  finish();
}

module.exports = { check, context };

// --- standalone entry point ---
if (require.main === module) {
  let raw = '';
  process.stdin.on('data', (d) => (raw += d));
  process.stdin.on('end', () => {
    let input;
    try { input = JSON.parse(raw || '{}'); } catch { process.exit(0); } // unparseable — never block a turn
    const verdict = check(context(input));
    if (verdict) process.stdout.write(JSON.stringify(verdict));
    process.exit(0);
  });
}
