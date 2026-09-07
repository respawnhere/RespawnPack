/*
 * RespawnPack · kernel/lib/aar.js — the After Action Report, composed from records the pack already keeps.
 *
 * ⛔ THE CLASS THIS ANSWERS: OUTPUT SHAPED FOR A HUMAN'S ATTENTION (the class audit, Class C). The
 * pack accumulates a great deal of true machine state — a compiled projection, a commit history, a
 * savepoint receipt, an append-only candidate journal, a delegation archive — and asks a person to
 * reassemble it themselves every time they want to know what a phase actually did. The nearest thing
 * that existed was a hand-written dogfood field report. This verb composes the report instead, from
 * the records, and puts the bottom line first because a reader who stops after one paragraph must
 * still have the answer.
 *
 * ⭐ IT COMPOSES, IT DOES NOT CONCLUDE. Every number, every commit subject, every gate row and every
 * candidate here is copied out of something that was written down at the time by the thing that knew.
 * Nothing in this file evaluates a criterion, decides an outcome, or upgrades a lead into a fact:
 *
 *   · counts from a compiled STATE.json are WITHHELD, never caveated, when that state was not current
 *     for the revision it was committed at (anti-drift item 5). A number nobody can trust is not
 *     printed with a warning beside it; it is not printed;
 *   · a candidate memory is presented as an UNVERIFIED LEAD unless the audit journal records it
 *     promoted (anti-drift item 11). The report is a place a lead becomes visible, never a place it
 *     becomes true;
 *   · an input that could not be read produces a CANNOT_DETERMINE row that lands in the report's own
 *     owner-actions section, and the rest is still written. "The journal was corrupt" is a finding a
 *     reader needs; silently composing a shorter report around it is how a gap becomes invisible;
 *   · the machine-local records (the savepoint receipt, the delegation archive, task-attempt receipts)
 *     are labelled machine-local in the document, because they live under `.respawnpack/`, are
 *     gitignored, and describe THIS machine's runs. A reader on another clone has none of them and
 *     must not read their absence as "nothing happened".
 *
 * ⛔ AND IT CAN NEVER DECIDE WHETHER A GOAL CLOSED. `contract complete goal` calls `compose` AFTER the
 * closure has already succeeded, and a failed report write is reported as its own row rather than
 * folded into the closure's outcome (anti-drift item 9). A report is the last thing that may be
 * allowed to reverse a refusal or manufacture a completion.
 *
 * API: `compose(dir, {since, until, title, write}) → {outcome, checks, document, path, window}`.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { OUTCOME, result, rollup } = require('./outcome.js');
const stateLib = require('./state.js');
const render = require('./render.js');
const closeout = require('./closeout.js');
const modhealth = require('./modhealth.js');

/*
 * ⛔ THE THREE CROSS-TREE READS, THROUGH THE SAME PROBE EVERY OTHER KERNEL LIB USES. `hooks/` is the
 * one direction that resolves in BOTH layouts (`kernel/lib/x.js → ../../hooks/y.js` in the pack,
 * `.claude/respawnpack/lib/x.js → ../../hooks/y.js` once installed), and a module that will not load
 * has to be reportable rather than fatal — a broken dependency here is a row in this report and a row
 * in `doctor`, never a stack trace out of a verb (anti-drift item 17).
 */
const MANIFEST_PATH = path.resolve(__dirname, '..', '..', 'hooks', '_manifest.js');
const manifestHealth = modhealth.probePath(MANIFEST_PATH);
const manifest = manifestHealth.module;

const ARTIFACT_PATH = path.resolve(__dirname, '..', '..', 'hooks', '_artifact.js');
const artifactHealth = modhealth.probePath(ARTIFACT_PATH);
const artifact = artifactHealth.module;

const RUNTIME_PATH = path.resolve(__dirname, '..', '..', 'hooks', '_runtime.js');
const runtimeHealth = modhealth.probePath(RUNTIME_PATH);
const runtimeLib = runtimeHealth.module;

/** Where a written report lands. Tracked, beside the other derived documents a human reads. */
const AAR_DIR = path.join('docs', 'derived', 'aar');
const DERIVED_CHANGELOG_REL = path.join('docs', 'derived', 'CHANGELOG.md');
const CANDIDATE_AUDIT_REL = path.join('memory', 'candidates', 'audit.jsonl');
const TASK_ATTEMPT_DIR = path.join('.respawnpack', 'runtime');

/*
 * ⛔ THE SAME PHRASE core/memory/candidates.js EXPORTS AS `UNVERIFIED_MARKER`, AND NOT A SECOND
 * VOCABULARY FOR THE SAME WALL. It is spelled here rather than imported because `core/` is a separate
 * tree with its own dependency arrow and this file has no other reason to reach into it; the two
 * spellings are held equal by a fence in kernel/kernel.test.mjs that reads both from source, so a
 * rename in either place fails loudly instead of leaving one surface calling a lead a finding.
 */
const UNVERIFIED_MARKER = 'UNVERIFIED LEAD';

const posix = (p) => String(p).replace(/\\/g, '/');

// --- git, read-only ---------------------------------------------------------------------------
/*
 * Every git call in this file is a READ. Nothing here checks out, resets, stashes or writes a ref: a
 * report that could change the tree it describes would be a second thing to distrust.
 */
function gitOut(dir, args) {
  try { return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch { return null; }
}

const resolveRev = (dir, rev) => {
  const out = gitOut(dir, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]);
  const s = out && out.trim();
  return /^[0-9a-f]{40}$/.test(s || '') ? s : null;
};

/*
 * ⛔ THE WINDOW IS BOUNDED IN UTC, THE CLOCK EVERY OTHER RECORD THIS REPORT READS KEEPS. The first
 * version asked git for `--date=short`, which renders the committer's LOCAL calendar day, while the
 * candidate journal, the receipts and STATE.json all stamp `toISOString()`. From 20:00 in the
 * committer's zone the commit said "the 3rd" and every row captured that evening said "the 4th", so a
 * lead captured minutes before the savepoint fell outside the window that savepoint closed, and the
 * report called it "no candidate was captured". The committer instant (%ct, Unix seconds) has no
 * offset to disagree about; its UTC day is the day the rest of the pack already writes down.
 */
const revDate = (dir, rev) => {
  const out = gitOut(dir, ['show', '-s', '--format=%ct', rev]);
  const s = out && out.trim();
  if (!/^\d+$/.test(s || '')) return null;
  return new Date(Number(s) * 1000).toISOString().slice(0, 10);
};

function rootCommitOf(dir, rev) {
  const out = gitOut(dir, ['rev-list', '--max-parents=0', rev]);
  if (!out) return null;
  const lines = out.trim().split(/\r?\n/).filter(Boolean);
  // A repository grafted from several histories has more than one root; the LAST one listed is the
  // oldest ancestor of `rev`, which is the honest "the beginning" for a window that names no start.
  return lines.length ? lines[lines.length - 1] : null;
}

/** The commits in `(since, until]`, newest first. `since` null means "every ancestor of until". */
function commitsIn(dir, since, until) {
  const range = since ? `${since}..${until}` : until;
  const out = gitOut(dir, ['log', '--no-merges', '--format=%H%x1f%an%x1f%ad%x1f%s', '--date=short', range]);
  if (out === null) return null;
  return out.split(/\r?\n/).filter(Boolean).map((line) => {
    const [rev, author, date, subject] = line.split('\x1f');
    return { rev, author, date, subject: subject || '' };
  });
}

/*
 * ⛔ "IS THE STATE COMMITTED AT R CURRENT FOR R" IS A DIFFERENT QUESTION FROM THE ONE `stateFreshness`
 * ANSWERS, AND CONFLATING THEM WOULD BE A SECOND FRESHNESS READER.
 *
 * `kernel/respawnpack.js`'s `stateFreshness` is the one helper every reader shares for "is the
 * STATE.json on disk current for HEAD, right now" — revision equivalence AND the compiler-input
 * digests. It cannot be pointed at a past revision: the digests it compares are computed from the
 * WORKING TREE, and the working tree is not what a historical commit contained. So this asks the
 * narrower question the past can actually answer, and says which half it checked:
 *
 *   the STATE.json committed at R describes R when R reaches `state.sourceRevision` through commits
 *   that changed nothing but the savepoint's own outputs — the SAME equivalence hooks/_manifest.js
 *   defines once for everybody, reached here through its own `isSavepointOutput`, never re-spelled.
 *
 * When the walk cannot classify a commit (an unreadable object, a merge, a root), it stops and the
 * answer is "not established" — strict, never CURRENT by guess. When the answer is anything but
 * CURRENT, the report WITHHOLDS that end's counts rather than printing them with a caveat.
 */
function stateCurrentAt(dir, rev, state) {
  if (!manifest) return { current: false, why: `hooks/_manifest.js: ${manifestHealth.detail || manifestHealth.status} — the savepoint-only rule that decides this cannot be read` };
  if (!state || typeof state.sourceRevision !== 'string') return { current: false, why: 'the state committed there records no sourceRevision, so nothing says which source it describes' };
  if (state.sourceRevision === rev) return { current: true, why: `bound to ${rev.slice(0, 7)} itself` };

  let cur = rev;
  const hops = [];
  for (let step = 0; step < 40; step += 1) {
    const parents = (gitOut(dir, ['rev-list', '--parents', '-n', '1', cur]) || '').trim().split(/\s+/).slice(1).filter(Boolean);
    if (parents.length !== 1) {
      return { current: false, why: `the walk from ${rev.slice(0, 7)} reached ${parents.length ? 'a merge commit' : 'a root commit'} before it reached ${state.sourceRevision.slice(0, 7)}` };
    }
    const changed = (gitOut(dir, ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', cur]) || '').split('\0').filter(Boolean);
    const outside = changed.filter((p) => !manifest.isSavepointOutput(p));
    if (outside.length) {
      return { current: false, why: `${cur.slice(0, 7)} changed ${outside.slice(0, 3).join(', ')}${outside.length > 3 ? ` (+${outside.length - 3} more)` : ''}, which is source, so the state bound to ${state.sourceRevision.slice(0, 7)} does not describe ${rev.slice(0, 7)}` };
    }
    hops.push(cur);
    cur = parents[0];
    if (cur === state.sourceRevision) {
      return { current: true, why: `${rev.slice(0, 7)} differs from ${state.sourceRevision.slice(0, 7)} only by ${hops.length} savepoint-only commit${hops.length === 1 ? '' : 's'}` };
    }
  }
  return { current: false, why: `the savepoint-only walk from ${rev.slice(0, 7)} did not reach ${state.sourceRevision.slice(0, 7)} within 40 commits` };
}

/**
 * The compiled state as it stood AT a revision, read out of git rather than off disk.
 *
 * ⛔ NOT A RAW READ OF A PUBLISHED ARTIFACT. `git show <rev>:<path>` reads an immutable object out of
 * the object database. There is no atomic-replacement window to observe — the whole reason
 * `hooks/_artifact.js` exists — because nothing is replacing a committed blob. A non-zero exit means
 * the path did not exist at that revision, which is ABSENT and is a real answer about the project.
 */
function stateAt(dir, rev) {
  const raw = gitOut(dir, ['show', `${rev}:${posix(stateLib.STATE_FILE)}`]);
  if (raw === null) return { status: 'ABSENT', state: null, detail: `no ${posix(stateLib.STATE_FILE)} at ${rev.slice(0, 7)}` };
  try { return { status: 'OK', state: JSON.parse(raw), detail: null }; }
  catch (e) { return { status: 'MALFORMED', state: null, detail: `${posix(stateLib.STATE_FILE)} at ${rev.slice(0, 7)} is not parseable JSON (${e.message})` }; }
}

// --- the inputs that are not git ----------------------------------------------------------------

/*
 * ⛔ A PLAIN TEXT READ, DELIBERATELY, AND WHY IT NEEDS NO CLASSIFIED BOUNDARY. Both files below are
 * APPEND-ONLY (`core/_io.js` `appendLine` for the journal) or human-authored prose (the derived
 * changelog). Neither is published by tmp-then-rename, so neither has the replacement window that
 * `hooks/_artifact.js` retries around, and neither is JSON — `kernel/schema.test.mjs`'s raw-JSON sweep
 * is scoped to a `JSON.parse` of a `readFileSync`, which a JSONL journal can never be read with. The
 * three dispositions are still kept apart: ABSENT is a fact about the project, UNREADABLE is a fault
 * that becomes an owner action, and neither is ever collapsed into "there was nothing".
 */
function readTextOrStatus(abs) {
  try { return { status: 'OK', text: fs.readFileSync(abs, 'utf8'), detail: null }; }
  catch (e) {
    if (e && e.code === 'ENOENT') return { status: 'ABSENT', text: null, detail: 'not present' };
    return { status: 'UNREADABLE', text: null, detail: `${(e && e.code) || 'UNKNOWN'} — ${(e && e.message) || 'could not be read'}` };
  }
}

/** Candidate-journal rows whose `at` falls inside the window, plus the ids the journal records promoted. */
function candidateJournal(dir, fromISO, toISO) {
  const r = readTextOrStatus(path.join(dir, CANDIDATE_AUDIT_REL));
  if (r.status !== 'OK') return { status: r.status, detail: r.detail, rows: [], promoted: new Set(), rejected: new Set(), malformedLines: 0 };
  const rows = [];
  const promoted = new Set();
  const rejected = new Set();
  let malformedLines = 0;
  for (const line of r.text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row = null;
    try { row = JSON.parse(line); } catch { malformedLines += 1; continue; }
    if (!row || typeof row !== 'object' || typeof row.at !== 'string') { malformedLines += 1; continue; }
    // The lifetime markers are read from the WHOLE journal, not only from inside the window: a
    // candidate captured in this phase and promoted in the next one is still a lead as of this report,
    // and one promoted before the window opened is not turned back into a lead by the window's edges.
    if (row.action === 'promote') promoted.add(row.id);
    if (row.action === 'reject') rejected.add(row.id);
    if (fromISO && row.at < fromISO) continue;
    if (toISO && row.at > toISO) continue;
    rows.push(row);
  }
  return { status: 'OK', detail: null, rows, promoted, rejected, malformedLines };
}

/** The claim text behind a candidate id, through the classified boundary the rest of the kernel uses. */
function candidateClaim(dir, id) {
  if (!artifact || typeof id !== 'string' || !/^[\w.-]+$/.test(id)) return null;
  const r = artifact.readJSONClassified(path.join(dir, 'memory', 'candidates', `${id}.json`));
  return r.status === 'OK' && r.doc && typeof r.doc.claim === 'string' ? r.doc.claim : null;
}

/** Derived-changelog entries whose `## ` heading carries a date inside the window. */
function changelogEntries(dir, fromDate, toDate) {
  const r = readTextOrStatus(path.join(dir, DERIVED_CHANGELOG_REL));
  if (r.status !== 'OK') return { status: r.status, detail: r.detail, entries: [] };
  const entries = [];
  for (const line of r.text.split(/\r?\n/)) {
    const m = /^##\s+(.*)$/.exec(line);
    if (!m) continue;
    const d = /(\d{4}-\d{2}-\d{2})/.exec(m[1]);
    if (!d) continue;
    if (fromDate && d[1] < fromDate) continue;
    if (toDate && d[1] > toDate) continue;
    entries.push({ date: d[1], heading: m[1].trim() });
  }
  return { status: 'OK', detail: null, entries };
}

/** Task-attempt receipts this machine holds. Never installed into a target; present only where the runner ran. */
function taskAttempts(dir) {
  let names = [];
  try { names = fs.readdirSync(path.join(dir, TASK_ATTEMPT_DIR)); }
  catch (e) {
    if (e && e.code === 'ENOENT') return { status: 'ABSENT', detail: 'no runtime directory on this machine', files: [] };
    return { status: 'UNREADABLE', detail: `${(e && e.code) || 'UNKNOWN'} — ${(e && e.message) || 'could not be listed'}`, files: [] };
  }
  return { status: 'OK', detail: null, files: names.filter((n) => /^task-attempt-.*\.json$/.test(n)).sort() };
}

// --- the window -----------------------------------------------------------------------------------

/** The `until` revision the newest already-written report recorded, so a second report starts where the first stopped. */
function lastReportUntil(dir) {
  let names = [];
  try { names = fs.readdirSync(path.join(dir, AAR_DIR)); }
  catch { return null; }
  // Reports are named `<until-date>-<slug>.md`, so a descending lexical sort puts the most recent
  // window first. The first file that carries a parseable marker wins; a report somebody hand-mangled
  // past recognition is skipped rather than allowed to silence the default.
  for (const name of names.filter((n) => n.endsWith('.md')).sort().reverse()) {
    const r = readTextOrStatus(path.join(dir, AAR_DIR, name));
    if (r.status !== 'OK') continue;
    const m = /^- \*\*Window until:\*\* `([0-9a-f]{40})`/m.exec(r.text);
    if (m) return { rev: m[1], file: posix(path.join(AAR_DIR, name)) };
  }
  return null;
}

/*
 * EVERY DEFAULT IS STATED IN THE DOCUMENT, which is the point of recording `source` beside each end.
 * A reader who disagrees with a window has to be able to see which rule chose it without re-running
 * anything, and a window nobody can explain is a report about an unknown period.
 */
function resolveWindow(dir, { since = null, until = null } = {}) {
  const untilRev = until ? resolveRev(dir, until) : resolveRev(dir, 'HEAD');
  if (!untilRev) {
    return { ok: false, detail: until ? `--until "${until}" does not resolve to a commit in this repository` : 'no HEAD to end the window at — not a git repository, or no commits yet' };
  }
  const untilSource = until ? `named by --until "${until}"` : 'HEAD, because --until was not given';

  if (since) {
    const rev = resolveRev(dir, since);
    if (!rev) return { ok: false, detail: `--since "${since}" does not resolve to a commit in this repository` };
    return { ok: true, since: rev, until: untilRev, sinceSource: `named by --since "${since}"`, untilSource };
  }

  const last = lastReportUntil(dir);
  if (last) {
    return { ok: true, since: last.rev, until: untilRev, sinceSource: `the \`until\` revision recorded by the newest existing report, ${last.file}`, untilSource };
  }

  // No prior report: start where the current savepoint-only chain does. HEAD sitting on top of one or
  // more savepoint commits means the work those docs describe is the last thing that happened, and its
  // base is the honest opening of the window.
  if (manifest) {
    let revs = null;
    try { revs = manifest.sourceRevisions(dir); } catch { revs = null; }
    if (revs && revs.effective && revs.savepointOnly && revs.savepointOnly.length) {
      return { ok: true, since: revs.effective, until: untilRev, sinceSource: `the base of the current savepoint-only commit chain (${revs.detail})`, untilSource };
    }
  }

  const root = rootCommitOf(dir, untilRev);
  if (root) return { ok: true, since: root, until: untilRev, sinceSource: 'the root commit, because no earlier report and no savepoint-only chain named a start', untilSource };
  return { ok: true, since: null, until: untilRev, sinceSource: 'unbounded — no root commit could be resolved, so the window is every ancestor of the end', untilSource };
}

// --- the document ---------------------------------------------------------------------------------

const CONVENTIONAL = /^([a-z]{2,10})(\([^)]*\))?!?:\s/;

function groupBySubjectPrefix(commits) {
  const groups = new Map();
  for (const c of commits) {
    const m = CONVENTIONAL.exec(c.subject);
    const key = m ? m[1] : null;
    const bucket = key || '(no conventional prefix)';
    if (!groups.has(bucket)) groups.set(bucket, []);
    groups.get(bucket).push(c);
  }
  // Prefixed groups first, alphabetically; the unprefixed remainder last, because it is a remainder.
  return [...groups.entries()].sort((a, b) => {
    if (a[0] === '(no conventional prefix)') return 1;
    if (b[0] === '(no conventional prefix)') return -1;
    return a[0].localeCompare(b[0]);
  });
}

const slugify = (title) => (String(title || '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 48)
  .replace(/-+$/, '')) || 'after-action-report';

/** The one-paragraph bottom line: what was attempted, how it went, and the one thing to know. */
function bottomLine({ title, ends, commits, candidates, receipt, ownerActions, blockers }) {
  const end = ends.end;
  const attempted = end.state && end.state.goal
    ? `The project goal on record at the end of this window is "${end.state.goal}"${end.state.milestone ? `, with the milestone "${end.state.milestone}"` : ''}.`
    : ends.start.state && ends.start.state.goal
      ? `No goal was on record at the end of this window; at its start the goal was "${ends.start.state.goal}".`
      : 'No project goal was on record at either end of this window, so this report describes work, not progress against a stated goal.';

  const outcome = commits === null
    ? 'The commits in the window could not be listed, so how much changed is not established here.'
    : `${commits.length} commit${commits.length === 1 ? '' : 's'} landed in the window.`;

  const closed = end.state && ends.start.state
    && Array.isArray(end.state.completedGoalIds) && Array.isArray(ends.start.state.completedGoalIds)
    && end.state.completedGoalIds.length > ends.start.state.completedGoalIds.length
    ? ` A goal was closed inside this window (${end.state.completedGoalIds.filter((g) => !ends.start.state.completedGoalIds.includes(g)).join(', ')}).`
    : '';

  const gate = receipt
    ? ` The last savepoint this machine recorded ended ${receipt.outcome || 'with no recorded outcome'} at exit ${receipt.exitCode}.`
    : '';

  const one = ownerActions.length
    ? `The one thing to know: ${ownerActions.length} input${ownerActions.length === 1 ? '' : 's'} could not be read while composing this report, so the sections below are incomplete in ${ownerActions.length === 1 ? 'one named place' : 'the named places'} — see "Owner actions".`
    : blockers === null
      ? (ends.end.status === 'ABSENT'
        ? 'The one thing to know: no compiled state was committed at the end of this window, so nothing here claims an open blocker in either direction.'
        : `The one thing to know: the state committed at the end of this window cannot be trusted for that revision (${ends.end.why}), so its counts and its blockers are withheld.`)
      : blockers.length
        ? `The one thing to know: ${blockers.length} requirement${blockers.length === 1 ? ' is' : 's are'} blocked and nothing downstream of ${blockers.length === 1 ? 'it' : 'them'} can proceed.`
        : candidates.length
          ? `The one thing to know: ${candidates.length} candidate memor${candidates.length === 1 ? 'y is' : 'ies are'} waiting on a human review, and every one of them is an ${UNVERIFIED_MARKER} until somebody promotes it with evidence.`
          : 'The one thing to know: nothing in this window is waiting on a decision from you.';

  return `This report covers "${title}". ${attempted} ${outcome}${closed}${gate} ${one}`;
}

function composeDocument(ctx) {
  const {
    title, window: win, ends, commits, changelog, receipt, candidates, journal,
    delegations, attempts, blockers, ownerActions, generatedAt,
  } = ctx;
  const L = [];

  L.push('> ⚙️ **DERIVED — do not hand-edit the generated block.** Composed by `respawnpack aar` from records');
  L.push('> this project already keeps: the compiled state at each end of the window, the commits, the derived');
  L.push('> changelog, and (where this machine has them) the savepoint receipt, the candidate journal and the');
  L.push('> delegation archive. Write your own reading in the NOTE block at the foot; that block is yours.');
  L.push('');
  L.push(`# After Action Report — ${title}`);
  L.push('');
  L.push(`_Generated ${generatedAt}._`);
  L.push('');
  L.push(render.GEN_OPEN);
  L.push('');

  // --- BLUF, first, always ------------------------------------------------------------------------
  L.push('## Bottom line');
  L.push('');
  L.push(bottomLine({ title, ends, commits, candidates, receipt, ownerActions, blockers }));
  L.push('');

  // --- the window and how it was chosen -----------------------------------------------------------
  L.push('## The window');
  L.push('');
  L.push(`- **Window since:** \`${win.since || 'none'}\` — ${win.sinceSource}`);
  L.push(`- **Window until:** \`${win.until}\` — ${win.untilSource}`);
  L.push(`- **Dates:** ${win.sinceDate || 'unknown'} to ${win.untilDate || 'unknown'} (committer dates, UTC — the clock the journal and the receipts keep)`);
  L.push('- The window is the commits AFTER `since` up to and including `until`. `since` itself is the');
  L.push('  starting point this report compares against, not part of what happened in it.');
  L.push('');

  // --- goal and milestone at both ends ------------------------------------------------------------
  L.push('## Goal and milestone, at each end of the window');
  L.push('');
  // The rule is stated in lower case on purpose: the upper-case word is reserved for an ACTUAL
  // withholding below, so a reader (and a fence) can find one by searching for it.
  L.push('Counts appear only where the `STATE.json` committed at that revision describes that revision —');
  L.push('its own `sourceRevision` reached through savepoint-only commits and nothing else. Where it does');
  L.push('not, the counts are withheld rather than shown with a warning. This check is the revision half');
  L.push('of freshness; the compiler-input digests need the working tree and are checked by `savepoint`.');
  L.push('');
  for (const key of ['start', 'end']) {
    const e = ends[key];
    L.push(`### ${key === 'start' ? 'Start' : 'End'} — \`${e.rev ? e.rev.slice(0, 12) : 'none'}\``);
    L.push('');
    if (!e.state) {
      // ABSENT is a fact about the project, not a withholding: nothing was hidden because nothing was
      // recorded. Anything else is a state that EXISTS and cannot be trusted, which is a withholding.
      L.push(e.status === 'ABSENT' ? `- No compiled state was committed here: ${e.why}` : `- WITHHELD: ${e.why}`);
      L.push('');
      continue;
    }
    L.push(`- **Project goal:** ${e.state.goal || '_none recorded_'} — ${e.state.goalComplete ? 'complete' : 'not complete'}`);
    L.push(`- **Active milestone:** ${e.state.milestone || '_none recorded_'} — ${e.state.milestoneComplete ? 'complete' : 'not complete'}`);
    if (e.current) {
      const c = e.state.counts || {};
      L.push(`- ${c.mandatory} mandatory requirements, of which ${c.conformant} conformant`);
      L.push(`- ${c.candidate} candidate, ${c.unevidenced} unevidenced, ${c.waived} waived, ${c.blocked} blocked`);
      L.push(`- ${(e.state.openP0P1 || []).length} open p0/p1`);
      L.push(`- _(current: ${e.why})_`);
    } else {
      L.push(`- **Counts WITHHELD.** ${e.why}`);
    }
    L.push('');
  }

  // --- commits ------------------------------------------------------------------------------------
  L.push('## Commits in the window');
  L.push('');
  if (commits === null) {
    L.push('- WITHHELD: the commit log for this window could not be read.');
  } else if (!commits.length) {
    L.push('- No commits landed in this window.');
  } else {
    for (const [prefix, rows] of groupBySubjectPrefix(commits)) {
      L.push(`**${prefix}** (${rows.length})`);
      L.push('');
      for (const c of rows) L.push(`- \`${c.rev.slice(0, 7)}\` ${c.subject} — ${c.author}, ${c.date}`);
      L.push('');
    }
  }
  L.push('');

  // --- derived changelog --------------------------------------------------------------------------
  L.push('## Derived changelog entries dated inside the window');
  L.push('');
  if (changelog.status === 'ABSENT') L.push(`- This project keeps no \`${posix(DERIVED_CHANGELOG_REL)}\`.`);
  else if (changelog.status !== 'OK') L.push(`- WITHHELD: \`${posix(DERIVED_CHANGELOG_REL)}\` ${changelog.detail}.`);
  else if (!changelog.entries.length) L.push('- No changelog heading carries a date inside this window.');
  else for (const e of changelog.entries) L.push(`- ${e.heading}`);
  L.push('');

  // --- the savepoint receipt ----------------------------------------------------------------------
  L.push('## Gate rows of the last savepoint (machine-local)');
  L.push('');
  L.push('⛔ Machine-local: this record lives under `.respawnpack/`, is gitignored, and describes runs on');
  L.push('THIS machine. Its absence on another clone is not evidence that nothing ran.');
  L.push('');
  if (!receipt) {
    L.push('- No savepoint receipt on this machine.');
  } else {
    L.push(`- **Outcome:** ${receipt.outcome || 'not recorded'} at exit ${receipt.exitCode}, recorded ${receipt.at || 'at an unrecorded time'}`);
    L.push(`- **Source revision it verified:** \`${receipt.sourceRevision || 'unrecorded'}\``);
    if (!receipt.blockers.length) L.push('- No blocking rows were recorded by that run.');
    else for (const b of receipt.blockers) L.push(`- ${typeof b === 'string' ? b : JSON.stringify(b)}`);
  }
  L.push('');

  // --- candidates ---------------------------------------------------------------------------------
  L.push('## Candidate memories captured, promoted and rejected in the window');
  L.push('');
  L.push(`⛔ A candidate is an **${UNVERIFIED_MARKER}** until somebody promotes it with stated evidence.`);
  L.push('Nothing in this report promotes anything, and reading a lead here does not make it project truth.');
  L.push('');
  if (journal.status === 'ABSENT') {
    L.push(`- This project keeps no \`${posix(CANDIDATE_AUDIT_REL)}\`, so nothing was captured through it.`);
  } else if (journal.status !== 'OK') {
    L.push(`- WITHHELD: \`${posix(CANDIDATE_AUDIT_REL)}\` ${journal.detail}.`);
  } else if (!candidates.length) {
    L.push('- No candidate was captured, promoted or rejected inside this window.');
  } else {
    for (const c of candidates) {
      const mark = c.promoted ? 'PROMOTED' : c.rejected ? 'REJECTED' : UNVERIFIED_MARKER;
      L.push(`- **${mark}** · \`${c.id}\` · ${c.action} at ${c.at}${c.klass ? ` · ${c.klass}` : ''}`);
      if (c.claim) L.push(`  - ${c.claim}`);
    }
    L.push('');
    L.push('Review them with `respawnpack memory candidates`; promotion needs `--verified-by`.');
  }
  L.push('');

  // --- delegations and task attempts --------------------------------------------------------------
  L.push('## Delegations and task attempts (machine-local)');
  L.push('');
  if (delegations.status !== 'OK') {
    L.push(`- WITHHELD: the delegation archive ${delegations.detail || 'could not be read'}.`);
  } else if (!delegations.history.length) {
    L.push('- No delegation has been closed on this machine.');
  } else {
    for (const d of delegations.history.slice(-10)) {
      L.push(`- \`${d.closedAt || 'unrecorded'}\` ${d.task || '(no task recorded)'} — ${(d.met || []).length} criterion attestation(s), which is a claim and not a proof`);
    }
  }
  if (attempts.status === 'OK' && attempts.files.length) {
    L.push(`- ${attempts.files.length} task-attempt receipt(s) on this machine: ${attempts.files.join(', ')}`);
  } else if (attempts.status === 'UNREADABLE') {
    L.push(`- WITHHELD: the runtime directory ${attempts.detail}.`);
  } else {
    L.push('- No task-attempt receipt on this machine.');
  }
  L.push('');

  // --- blockers -----------------------------------------------------------------------------------
  L.push('## Open blockers at the end of the window');
  L.push('');
  if (blockers === null) L.push(`- WITHHELD: ${ends.end.why}`);
  else if (!blockers.length) L.push('- Nothing is recorded as blocked.');
  else for (const b of blockers) L.push(`- \`${b.id}\` blocked by ${(b.blockedBy || []).join(', ') || 'an unrecorded dependency'}${b.missingAuthority ? ` · missing authority: ${b.missingAuthority}` : ''}`);
  L.push('');

  // --- owner actions ------------------------------------------------------------------------------
  L.push('## Owner actions');
  L.push('');
  if (!ownerActions.length) {
    L.push('- Every input this report reads was readable. Nothing here is waiting on you.');
  } else {
    L.push('Each row below is an input this composition could not read or could not trust. The rest of the');
    L.push('report was written anyway, and these are what it is missing.');
    L.push('');
    for (const r of ownerActions) L.push(`- **${r.check}** — ${r.detail}`);
  }
  L.push('');

  L.push(render.GEN_CLOSE);
  L.push('');
  L.push(render.NOTE_OPEN);
  L.push('_(no human note yet — write your own reading of this window here; regeneration preserves it)_');
  L.push(render.NOTE_CLOSE);
  L.push('');
  return L.join('\n');
}

// --- the composition ------------------------------------------------------------------------------

/**
 * Compose an After Action Report for a window, and optionally write it.
 *
 * @returns {{outcome, checks, document: string|null, path: string|null, window: object, wrote: string|null}}
 */
function compose(dir, { since = null, until = null, title = null, write = false } = {}) {
  const checks = [];
  const generatedAt = new Date().toISOString();

  const win = resolveWindow(dir, { since, until });
  if (!win.ok) {
    checks.push(result(OUTCOME.CANNOT_DETERMINE, 'aar:window', `${win.detail}. Nothing was composed: a report about an unknown period is not a report.`, { checked: 0, subject: 'git' }));
    return { outcome: rollup(checks), checks, document: null, path: null, window: null, wrote: null };
  }
  checks.push(result(OUTCOME.PASS, 'aar:window', `${win.since ? `${win.since.slice(0, 7)}..` : 'the whole history up to '}${win.until.slice(0, 7)} — since: ${win.sinceSource}; until: ${win.untilSource}`, { checked: win.since ? 2 : 1, subject: 'git' }));

  const sinceDate = win.since ? revDate(dir, win.since) : null;
  const untilDate = revDate(dir, win.until);
  const windowOut = { since: win.since, until: win.until, sinceDate, untilDate, sinceSource: win.sinceSource, untilSource: win.untilSource };

  // --- the two ends -------------------------------------------------------------------------------
  const ends = {};
  for (const [key, rev] of [['start', win.since], ['end', win.until]]) {
    if (!rev) {
      ends[key] = { rev: null, state: null, status: 'ABSENT', current: false, why: 'the window has no start revision, so there is no state to compare against' };
      checks.push(result(OUTCOME.NOT_APPLICABLE, `aar:state:${key}`, ends[key].why, { checked: 0, subject: posix(stateLib.STATE_FILE) }));
      continue;
    }
    const read = stateAt(dir, rev);
    if (read.status === 'ABSENT') {
      ends[key] = { rev, state: null, status: 'ABSENT', current: false, why: `${read.detail} — this project kept no compiled state there` };
      checks.push(result(OUTCOME.NOT_APPLICABLE, `aar:state:${key}`, ends[key].why, { checked: 0, subject: posix(stateLib.STATE_FILE) }));
      continue;
    }
    if (read.status !== 'OK') {
      ends[key] = { rev, state: null, status: read.status, current: false, why: read.detail };
      checks.push(result(OUTCOME.CANNOT_DETERMINE, `aar:state:${key}`, `${read.detail}. The ${key} of this window is reported without counts.`, { checked: 0, subject: posix(stateLib.STATE_FILE) }));
      continue;
    }
    const fresh = stateCurrentAt(dir, rev, read.state);
    ends[key] = { rev, state: read.state, status: fresh.current ? 'CURRENT' : 'STALE', current: fresh.current, why: fresh.why };
    checks.push(fresh.current
      ? result(OUTCOME.PASS, `aar:state:${key}`, `the state committed at ${rev.slice(0, 7)} describes it: ${fresh.why}`, { checked: 1, subject: posix(stateLib.STATE_FILE) })
      : result(OUTCOME.CANNOT_DETERMINE, `aar:state:${key}`, `counts WITHHELD for the ${key} of the window: ${fresh.why}`, { checked: 0, subject: posix(stateLib.STATE_FILE) }));
  }

  // --- commits ------------------------------------------------------------------------------------
  const commits = commitsIn(dir, win.since, win.until);
  if (commits === null) checks.push(result(OUTCOME.CANNOT_DETERMINE, 'aar:commits', 'the commit log for this window could not be read', { checked: 0, subject: 'git log' }));
  else if (!commits.length) checks.push(result(OUTCOME.NOT_APPLICABLE, 'aar:commits', 'no commits landed in this window', { checked: 0, subject: 'git log' }));
  else checks.push(result(OUTCOME.PASS, 'aar:commits', `${commits.length} commit(s) in the window`, { checked: commits.length, subject: 'git log' }));

  // --- the derived changelog ----------------------------------------------------------------------
  const changelog = changelogEntries(dir, sinceDate, untilDate);
  if (changelog.status === 'ABSENT') checks.push(result(OUTCOME.NOT_APPLICABLE, 'aar:changelog', `this project keeps no ${posix(DERIVED_CHANGELOG_REL)}`, { checked: 0, subject: posix(DERIVED_CHANGELOG_REL) }));
  else if (changelog.status !== 'OK') checks.push(result(OUTCOME.CANNOT_DETERMINE, 'aar:changelog', `${posix(DERIVED_CHANGELOG_REL)} ${changelog.detail}`, { checked: 0, subject: posix(DERIVED_CHANGELOG_REL) }));
  else if (!changelog.entries.length) checks.push(result(OUTCOME.NOT_APPLICABLE, 'aar:changelog', 'no changelog heading carries a date inside this window', { checked: 0, subject: posix(DERIVED_CHANGELOG_REL) }));
  else checks.push(result(OUTCOME.PASS, 'aar:changelog', `${changelog.entries.length} changelog entr(ies) dated inside the window`, { checked: changelog.entries.length, subject: posix(DERIVED_CHANGELOG_REL) }));

  // --- the savepoint receipt ----------------------------------------------------------------------
  let receipt = null;
  if (!runtimeLib) {
    checks.push(result(OUTCOME.CANNOT_DETERMINE, 'aar:gates', `hooks/_runtime.js: ${runtimeHealth.detail || runtimeHealth.status} — the savepoint receipt cannot be read through its own boundary`, { checked: 0, subject: 'savepoint-attempt.json' }));
  } else {
    try { receipt = runtimeLib.readSavepointAttempt(dir); } catch { receipt = null; }
    checks.push(receipt
      ? result(OUTCOME.PASS, 'aar:gates', `the last savepoint on this machine ended ${receipt.outcome || 'with no recorded outcome'} at exit ${receipt.exitCode} (machine-local)`, { checked: 1, subject: 'savepoint-attempt.json' })
      : result(OUTCOME.NOT_APPLICABLE, 'aar:gates', 'no savepoint receipt on this machine (machine-local; its absence on another clone proves nothing)', { checked: 0, subject: 'savepoint-attempt.json' }));
  }

  // --- candidates ---------------------------------------------------------------------------------
  const fromISO = sinceDate ? `${sinceDate}T00:00:00.000Z` : null;
  const toISO = untilDate ? `${untilDate}T23:59:59.999Z` : null;
  const journal = candidateJournal(dir, fromISO, toISO);
  const candidates = journal.rows.map((r) => ({
    id: r.id, action: r.action, at: r.at, klass: r.klass || null,
    promoted: journal.promoted.has(r.id), rejected: journal.rejected.has(r.id),
    claim: candidateClaim(dir, r.id),
  }));
  if (journal.status === 'ABSENT') checks.push(result(OUTCOME.NOT_APPLICABLE, 'aar:candidates', `this project keeps no ${posix(CANDIDATE_AUDIT_REL)}`, { checked: 0, subject: posix(CANDIDATE_AUDIT_REL) }));
  else if (journal.status !== 'OK') checks.push(result(OUTCOME.CANNOT_DETERMINE, 'aar:candidates', `${posix(CANDIDATE_AUDIT_REL)} ${journal.detail} — no candidate activity is claimed either way`, { checked: 0, subject: posix(CANDIDATE_AUDIT_REL) }));
  else if (journal.malformedLines) checks.push(result(OUTCOME.CANNOT_DETERMINE, 'aar:candidates', `${journal.malformedLines} line(s) of ${posix(CANDIDATE_AUDIT_REL)} could not be parsed, so the ${candidates.length} row(s) listed are a lower bound`, { checked: candidates.length, subject: posix(CANDIDATE_AUDIT_REL) }));
  else if (!candidates.length) checks.push(result(OUTCOME.NOT_APPLICABLE, 'aar:candidates', 'no candidate was captured, promoted or rejected inside this window', { checked: 0, subject: posix(CANDIDATE_AUDIT_REL) }));
  else checks.push(result(OUTCOME.PASS, 'aar:candidates', `${candidates.length} candidate journal row(s) inside the window, each an ${UNVERIFIED_MARKER} unless the journal records it promoted`, { checked: candidates.length, subject: posix(CANDIDATE_AUDIT_REL) }));

  // --- delegations and task attempts --------------------------------------------------------------
  let delegations = { status: 'CANNOT_DETERMINE', history: [], detail: 'the closeout subsystem could not be reached' };
  try { delegations = closeout.readDelegationArchive(dir); } catch (e) { delegations = { status: 'UNREADABLE', history: [], detail: (e && e.message) || 'threw while reading' }; }
  if (delegations.status !== 'OK') checks.push(result(OUTCOME.CANNOT_DETERMINE, 'aar:delegations', `the delegation archive ${delegations.detail || 'could not be read'} (machine-local)`, { checked: 0, subject: posix(closeout.DELEGATION_LOG_REL) }));
  else if (!(delegations.history || []).length) checks.push(result(OUTCOME.NOT_APPLICABLE, 'aar:delegations', 'no delegation has been closed on this machine (machine-local)', { checked: 0, subject: posix(closeout.DELEGATION_LOG_REL) }));
  else checks.push(result(OUTCOME.PASS, 'aar:delegations', `${delegations.history.length} closed delegation(s) archived on this machine (machine-local)`, { checked: delegations.history.length, subject: posix(closeout.DELEGATION_LOG_REL) }));

  const attempts = taskAttempts(dir);
  if (attempts.status === 'UNREADABLE') checks.push(result(OUTCOME.CANNOT_DETERMINE, 'aar:task-attempts', `the runtime directory ${attempts.detail} (machine-local)`, { checked: 0, subject: posix(TASK_ATTEMPT_DIR) }));
  else if (attempts.files.length) checks.push(result(OUTCOME.PASS, 'aar:task-attempts', `${attempts.files.length} task-attempt receipt(s) on this machine (machine-local)`, { checked: attempts.files.length, subject: posix(TASK_ATTEMPT_DIR) }));
  else checks.push(result(OUTCOME.NOT_APPLICABLE, 'aar:task-attempts', 'no task-attempt receipt on this machine (machine-local)', { checked: 0, subject: posix(TASK_ATTEMPT_DIR) }));

  // --- blockers, from the END state and only when that state may be trusted -----------------------
  const blockers = ends.end.state && ends.end.current ? (ends.end.state.blockers || []) : null;

  /*
   * ⛔ OWNER ACTIONS ARE THE COMPOSITION'S OWN UNDETERMINED ROWS, GATHERED BEFORE THE DOCUMENT IS
   * WRITTEN SO THEY LAND INSIDE IT. A report that quietly composed around a corrupt journal would be
   * shorter and wrong in exactly the way nobody could see.
   */
  const ownerActions = checks.filter((c) => c.outcome === OUTCOME.CANNOT_DETERMINE);

  const resolvedTitle = title
    || (ends.end.state && ends.end.state.goal)
    || (ends.start.state && ends.start.state.goal)
    || `Window ${sinceDate || 'start'} to ${untilDate || 'end'}`;

  const document = composeDocument({
    title: resolvedTitle, window: windowOut, ends, commits, changelog, receipt,
    candidates, journal, delegations, attempts, blockers, ownerActions, generatedAt,
  });

  const rel = path.join(AAR_DIR, `${untilDate || generatedAt.slice(0, 10)}-${slugify(resolvedTitle)}.md`);
  const abs = path.join(dir, rel);

  let wrote = null;
  if (write) {
    /*
     * ⛔ A REPORT IS NEVER OVERWRITTEN, AND THE REFUSAL NAMES THE FILE. An After Action Report is a
     * record of what was known at a moment; regenerating one in place would silently replace a
     * human's NOTE and a colleague's citation with a second opinion about the same window. Refuse,
     * name the file, and let the caller choose a different window or a different title.
     */
    if (fs.existsSync(abs)) {
      checks.push(result(OUTCOME.CANNOT_DETERMINE, 'aar:write',
        `${posix(rel)} already exists and this verb never overwrites a report. Nothing was written. `
        + 'Pick a different --title, a different window, or move the existing report aside deliberately.',
        { checked: 0, subject: posix(rel) }));
    } else {
      try {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        stateLib.writeAtomic(abs, document);
        wrote = posix(rel);
        checks.push(result(OUTCOME.PASS, 'aar:write', `wrote ${posix(rel)}`, { checked: 1, subject: posix(rel) }));
      } catch (e) {
        checks.push(result(OUTCOME.CANNOT_DETERMINE, 'aar:write', `${posix(rel)} could not be written: ${(e && e.message) || e}`, { checked: 0, subject: posix(rel) }));
      }
    }
  }

  return { outcome: rollup(checks), checks, document, path: posix(rel), window: windowOut, wrote };
}

module.exports = { compose };
