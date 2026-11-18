/*
 * RespawnPack · adapters/codex/hooks/_shared.js — small conservative-failure helpers the Codex hook
 * scripts share. NOT A HOOK (leading underscore) and never registered with Codex directly.
 *
 * ⛔ WHY THIS EXISTS INSTEAD OF `require('../../../hooks/_boot.js')`. Codex hooks run under Codex, not
 * Claude Code, and hooks/_boot.js is Claude-shaped throughout (its degrade() emits `hookSpecificOutput`
 * with Claude's PreToolUse/SessionStart decision vocabulary — `permissionDecision`, Claude's own
 * `additionalContext` envelope assumptions). Importing it here would make an adapter under adapters/
 * depend on a sibling adapter's runtime, which is exactly the layering the v0.3 split exists to prevent
 * (see core/index.js's banner: "adapters ... consume [core]; the reverse would make the shared core a
 * function of one host's layout"). What DOES travel is the PHILOSOPHY, credited at each use:
 *   · a hook that cannot establish its own machinery answers conservatively instead of crashing raw
 *     (hooks/_boot.js's `degrade()`/`arm()` — mirrored below as `installSafetyNet`);
 *   · the failure posture is chosen by what the hook GUARDS, not by what broke (hooks/_boot.js's
 *     POSTURES enum — this module has no equivalent shared enum; each hook script instead passes
 *     `installSafetyNet` its OWN `onFail` callback embodying its posture, since a veto-capable hook's
 *     posture depends on state (has a gating context been established yet?) in a way a static enum
 *     value cannot express — see respawnpack-precompact.js's `sawGatingContext` for the concrete case);
 *   · raw stdin travels verbatim beside every typed interpretation of it (core/lifecycle/evidence.js's
 *     `raw` discipline, applied here to files this module writes that never reach core/).
 * This file is small on purpose: it is the ONLY thing every Codex hook script requires beyond core/ and
 * node builtins, so a defect here is the whole irreducible bootstrap for this adapter.
 *
 * ⛔ RAW STDIN IS STORED VERBATIM, ALWAYS. Codex's hook payload fields are only partially documented
 * (session_id, cwd, hook_event_name, permission_mode, turn_id, transcript_path, model — no consolidated
 * schema). Every record this module or its callers write carries the untouched payload beside whatever
 * this pack made of it, exactly as core/lifecycle/evidence.js requires for HOST_OBSERVED evidence kinds.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const HOST = 'codex';

// core/ is the only cross-tree dependency, and it is read-only from here — see the repo-wide banner in
// core/index.js. Resolved relative to THIS file so an installed copy finds its OWN core/, not a stray one.
const core = require(path.join(__dirname, '..', '..', '..', 'core', 'index.js'));

const RUNTIME_ROLLOVER_DIR = (projectDir) => path.join(projectDir, core.cycle.RUNTIME_SUBDIR);
const conversationDir = (projectDir, conversationId) => core.machine.conversationDir(projectDir, HOST, conversationId);

// Project-level files (siblings of the per-conversation `codex-<sid>/` directories, never inside one).
// Leading underscore keeps them visually distinct from `io.safeSegment`-derived conversation directory
// names, which never start with `_codex-` for an ordinary session/thread id.
const canaryPath = (projectDir) => path.join(RUNTIME_ROLLOVER_DIR(projectDir), '_codex-hooks-canary.json');
const lastActivePath = (projectDir) => path.join(RUNTIME_ROLLOVER_DIR(projectDir), '_codex-last-active.json');
const pendingNotePath = (projectDir) => path.join(RUNTIME_ROLLOVER_DIR(projectDir), '_codex-pending-note.json');

// Per-conversation files, siblings of that conversation's journal.jsonl / cycle.json / state.json.
const latestHandoffPointerPath = (dir) => path.join(dir, 'latest-handoff.json');
const postcompactLogPath = (dir) => path.join(dir, 'postcompact-log.jsonl');
const stopLogPath = (dir) => path.join(dir, 'stop-log.jsonl');
const escapeHatchLogPath = (dir) => path.join(dir, 'escape-hatch-used.jsonl');

const nowISO = () => new Date().toISOString();

/**
 * Read stdin to completion. Bounded by a timeout so a hook can never hang the host indefinitely if the
 * pipe is never closed — every caller still calls process.exit() explicitly once it decides, so the
 * timer being unref'd is a courtesy, not the safety mechanism.
 */
function readStdin(timeoutMs = 4000) {
  return new Promise((resolve) => {
    let data = '';
    let done = false;
    let timer = null;
    const finish = () => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve(data);
    };
    try {
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => { data += chunk; });
      process.stdin.on('end', finish);
      process.stdin.on('error', finish);
      if (typeof process.stdin.resume === 'function') process.stdin.resume();
    } catch {
      finish();
      return;
    }
    timer = setTimeout(finish, timeoutMs);
    if (timer && timer.unref) timer.unref();
  });
}

/**
 * Parse stdin defensively. Never throws.
 * @returns {{ok:true, value:object, rawText:string}|{ok:false, rawText:string, error:string}}
 */
function parseInput(rawText) {
  const text = typeof rawText === 'string' ? rawText : '';
  if (!text.trim()) return { ok: false, rawText: text, error: 'empty stdin' };
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, rawText: text, error: 'stdin parsed but is not a JSON object' };
    }
    return { ok: true, value, rawText: text };
  } catch (e) {
    return { ok: false, rawText: text, error: `not valid JSON: ${e.message}` };
  }
}

const isNonEmptyString = (v) => typeof v === 'string' && v.length > 0;

/** The project directory a hook should act on. `cwd` is a documented common field; process.cwd() is the
 * only sane fallback when it is missing, since Codex spawns the hook FROM that directory in every
 * observed invocation shape. */
function projectDirOf(input) {
  if (input && isNonEmptyString(input.cwd)) return input.cwd;
  return process.cwd();
}

const sidOf = (input) => (input && isNonEmptyString(input.session_id) ? input.session_id : null);
const eventOf = (input) => (input && isNonEmptyString(input.hook_event_name) ? input.hook_event_name : null);

/** Write JSON to stdout with NO trailing newline (matches the shape every other RespawnPack hook uses)
 * and exit. Kept separate from "emit nothing", which several Codex outputs deliberately choose instead —
 * see the per-hook comments on why an undocumented output field is a real risk (core/lifecycle/evidence.js
 * and hooks/precompact-ledger-nudge.js both record a hook whose OWN host rejected an unverified shape). */
function emitAndExit(obj) {
  try { process.stdout.write(JSON.stringify(obj)); } catch { /* stdout gone; exit is all that is left */ }
  process.exit(0);
}

function exitSilently() { process.exit(0); }

function stderrLine(msg) {
  try { process.stderr.write(`RespawnPack (Codex): ${msg}\n`); } catch { /* nothing left to tell */ }
}

/**
 * The last-resort net. Mirrors hooks/_boot.js's `arm()` in spirit only (credited above): an unforeseen
 * throw anywhere in a hook — including inside the stdin callback every hook uses — still produces this
 * hook's conservative answer instead of a raw crash or a bypass. `onFail` decides what "conservative"
 * means for THIS hook (veto-capable hooks may still choose to veto; purely observational ones just warn).
 */
function installSafetyNet(onFail) {
  const handle = (e) => {
    try { onFail(e); } catch { stderrLine('the safety net itself failed; exiting 0 with nothing further'); exitSilently(); }
  };
  process.on('uncaughtException', handle);
  process.on('unhandledRejection', handle);
}

// --- bounded raw payloads, mirroring core/lifecycle/evidence.js's withBoundedRaw for records that never
// reach core's own evidence.make() (the canary marker and the postcompact/stop logs are adapter-local,
// not core evidence records — but the same "verbatim, but not unbounded" discipline applies). --------
const MAX_RAW_BYTES = core.evidence.MAX_RAW_BYTES;

function boundedRaw(raw) {
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
  const bytes = Buffer.byteLength(text || '', 'utf8');
  if (bytes <= MAX_RAW_BYTES) return { raw, rawBytes: bytes, rawTruncated: false };
  return { raw: String(text).slice(0, MAX_RAW_BYTES), rawBytes: bytes, rawTruncated: true };
}

// --- git facts, best-effort. A hook is not a CI runner: any failure (no git, not a repo, timeout) ------
// degrades to null/[] rather than throwing, exactly like handoff.build()'s own defaults for git facts. --
function gitHead(cwd) {
  try {
    const out = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8', timeout: 3000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const head = out.trim();
    return head || null;
  } catch { return null; }
}

function gitUncommittedFiles(cwd) {
  try {
    const out = execFileSync('git', ['status', '--porcelain', '-uall'], { cwd, encoding: 'utf8', timeout: 3000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    /*
     * ⛔ THREE BUGS LIVED IN THE OLD FOUR-LINE VERSION OF THIS PARSE, ALL REPRODUCED DIRECTLY BY THE W6c
     * repo-state preservation battery (none was reachable by this suite before it, because no fixture
     * here had ever `git init`'d a real repository).
     *   (1) `.map((l) => l.trim())` ran BEFORE `.slice(3)`. Porcelain's status prefix is a FIXED two
     *       columns (X, Y) plus one separating space — and for the single most common case, an unstaged
     *       modification, X is a literal space (" M path"). `.trim()` ate that leading space first, so
     *       `.slice(3)` then cut three characters off a line with only TWO of prefix left — silently
     *       dropping the path's first character (" M tracked.txt" -> "racked.txt", verified against a
     *       real `git status --porcelain` line). Every plain "edited but not staged" file's name would
     *       reach the handoff corrupted.
     *   (2) no exclusion for this pack's OWN runtime directory. Computing this list can run AFTER
     *       `core.machine.open()` has just minted `.respawnpack/runtime/rollover/codex-<sid>/` for the
     *       first time in a repo that has not yet gitignored it — this adapter, unlike the Claude hooks'
     *       `hooks/_runtime.js` `isSelfPath()` guard, is not installed via install.js's .gitignore
     *       self-heal (adapters/codex/ is a manual/template install — see adapters/codex/README.md) — so
     *       the handoff would name its own bookkeeping directory as if it were the user's uncommitted
     *       work (reproduced: `git status --porcelain` reports `?? .respawnpack/` the moment that first
     *       write lands).
     *   (3) no `-uall`. Porcelain's DEFAULT untracked mode collapses a brand-new untracked DIRECTORY to
     *       one line naming the directory, not its contents (`?? src/`, not `?? src/scratch.ts`) —
     *       reproduced directly: a session that creates one new file inside a new subdirectory had that
     *       file's real path replaced by its parent directory's name in the handoff. `-uall` (matching
     *       `hooks/_runtime.js`'s own `treeState()`, which already passes it) lists untracked files
     *       individually, recursing into new directories instead of collapsing them.
     * (1) and (3) are fixed by never trimming before the fixed-width slice (a legal porcelain line is
     * always at least 4 bytes: two status columns, one space, one path byte) and by requesting the
     * uncollapsed listing; (2) is fixed by dropping this pack's own tree.
     */
    const files = out.split(/\r?\n/)
      .filter((l) => l.length > 3)
      .map((l) => l.slice(3).trim())
      .filter(Boolean)
      .filter((p) => p !== '.respawnpack' && !p.startsWith('.respawnpack/') && !p.startsWith('.respawnpack\\'));
    return [...new Set(files)].sort();
  } catch { return []; }
}

/* --- the activation canary — THE activation evidence. {event, at, session_id} is the brief's literal
 * shape; raw/fireCount/firstSeenAt are added for freshness-checking and audit, per-file below.
 *
 * ⛔ THE MARKER STATES ITS OWN VERDICT, AND IT IS ONLY EVER WRITTEN ON A REAL FIRING. This function is
 * called from inside a hook that Codex actually invoked — a wired, TRUSTED hook running is the whole
 * observation — so the verdict is PASS, recorded explicitly rather than implied by the file existing.
 * core/policy/capabilities.js downgrades any SUPPORTED claim whose canary does not carry OUTCOME PASS,
 * which means a marker written by an older version of this file (no `outcome` field) reads as "no
 * verdict recorded" and stops lifting capabilities until a hook fires again. That is the fail-closed
 * direction on purpose: the alternative is a rule that treats silence as a pass.
 */
function refreshCanary(projectDir, { event, sessionId, raw }) {
  const file = canaryPath(projectDir);
  const prior = core.io.readJSONClassified(file);
  const firstSeenAt = (prior.status === 'OK' && prior.doc && isNonEmptyString(prior.doc.firstSeenAt)) ? prior.doc.firstSeenAt : nowISO();
  const fireCount = (prior.status === 'OK' && prior.doc && Number.isFinite(prior.doc.fireCount)) ? prior.doc.fireCount + 1 : 1;
  const bounded = boundedRaw(raw === undefined ? null : raw);
  const doc = {
    schemaVersion: '1.0.0',
    kind: 'codex-hooks-activation-canary',
    event: event || null,
    at: nowISO(),
    session_id: sessionId || null,
    ran: true,
    outcome: core.failures.OUTCOME.PASS,
    firstSeenAt,
    fireCount,
    ...bounded,
  };
  // Best-effort: a canary that cannot write must not throw past its caller. The caller decides whether
  // that absence matters (it never blocks a decision — see the per-hook files).
  try { return core.io.writeAtomicJSON(file, doc); } catch (e) { return { ok: false, detail: String(e && e.message) }; }
}

function readCanaryDoc(projectDir) {
  const r = core.io.readJSONClassified(canaryPath(projectDir));
  if (r.status !== 'OK' || !r.doc) return { present: false, doc: null, status: r.status, detail: r.detail };
  return { present: true, doc: r.doc, status: 'OK', detail: null };
}

// --- the last-active pointer: written only by PreCompact, read only by SessionStart, so the identity
// check it enables compares against something NOT keyed by the very id it is verifying. -----------------
function writeLastActive(projectDir, { conversationId, handoffId }) {
  try {
    return core.io.writeAtomicJSON(lastActivePath(projectDir), {
      schemaVersion: '1.0.0', kind: 'codex-last-active-conversation',
      conversationId, handoffId, writtenAt: nowISO(),
    });
  } catch (e) { return { ok: false, detail: String(e && e.message) }; }
}

function readLastActive(projectDir) {
  const r = core.io.readJSONClassified(lastActivePath(projectDir));
  if (r.status !== 'OK' || !r.doc || !isNonEmptyString(r.doc.conversationId)) return null;
  return r.doc;
}

// --- the per-conversation "which handoff is current" pointer. Handoff ids are random (core.handoff.
// newHandoffId()); without this, SessionStart has no way to discover which document to consume. --------
function writeLatestHandoffPointer(dir, { handoffId, cycleIdAtWrite }) {
  try {
    return core.io.writeAtomicJSON(latestHandoffPointerPath(dir), {
      schemaVersion: '1.0.0', kind: 'codex-latest-handoff-pointer',
      handoffId, cycleIdAtWrite, writtenAt: nowISO(),
    });
  } catch (e) { return { ok: false, detail: String(e && e.message) }; }
}

function readLatestHandoffPointer(dir) {
  const r = core.io.readJSONClassified(latestHandoffPointerPath(dir));
  if (r.status !== 'OK' || !r.doc || !isNonEmptyString(r.doc.handoffId)) return null;
  return r.doc;
}

/**
 * The agent-authored savepoint note (deliverable 3's skill instructs writing this before /compact).
 * Read-only: sanitized against the handoff schema's actual constraints, but NOT deleted here. A note is
 * only truly "spent" once the handoff that carried it is written AND read back — see `clearPendingNote`,
 * called by the caller only on that success path. Deleting on READ (as an earlier draft of this module
 * did) would lose the operator's note forever the moment `handoff.writeVerified` failed for any reason,
 * which is exactly the situation a retry needs the note to still be there for.
 *
 * @returns {{present:boolean, fields:object, dropped:string[]}}
 */
const EMPTY_NOTE_FIELDS = Object.freeze({
  exactNextAction: null, atomicActionId: null,
  userConstraints: [], unresolvedQuestions: [], candidateMemories: [], verificationEvidence: [],
});

function peekPendingNote(projectDir) {
  const r = core.io.readJSONClassified(pendingNotePath(projectDir));
  // The absent/malformed case returns the SAME shape as the present case (every array present, not
  // omitted) so a caller never has to branch on `present` before reading a field — exactly the "every
  // list is present so a reader never has to distinguish [] from absent" discipline
  // core/state/handoff.js's own `build()` uses.
  if (r.status !== 'OK' || !r.doc) return { present: false, fields: { ...EMPTY_NOTE_FIELDS }, dropped: [] };

  const doc = r.doc;
  const dropped = [];
  const strOrNull = (k) => {
    if (doc[k] === undefined || doc[k] === null) return null;
    if (typeof doc[k] === 'string' && doc[k].length) return doc[k];
    dropped.push(k);
    return null;
  };
  const strArray = (k) => {
    if (doc[k] === undefined || doc[k] === null) return [];
    if (!Array.isArray(doc[k])) { dropped.push(k); return []; }
    const kept = doc[k].filter((x) => typeof x === 'string' && x.length);
    if (kept.length !== doc[k].length) dropped.push(`${k}[]`);
    return kept;
  };
  const anyArray = (k) => (Array.isArray(doc[k]) ? doc[k] : (doc[k] === undefined ? [] : (dropped.push(k), [])));

  const fields = {
    exactNextAction: strOrNull('exactNextAction'),
    atomicActionId: strOrNull('atomicActionId'),
    userConstraints: strArray('userConstraints'),
    unresolvedQuestions: strArray('unresolvedQuestions'),
    candidateMemories: strArray('candidateMemories'),
    verificationEvidence: anyArray('verificationEvidence'),
  };

  return { present: true, fields, dropped };
}

/** Best-effort consume-once, called ONLY after the handoff carrying this note's content was written and
 * read back successfully. An unlink failure just means the same note might be read again next time,
 * which is a staleness risk the next firing already flags via unresolvedQuestions — never a crash. */
function clearPendingNote(projectDir) {
  try { fs.unlinkSync(pendingNotePath(projectDir)); } catch { /* already gone, or unremovable; not fatal */ }
}

// --- append-only observational logs, the SAME discipline as core/lifecycle/journal.js's append-only
// design (each line complete before the next is written) but intentionally NOT the machine's own journal
// — these are corroboration a future supervisor may read, never a source the machine folds itself. -------
function appendMarker(file, record) {
  try { return core.io.appendLine(file, JSON.stringify({ at: nowISO(), ...record })); }
  catch (e) { return { ok: false, detail: String(e && e.message) }; }
}

module.exports = {
  HOST, core,
  conversationDir, RUNTIME_ROLLOVER_DIR,
  canaryPath, lastActivePath, pendingNotePath,
  latestHandoffPointerPath, postcompactLogPath, stopLogPath, escapeHatchLogPath,
  nowISO, readStdin, parseInput, isNonEmptyString, projectDirOf, sidOf, eventOf,
  emitAndExit, exitSilently, stderrLine, installSafetyNet,
  MAX_RAW_BYTES, boundedRaw,
  gitHead, gitUncommittedFiles,
  refreshCanary, readCanaryDoc,
  writeLastActive, readLastActive,
  writeLatestHandoffPointer, readLatestHandoffPointer,
  peekPendingNote, clearPendingNote,
  appendMarker,
};
