#!/usr/bin/env node
/*
 * RespawnPack · stop-savepoint.js — OPT-IN Stop hook that asks for a closeout when THIS SESSION
 * changed something.
 *
 * Wire as a Stop hook (see settings.snippet.json — opt-in; remove the Stop block to disable).
 *
 * ⭐ WHY IT FIRES AFTER REAL WORK BY DEFAULT, AND MUST STAY THAT WAY (not literally unconditional:
 * `stop_hook_active` and `rt.alreadyStoppedOn` both suppress it, so a session is held once, never in a
 * loop — see both guards below). Field run B (its DOGFOOD.md,
 * DF-010) recorded this hook's best result: every savepoint it forced caught at least one derived
 * document asserting something FALSE — seven in one session, one of which had rotted within the hour.
 * It worked precisely because it never asked the agent's opinion of whether a closeout was warranted;
 * an agent that has just introduced a contradiction is the last one to notice it. So: gate on whether
 * the tree changed. Never on whether the model thinks it matters.
 *
 * ⛔ WHAT WAS WRONG, AND WHAT IT COST. This hook used to ask `git status --porcelain` — a TREE-state
 * question — while claiming in its own header to be "conservative by design". Field run A
 * (2026-08-03, defect 1) caught it: that repo was already dirty at boot (8 modified, 10
 * untracked, none from the session), so the hook fired on all FIVE turns of a session that wrote zero
 * files. A user mid-refactor, or with vendored artifacts, was nagged on every turn of every session
 * forever. Its blocking text even carried the escape hatch — "if this session changed nothing
 * doc-relevant, just stop again" — which is the hook asking the model to do the check the hook could
 * have done itself.
 *
 * It now diffs against the baseline SessionStart recorded (hooks/_runtime.js), so it fires on session
 * DELTA: a file that was already dirty and got edited again counts; the same file left untouched does
 * not; a commit that left a clean tree still counts, because work happened.
 *
 * ⛔ AND IT NO LONGER LOOPS. `stop_hook_active` guards exactly one turn. An agent that reasons for a
 * turn and tries to stop again arrives with the flag cleared and used to be blocked a second time on
 * identical state (recommendation R-8). A stop-decision record keyed on (session, HEAD, delta digest)
 * accepts an unchanged retry, and re-arms the moment new work appears.
 *
 * ⛔ AND A COMMITTED SAVEPOINT IS NOT "NEW WORK". The closeout's own last step — committing the
 * regenerated docs — moves HEAD, so the fingerprint guard re-armed and this hook asked for the savepoint
 * it was looking at. It now goes quiet when the session has no uncommitted delta, the savepoint receipt
 * records a PASS against the source HEAD still holds (savepoint-only commits in between do not count —
 * hooks/_manifest.js defines that once for every reader), and the durable state is CURRENT. See the
 * four-part check in the body; any part missing and the hook behaves exactly as before.
 *
 * ⛔ AND NEITHER IS THE ORIENTATION REFRESH `/respawn` STEP 0 MANDATES (the hooks findings I-2).
 * `skills/respawn/SKILL.md` tells a session to run `respawnpack.js state` the moment STATE.json does not
 * describe HEAD, and that refresh writes exactly one file — docs/derived/STATE.json — and commits
 * nothing. The four-part check above requires ZERO dirty files, so that one file, the file orientation
 * was TOLD to produce, still tripped the block: a session that did nothing but what it was asked to do
 * got nagged for a savepoint to close out. A second, narrower quiet branch covers exactly this shape;
 * see the check below the first. It does not widen the first branch — any other uncommitted change, or
 * HEAD having moved, still falls through to the ordinary block.
 *
 * When it fires it also raises a best-effort OS toast (zero-dep, platform-native, silent-fail — Windows
 * PowerShell / macOS osascript / Linux notify-send). Credited to the aggregator's stop-notification hook
 * (see ATTRIBUTION.md). Opt out with RESPAWNPACK_SAVEPOINT_TOAST=off. The toast is fire-and-forget: it can
 * never delay, block, or change the hook's decision — any failure (tool absent, sandbox) is swallowed.
 *
 * ⛔ AND IT NOW ALSO ASKS WHETHER THE BOUNDED TASK WAS EVER CLOSED (P5-CT-7). See the delegation gate
 * below: an OPEN `delegate` contract whose acceptance criteria carry no `contract complete --met`
 * attestation is a second, independent finding, and it is the one finding here that does not depend on
 * the session delta — a session that changed nothing and walked away from a bounded task is exactly the
 * silent close the core-adapters-ops audit §3 item 5 refuses to allow.
 *
 * Contract: stdin = Stop JSON {stop_hook_active, session_id, cwd}. Block = stdout {decision:"block", reason} + exit 0.
 * Where the posture switches `stop-savepoint:block` off, the same finding leaves as
 * {systemMessage, hookSpecificOutput.additionalContext} + exit 0 instead — advice, not a hold.
 */
const path = require('path');
const { spawn } = require('child_process');
// Advisory: this hook nudges at Stop and blocks nothing, so an unloadable dependency says why on
// stderr and exits 0 rather than failing the turn with a stack.
const boot = require('./_boot.js');
boot.arm('advisory');
const rt = boot.need('./_runtime.js');
/*
 * ⛔ THE POSTURE READER, AND THE SPLIT IT IS ALLOWED TO ACT ON (ADR-003, P3-T-10b).
 * This hook carries TWO rules, not one, and only the second is switchable:
 *   `stop-savepoint:detect`  the session delta, the stop-decision record, and the message that names
 *                            what changed. FIXED — anti-drift item 20. `advise` in all three postures.
 *                            No profile turns it off, because the block a looser posture downgrades is
 *                            still fed by it, and because a Stop hook that stopped LOOKING would report
 *                            a session with unrecorded work as a session with none.
 *   `stop-savepoint:block`   the `decision: "block"` that spends a turn holding the session open.
 *                            `off` under `light`, `deny` under `standard` and `strict`.
 * So under `light` this hook still detects, still records, still raises its toast and still says exactly
 * what changed — on the advisory channel Stop actually has — and simply does not hold the session.
 */
const posture = boot.need('./_posture.js');
/*
 * ⛔ THE RUNTIME CONTRACT IS READ THROUGH THE CLASSIFYING BOUNDARY, NOT THROUGH `rt.readContract`
 * (P5-CT-7). `readContract` degrades anything it cannot interpret to `collaborate`, which is the
 * conservative answer for a hook deciding how much CEREMONY a session owes and is the DANGEROUS one for
 * the question asked here: `collaborate` is exactly what a CLOSED delegation looks like, so degrading
 * would turn a transient read failure into "the bounded task was completed". `schemas/registry.json`
 * already writes that reasoning down for the task runner, which reads the same file for the same reason;
 * this hook is now the third reader that needs the five answers kept apart rather than collapsed.
 */
const artifact = boot.need('./_artifact.js');

// Fire an OS notification without adding a dependency and without ever throwing into the hook. Detached +
// stdio-ignored + unref'd so it outlives this short-lived process and doesn't hold its stdout open.
function notifyToast(title, body) {
  if (process.env.RESPAWNPACK_SAVEPOINT_TOAST === 'off') return;
  try {
    let cmd, args;
    if (process.platform === 'win32') {
      const ps =
        "$ErrorActionPreference='SilentlyContinue';" +
        '[Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime]|Out-Null;' +
        "$x=[Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02);" +
        "$t=$x.GetElementsByTagName('text');" +
        "$t.Item(0).AppendChild($x.CreateTextNode('" + title + "'))|Out-Null;" +
        "$t.Item(1).AppendChild($x.CreateTextNode('" + body + "'))|Out-Null;" +
        "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('RespawnPack').Show([Windows.UI.Notifications.ToastNotification]::new($x));";
      cmd = 'powershell';
      args = ['-NoProfile', '-NonInteractive', '-Command', ps];
    } else if (process.platform === 'darwin') {
      cmd = 'osascript';
      args = ['-e', `display notification "${body}" with title "${title}"`];
    } else {
      cmd = 'notify-send';
      args = [title, body];
    }
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {}); // tool missing / not permitted → silent, never affects the hook
    child.unref();
  } catch { /* best-effort only */ }
}

// A rejected stop must name ONE CONCRETE NEXT ACTION (R-8). "Continue toward the goal" is prohibited:
// a generic prompt is what turns a guard into a loop, because it gives the agent nothing to resolve.
/*
 * ⛔ "COULD NOT READ THE POLICY" IS SAID OUT LOUD — ON stderr, NEVER INTO THE DECISION. An UNREADABLE or
 * INVALID declaration resolves to `strict` inside `_posture.js`, so this hook blocks exactly as it does
 * for a project that declared nothing: the OUTPUT of a broken config is the output of no config, which
 * is what makes "strict is today" checkable. The fact still has to go somewhere, because a run that
 * quietly fell back looks identical to a run that was told to be strict — so it goes to the channel
 * `_boot.js` already uses for a hook running degraded, where it cannot alter the block reason.
 */
function sayIfUnreadable(resolved) {
  if (resolved.source !== 'UNREADABLE' && resolved.source !== 'INVALID') return;
  try { process.stderr.write(`RespawnPack stop-savepoint: ${resolved.detail}\n`); } catch { /* stderr is gone */ }
}

function describe(delta) {
  const shown = delta.files.slice(0, 5);
  const more = delta.files.length - shown.length;
  const parts = [];
  if (shown.length) parts.push(shown.join(', ') + (more > 0 ? ` (+${more} more)` : ''));
  if (delta.headMoved) parts.push(`HEAD moved ${String(delta.baselineHead).slice(0, 7)}→${String(delta.currentHead).slice(0, 7)}`);
  return parts.join('; ');
}

// --- the delegation gate (P5-CT-7) ------------------------------------------------------------------

const RUNTIME_CONTRACT_REL = '.respawnpack/runtime/contract.json';

/*
 * ⛔ AN OPEN DELEGATION IS, BY CONSTRUCTION, ONE WITH NO ATTESTATION — AND THAT IS WHY THE ARCHIVE IS
 * NOT CONSULTED HERE.
 *
 * `contract complete --met` is all-or-nothing: `kernel/lib/closeout.js` FAILs and writes nothing unless
 * every recorded criterion is restated, and the run that succeeds archives the attestation AND returns
 * the runtime pointer to collaborate (or to the goal the delegation suspended). So `mode: "delegate"`
 * on disk means no attestation was ever accepted for THIS delegation, and every recorded criterion is
 * unattested. `.respawnpack/runtime/delegations.json` holds attestations for delegations that already
 * CLOSED; reading it here would let a record from a previous, finished delegation of the same task
 * silence a freshly opened one, which is the manufactured-completion direction this whole file refuses.
 *
 * ⛔ AND THE FIVE ANSWERS STAY APART. ABSENT is genuinely "no contract" and is silent. A present file in
 * any other mode is silent. UNREADABLE, MALFORMED, and a delegate contract carrying no acceptance list
 * (which `contract delegate` refuses to write — anti-drift item 10, so it means a hand edit) all leave
 * the gate unable to answer: it reports that on stderr and hands the Stop back to today's behaviour,
 * because a gate that could not read its input has established nothing and may not hold a session on it.
 *
 * @returns {{status:'NONE'|'OPEN'|'UNREADABLE'|'MALFORMED', task:string|null, criteria:string[], detail:string|null}}
 */
function readOpenDelegation(dir) {
  const r = artifact.readJSONClassified(path.join(rt.runtimeDir(dir), 'contract.json'));
  const none = { status: 'NONE', task: null, criteria: [], detail: null };
  if (r.status === 'ABSENT') return none;
  if (r.status !== 'OK') {
    return {
      status: r.status, task: null, criteria: [],
      detail: `${RUNTIME_CONTRACT_REL} is ${r.status} (${r.detail || 'no detail'}), so whether a bounded task is still `
        + "open could not be established — falling back to today's behaviour",
    };
  }
  const c = r.doc;
  // A present file whose top level is not an object cannot be a contract, and reading `.mode` off an
  // array or a string answers `undefined`, which spells collaborate — the closed-delegation shape.
  if (!c || typeof c !== 'object' || Array.isArray(c)) {
    return {
      status: 'MALFORMED', task: null, criteria: [],
      detail: `${RUNTIME_CONTRACT_REL} is ${Array.isArray(c) ? 'an array' : c === null ? 'null' : typeof c}, expected a JSON `
        + "object — the delegation gate could not run, so this Stop falls back to today's behaviour",
    };
  }
  if (c.mode !== 'delegate') return none;

  const criteria = (Array.isArray(c.acceptance) ? c.acceptance : []).map((s) => String(s).trim()).filter(Boolean);
  if (!criteria.length) {
    return {
      status: 'MALFORMED', task: null, criteria: [],
      detail: `${RUNTIME_CONTRACT_REL} is in delegate mode and records no acceptance criteria. \`contract delegate\` `
        + 'refuses an empty list, so this file was hand-edited; there is nothing to attest to and nothing this gate '
        + "may conclude — falling back to today's behaviour",
    };
  }
  return { status: 'OPEN', task: typeof c.task === 'string' && c.task.trim() ? c.task.trim() : null, criteria, detail: null };
}

/*
 * ⛔ ONE SENTENCE, TWO CHANNELS, EXACTLY AS THE SESSION-DELTA FINDING BELOW. The block and the advisory
 * carry this identical string for the identical reason (item 20's rule applied to the second finding):
 * the posture and `RESPAWNPACK_TASK_ID` decide whether a finding HOLDS the session, never what was
 * found. It names ONE CONCRETE NEXT ACTION (R-8) — the exact command, once per recorded criterion — and
 * it explicitly refuses to let "not finished" be reported as "finished", which is the only outcome worse
 * than the hold.
 */
function delegationReason(open) {
  const shown = open.criteria.slice(0, 5);
  const more = open.criteria.length - shown.length;
  const named = shown.map((c) => `"${c}"`).join(', ') + (more > 0 ? ` (+${more} more)` : '');
  return `A bounded delegation is still OPEN${open.task ? `: ${open.task}` : ''}. Its ${open.criteria.length} recorded `
    + `acceptance criterion/criteria carry no \`contract complete --met\` attestation: ${named}. Close it before ending `
    + 'the session: run `contract complete --met "<criterion>"` once per RECORDED criterion — every one, or the close is '
    + 'refused and nothing is written. If the task is NOT finished, leave the contract open and say so plainly: a '
    + 'delegation that ends unattested is CANNOT_DETERMINE, and reporting it as done is the one thing this gate exists '
    + 'to prevent.';
}

let raw = '';
process.stdin.on('data', (d) => (raw += d));
process.stdin.on('end', () => {
  let input = {};
  try { input = JSON.parse(raw || '{}'); } catch { process.exit(0); }

  if (input.stop_hook_active === true) process.exit(0); // already nudged this turn → let it stop (loop guard)

  const dir = rt.projectDir(input);
  // ⛔ ONE RESOLUTION PER INVOCATION, taken where the pack's other hooks take their `.off` marker check
  // — before any branch, so every branch below reads the same declaration rather than re-reading a file
  // that can change between two reads inside one Stop.
  const stance = posture.resolve(dir);
  const sid = input.session_id;
  /*
   * ⛔ TASK-SESSION NARROWING (P5-T-16c; the hooks-and-install audit §6). Set by the task runner on the child
   * session's own environment, never by this hook. It narrows ONE thing, far below: whether a finding
   * may arrive as `decision:"block"`. It touches neither the detection immediately below (item 20,
   * `stop-savepoint:detect`, fixed in every posture) nor the session-delta it is computed from — a
   * spoofed value can make this hook stop HOLDING a session, never stop LOOKING at one.
   */
  const taskId = process.env.RESPAWNPACK_TASK_ID && String(process.env.RESPAWNPACK_TASK_ID).trim();
  const delta = rt.sessionDelta(dir, sid);

  /*
   * ⛔ THE DELEGATION GATE (P5-CT-7; the core-adapters-ops audit §5 T7 and §3 item 5, anti-drift items 9-11).
   *
   * `contract delegate` records a bounded task with a stated definition of done, and until now NOTHING
   * checked at Stop whether that definition was ever claimed: a session could be handed a bounded task
   * and simply end. The task runner reads the same contract out of band and scores an open, unattested
   * one as CANNOT_DETERMINE — this is the same question asked one layer earlier, where the session that
   * owes the attestation can still give it.
   *
   * ⛔ IT RUNS ABOVE THE SESSION-DELTA BRANCHES ON PURPOSE. Every branch below is a judgement about
   * WORK; this one is a judgement about a CONTRACT, and the two are independent. A task session that
   * changed nothing has an UNCHANGED delta and would exit silently three lines down, which is precisely
   * the "silently done" §3 item 5 refuses. It is also the more specific finding of the two, so it is the
   * one that speaks when both are present.
   *
   * ⛔ AND IT SAYS IT ONCE PER UNATTESTED SET, mirroring the blocked-savepoint branch below rather than
   * inventing a second convention. `stop_hook_active` covers one turn; an agent that reasons and stops
   * again arrives with the flag cleared, and a gate that cannot be satisfied by reasoning would then hold
   * the session forever — the R-8 loop this file's header was written about. Attesting closes the
   * contract and this goes quiet; changing what is open re-arms it. Nothing here reports an open
   * delegation as a closed one: the second Stop is silent about the CONTRACT, never about the task.
   */
  const open = readOpenDelegation(dir);
  if (open.detail) {
    // The degraded read goes where `sayIfUnreadable` already sends one, and cannot alter any decision.
    try { process.stderr.write(`RespawnPack stop-savepoint: ${open.detail}\n`); } catch { /* stderr is gone */ }
  }
  if (open.status === 'OPEN') {
    const branch = `delegate-open:${rt.sha(`${open.task || ''}|${open.criteria.join('\n')}`)}`;
    const alreadySaid = (rt.readJSON(rt.stopRecordPath(dir, sid)) || {}).branch === branch;
    if (!alreadySaid) {
      rt.recordStop(dir, sid, delta, branch);
      const reason = delegationReason(open);
      sayIfUnreadable(stance);
      // The same consult, the same rule id, the same two channels as the session-delta finding below —
      // ADR-003 names no id of its own for this gate, and a second id would be a second policy surface
      // for one hook's one `decision:"block"`.
      if (!taskId && posture.verdict(stance, 'stop-savepoint:block') === 'deny') {
        process.stdout.write(JSON.stringify({ decision: 'block', reason }));
        process.exit(0);
      }
      const named = open.task ? ` (${open.task})` : '';
      process.stdout.write(JSON.stringify({
        systemMessage: taskId
          ? `📌 RespawnPack: a bounded delegation is still open and unattested${named}. Close it with `
            + '`contract complete --met "<criterion>"`, once per recorded criterion. Not blocking the stop — this is a '
            + `task session (RESPAWNPACK_TASK_ID=${taskId}); a headless run has no human to act on a held turn, and the `
            + 'task runner reads this same contract out of band once this turn ends. The finding itself is unchanged.'
          : `📌 RespawnPack: a bounded delegation is still open and unattested${named}. Close it with `
            + '`contract complete --met "<criterion>"`, once per recorded criterion. Not blocking the stop — the '
            + `declared posture (${stance.profile}) downgrades stop-savepoint:block to an advisory (ADR-003). The `
            + 'finding itself is unchanged in every posture.',
        hookSpecificOutput: { hookEventName: 'Stop', additionalContext: reason },
      }));
      process.exit(0);
    }
  }

  // No baseline (hook installed mid-session, or not a git repo) — go quiet. Nagging on a state we
  // cannot reason about is how the old behavior earned its false-positive rate.
  if (delta.status !== 'CHANGED') {
    /*
     * ⛔ THE ONE CASE A TASK SESSION ADDS HERE: SAYING SO. A CANNOT_DETERMINE delta means the runtime
     * this narrowing would apply to — the SessionStart baseline `stop-savepoint:detect` diffs against —
     * is itself missing or unreadable. There is nothing here for RESPAWNPACK_TASK_ID to narrow, so the
     * exit below is exactly today's silent one either way; only a stderr line is added, on the same
     * channel `sayIfUnreadable` already uses for a degraded read, so the fallback is never invisible.
     */
    if (taskId && delta.status === 'CANNOT_DETERMINE') {
      try {
        process.stderr.write(
          `RespawnPack stop-savepoint: task session ${taskId} but the session runtime could not be read ` +
          `(${delta.reason || 'unreadable'}) — falling back to today's behaviour\n`,
        );
      } catch { /* stderr is gone */ }
    }
    process.exit(0);
  }

  // Unchanged retry after an earlier block → accept the stop instead of spending another turn.
  if (rt.alreadyStoppedOn(dir, sid, delta)) process.exit(0);

  const attempt = rt.readSavepointAttempt(dir);

  /*
   * ⛔ A SAVEPOINT THAT WAS RUN, PASSED, AND COMMITTED IS THE CLOSEOUT — NOT A REASON TO ASK FOR ONE.
   *
   * The documented flow ends by committing the regenerated docs as `docs(savepoint): regen at W`, and
   * that commit moves HEAD. So the delta fingerprint changed, the loop guard re-armed, and this hook
   * fired once more with "HEAD moved W→S" — demanding the savepoint whose commit it was looking at
   * (observed 2026-08-23). The evidence that the closeout is DONE is all on disk, and none of it is the
   * model's opinion:
   *   1. the session has no uncommitted delta — every file it touched is in a commit;
   *   2. the savepoint receipt says a run PASSED against source revision R;
   *   3. HEAD differs from R only by savepoint-only commits (hooks/_manifest.js sourceRevisions), so
   *      the run verified exactly the source HEAD holds;
   *   4. the durable state is CURRENT — bound inside that same chain, with every compiler input's
   *      digest still matching.
   * All four, or the hook behaves exactly as it always did. A receipt from an older kernel carries no
   * revision and fails (2); a savepoint run and not committed fails (1) and is still nagged; real work
   * committed after the savepoint fails (3) and (4) and is nagged; a savepoint that exited non-zero
   * fails (2) and falls through to the blocked-advisory branch below.
   */
  if (delta.headMoved && delta.files.length === 0 && attempt && attempt.exitCode === 0 && attempt.sourceRevision) {
    const durable = rt.readDurableState(dir);
    const chain = (durable.revisions && durable.revisions.chain) || [];
    if (durable.status === 'CURRENT' && chain.includes(attempt.sourceRevision)) process.exit(0);
  }

  /*
   * ⛔ THE ORIENTATION-ONLY CATCH-22 (the hooks findings I-2). `/respawn` Step 0 mandates
   * `respawnpack.js state` the instant STATE.json does not describe HEAD, and that refresh writes
   * exactly one file — nothing is committed — so the four-part check above, which requires ZERO dirty
   * files, could never go quiet for it. A session that ran only the orientation step this pack itself
   * demands was then told to run `/savepoint` to close out work it never did.
   *
   * Narrower than the branch above, not a relaxation of it: HEAD must not have moved, and the dirty set
   * must be this exact one file. Anything else — a second dirty file beside it, real work committed — is
   * still every bit as much "the session changed something" as before and falls through unchanged.
   *
   * ⛔ GATED ON readDurableState BEING CURRENT, NOT ON A REFRESH HAVING HAPPENED. A dirty STATE.json only
   * proves a write occurred; CURRENT is what proves the write can be trusted — the revision matches HEAD
   * (through the same savepoint-only equivalence class the branch above uses) and every compiler input's
   * digest still matches what the file claims to describe. STALE or CANNOT_DETERMINE — a stale or forged
   * revision, an unreadable file, a moved input — still blocks, exactly as today.
   *
   * ⛔ THE NAMED REMAINING GAP, SHARED WITH BOOT FRESHNESS. `readDurableState` verifies that STATE.json
   * is INTERNALLY CONSISTENT with the tree — not that a real compile produced it. A hand-tampered
   * solitary STATE.json that also forges a sourceManifest matching the live inputs would read CURRENT
   * and use this branch same as a genuine refresh would. This is not a hole this fix opens: boot
   * (hooks/_runtime.js readDurableState, read by session-routing-nudge.js) already extends STATE.json
   * the same trust before injecting its numbers. Closing it means re-deriving STATE.json's honesty from
   * its sources on every Stop, which is what `savepoint --verify` is for — out of scope for a narrowing.
   */
  if (!delta.headMoved && delta.files.length === 1 && delta.files[0] === 'docs/derived/STATE.json') {
    const durable = rt.readDurableState(dir);
    if (durable.status === 'CURRENT') process.exit(0);
  }

  /*
   * ⛔ A SAVEPOINT THAT WAS RUN AND COULD NOT FINISH MUST NOT BE DEMANDED AGAIN, IDENTICALLY, FOREVER.
   *
   * The delta-fingerprint guard above handles the retry-on-identical-state case, and it is correct —
   * but the 2026-08-07 field run §4 found the case it cannot reach. In a long session the tree changes on nearly
   * every turn, so the fingerprint is nearly always new, so the guard nearly always re-arms. Meanwhile
   * `savepoint --verify` was exiting 2 for STRUCTURAL reasons (an un-migrated derived doc, an
   * unconfigured contract) that no amount of further work would clear. The hook therefore repeated an
   * instruction that could not succeed, once per turn, for eight hours.
   *
   * The kernel now leaves a receipt on every savepoint run including the blocked ones, carrying a
   * digest of WHICH checks blocked it. If this session already ran one and hit the same blockers, the
   * useful message is not "run /savepoint" — it is "savepoint ran, here is what stopped it". So the
   * hook DOWNGRADES from `decision: block` to a plain advisory: it still speaks, it still names the
   * blockers, but it does not spend the turn.
   *
   * ⛔ AND IT RE-ARMS ON THE BLOCKER SET, NOT ON THE CLOCK. Fix one blocker and the digest changes and
   * the block returns, because there is now a savepoint worth running. This suppresses a repetition,
   * never a requirement — nothing here reports a blocked savepoint as a completed one.
   */
  if (attempt && attempt.exitCode !== 0) {
    const branch = `savepoint-blocked:${attempt.blockerDigest}`;
    const alreadySaid = (rt.readJSON(rt.stopRecordPath(dir, sid)) || {}).branch === branch;
    rt.recordStop(dir, sid, delta, branch);
    // Say it once per blocker set. A second identical advisory is the same nag wearing a quieter hat.
    if (alreadySaid) process.exit(0);
    const named = attempt.blockers.slice(0, 4).map((b) => `${b.check} (${b.outcome})`).join(', ');
    const more = Math.max(0, attempt.blockers.length - 4);
    process.stdout.write(JSON.stringify({
      systemMessage:
        `📌 RespawnPack: /savepoint was run this session and could not complete (exit ${attempt.exitCode}). ` +
        `Blocked by: ${named}${more > 0 ? ` (+${more} more)` : ''}. Not blocking the stop — re-running it ` +
        'unchanged would hit the same wall.',
      hookSpecificOutput: {
        hookEventName: 'Stop',
        additionalContext:
          `A savepoint WAS attempted this session and exited ${attempt.exitCode}. Blocked by: ` +
          `${named}${more > 0 ? ` (+${more} more)` : ''}. Do NOT report the session as cleanly saved — it was not. ` +
          'Report it as attempted-and-blocked, and name these checks. Each is structural (configuration or a ' +
          'one-time migration), so it is fixed by changing the project, not by running the command again. ' +
          'Once any of them is resolved this hook re-arms and will ask for a savepoint properly.',
      },
    }));
    process.exit(0);
  }

  rt.recordStop(dir, sid, delta);

  notifyToast('RespawnPack', 'This session changed files — consider /savepoint before ending it.');

  /*
   * ⛔ ONE SENTENCE, TWO CHANNELS — AND IT IS DELIBERATELY THE SAME SENTENCE. `stop-savepoint:detect`
   * produced this text and is fixed on in every posture; `stop-savepoint:block` decides only whether it
   * arrives as a decision that spends a turn or as advice that does not. Composing a second, shorter
   * message for the relaxed path would make the two postures disagree about WHAT WAS FOUND rather than
   * about what to do with it, which is the drift this split exists to prevent.
   */
  const reason =
    `This session changed: ${describe(delta)}. Run /savepoint to regenerate the derived docs ` +
    '(CHANGELOG / GAPS / CONTINUITY), verify the rendered claims against their structured source, and ' +
    'propose any memory entries from the session, so the next /respawn boots from a true handoff. ' +
    'If the savepoint is already done, stop again — this fires once per unchanged state, not once per turn.';

  sayIfUnreadable(stance);
  /*
   * ⛔ A TASK SESSION NEVER SEES `decision:"block"` HERE, REGARDLESS OF POSTURE (P5-T-16c). A headless
   * `--print` turn has no human to act on a held turn: blocking it either wastes the one turn the runner
   * paid for or hangs the runner waiting on a stop that never comes, and the runner already runs the real
   * `savepoint --verify` gate itself once this turn ends. So `taskId` short-circuits the posture consult
   * entirely rather than adding a fourth posture — `stop-savepoint:block` still resolves normally for
   * every OTHER caller, and a declared `strict` still blocks the moment this variable is absent.
   */
  if (!taskId && posture.verdict(stance, 'stop-savepoint:block') === 'deny') {
    process.stdout.write(JSON.stringify({ decision: 'block', reason }));
    process.exit(0);
  }

  /*
   * The relaxed path — reached either because the declared posture downgrades the block, or because this
   * is a task session and the block is withheld unconditionally. `additionalContext` is what the MODEL
   * reads, so the instruction still lands where it can be acted on and carries the EXACT SAME `reason`
   * string `decision:"block"` would have carried above — `stop-savepoint:detect` produced it once, and
   * it is fixed in every posture (item 20), so the two channels may not disagree about WHAT WAS FOUND,
   * only about what to do with it. `systemMessage` is user-visible only and says why the session was not
   * held; that attribution differs by which reason is in force, so the message names ONE cause, never
   * both, and never claims a posture downgrade when a task session is the actual reason.
   */
  process.stdout.write(JSON.stringify({
    systemMessage: taskId
      ? `📌 RespawnPack: this session changed: ${describe(delta)}. /savepoint is advised before ending it. ` +
        `Not blocking the stop — this is a task session (RESPAWNPACK_TASK_ID=${taskId}); a headless run has ` +
        'no human to act on a held turn, and the task runner runs the real savepoint gate itself once this ' +
        'turn ends. The detection itself is unchanged.'
      : `📌 RespawnPack: this session changed: ${describe(delta)}. /savepoint is advised before ending it. ` +
        `Not blocking the stop — the declared posture (${stance.profile}) downgrades stop-savepoint:block ` +
        'to an advisory (ADR-003). The detection itself is unchanged in every posture.',
    hookSpecificOutput: { hookEventName: 'Stop', additionalContext: reason },
  }));
  process.exit(0);
});
