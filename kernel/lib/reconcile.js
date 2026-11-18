/*
 * RespawnPack · kernel/lib/reconcile.js — DF-005: the task list and the project's own records.
 *
 * ⛔ THE FINDING, IN ITS OWN WORDS. "The harness task list and the project's gap/gate records drift
 * independently, wrong in BOTH directions at once." Not one list lagging behind another — two lists
 * each containing things the other has never heard of, while every surface that reads either one
 * reports confidently. A session closes a task that no gap ever tracked; a gap sits open with no task
 * pointing at it; and both are invisible because nothing has ever compared them.
 *
 * ⛔ WHAT THIS DELIBERATELY DOES NOT DO: parse prose. An earlier instinct here is to scan markdown for
 * checkboxes and headings, which is DF-007's error with extra steps — asserting over the RENDERED
 * SURFACE of a claim instead of its structure. A heading that says "done" is not a record. So both
 * sides must be STRUCTURED, and a project that has no structured task source gets NOT_CONFIGURED,
 * which is a real answer and not a failure.
 *
 * ⛔ AND THE GENERIC PACK OWNS NO TASK SYSTEM. It owns the INVOCATION and the OUTCOME SEMANTICS; the
 * project owns its native format, through the same adapter philosophy the validators already use. No
 * path belonging to any particular project appears in this file, and a fence in the suite checks that.
 *
 * ⭐ THE RULE THAT OUTRANKS EVERY OTHER ONE HERE: reading zero task records, or zero project records,
 * can never be spelled PASS. "I compared nothing and found no disagreement" is the exact shape of
 * every silent-green defect this program exists to end.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { OUTCOME, result } = require('./outcome.js');
const assertLib = require('./assert.js');

const SCHEMA_VERSION = '1.0.0';
const CONFIG_KEY = 'reconcile';

/** The eight drift classes, named so a report can say WHICH disagreement it found. */
const DRIFT = {
  TASK_WITHOUT_PROJECT_RECORD: 'a task exists with no corresponding project gap/gate/requirement',
  PROJECT_RECORD_WITHOUT_TASK: 'a project record exists with no corresponding task',
  STATUS_CONFLICT: 'the same identifier is open on one side and closed on the other',
  DUPLICATE_ID: 'an identifier appears more than once within one source',
  SOURCE_UNREADABLE: 'a declared source could not be read or interpreted',
  ZERO_RECORDS: 'a declared source parsed to zero records',
  UNSUPPORTED_SCHEMA_VERSION: 'a source declares a schemaVersion this kernel does not support',
  EXCLUDED_ID: 'an identifier the project has explicitly declared out of scope',
};

/*
 * Status vocabulary. A project's own words are its own — `done`, `resolved`, `wontfix`, `Closed` — so
 * the mapping is declarable. What is NOT declarable is the default for an unrecognised word: an
 * unmapped status makes that record UNDETERMINED and drags the verdict to CANNOT_DETERMINE. Guessing
 * "probably open" would let a typo silently close a gap, which is the failure direction that costs.
 */
const DEFAULT_OPEN = ['open', 'todo', 'in_progress', 'in-progress', 'doing', 'blocked', 'pending'];
const DEFAULT_CLOSED = ['closed', 'done', 'complete', 'completed', 'resolved', 'fixed', 'wontfix', 'waived'];

function normalizeStatus(raw, cfg) {
  const s = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!s) return null;
  const open = new Set([...(cfg.openStatuses || DEFAULT_OPEN)].map((x) => String(x).toLowerCase()));
  const closed = new Set([...(cfg.closedStatuses || DEFAULT_CLOSED)].map((x) => String(x).toLowerCase()));
  if (open.has(s)) return 'open';
  if (closed.has(s)) return 'closed';
  return null; // ⛔ deliberately not a guess
}

const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const posix = (p) => String(p).replace(/\\/g, '/');
const portableAbsolute = (p) => path.isAbsolute(p) || /^[A-Za-z]:[\\/]/.test(p) || /^[\\/]/.test(p);
const inside = (root, candidate) => {
  const rel = path.relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
};

function containedResolution(projectDir, candidate) {
  const project = path.resolve(projectDir);
  const abs = path.resolve(candidate);
  if (!inside(project, abs)) return { ok: false, kind: 'lexical' };
  let realProject;
  try { realProject = fs.realpathSync(project); }
  catch (e) { return { ok: false, kind: 'unresolved', error: e }; }
  let probe = abs;
  for (;;) {
    try { fs.lstatSync(probe); break; }
    catch (e) {
      if (!e || e.code !== 'ENOENT') return { ok: false, kind: 'unresolved', error: e };
      const parent = path.dirname(probe);
      if (parent === probe) return { ok: false, kind: 'unresolved', error: e };
      probe = parent;
    }
  }
  let realProbe;
  try { realProbe = fs.realpathSync(probe); }
  catch (e) { return { ok: false, kind: 'unresolved', error: e }; }
  const realCandidate = path.resolve(realProbe, path.relative(probe, abs));
  if (!inside(realProject, realCandidate)) return { ok: false, kind: 'symlink' };
  return { ok: true, exists: probe === abs, realPath: realCandidate };
}

function readConfigClassified(dir) {
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(path.join(dir, 'respawnpack.config.json'), 'utf8')); }
  catch (e) {
    return e && e.code === 'ENOENT'
      ? { status: 'ABSENT', value: null, detail: 'no respawnpack.config.json' }
      : { status: 'MALFORMED', value: null, detail: `respawnpack.config.json is unreadable or not parseable JSON (${e.message})` };
  }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return { status: 'MALFORMED', value: null, detail: 'respawnpack.config.json must contain a JSON object' };
  const state = cfg.state === undefined ? {} : cfg.state;
  if (!state || typeof state !== 'object' || Array.isArray(state)) return { status: 'MALFORMED', value: null, detail: 'respawnpack.config.json state must be an object' };
  if (!own(state, CONFIG_KEY)) return { status: 'ABSENT', value: null, detail: 'no state.reconcile in respawnpack.config.json' };
  const r = state[CONFIG_KEY];
  if (!r || typeof r !== 'object' || Array.isArray(r)) return { status: 'MALFORMED', value: null, detail: 'state.reconcile must be an object' };
  if (own(r, 'notApplicable') && typeof r.notApplicable !== 'boolean') {
    return { status: 'MALFORMED', value: null, detail: 'state.reconcile.notApplicable must be boolean' };
  }
  if (r.notApplicable === true && (own(r, 'tasks') || own(r, 'project'))) {
    return { status: 'MALFORMED', value: null, detail: 'state.reconcile cannot declare notApplicable and source(s) at the same time' };
  }
  return { status: 'OK', value: r, detail: null };
}

function readConfig(dir) {
  const r = readConfigClassified(dir);
  return r.status === 'OK' ? r.value : null;
}

/** Follow a dotted pointer into a parsed document. Absent is distinguishable from empty. */
function at(doc, pointer) {
  if (!pointer) return doc;
  let cur = doc;
  for (const seg of String(pointer).split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[seg];
  }
  return cur;
}

/*
 * ⛔ ABSENT, UNREADABLE AND UNPARSEABLE ARE THREE ANSWERS, NOT ONE. A `catch { return null }` here
 * would report a project whose task file was deleted identically to one whose task file is corrupt —
 * and the correct response differs: the first may be NOT_CONFIGURED, the second is never anything but
 * CANNOT_DETERMINE.
 */
function loadJSONSource(dir, spec, side) {
  if (typeof spec.path !== 'string' || !spec.path.trim()) return { error: `${side}: declared as kind "json" with no path` };
  const rel = spec.path.trim();
  if (portableAbsolute(rel) || posix(rel).split('/').includes('..')) {
    return { error: `${side}: declared JSON source ${JSON.stringify(rel)} must be project-relative with no parent traversal — external files are outside project authority` };
  }
  const project = path.resolve(dir);
  const abs = path.resolve(project, ...posix(rel).split('/'));
  const resolved = containedResolution(project, abs);
  if (!resolved.ok) {
    const why = resolved.kind === 'symlink'
      ? 'resolves outside the project through a symlink'
      : resolved.kind === 'lexical'
        ? 'resolves outside the project'
        : `could not be resolved (${(resolved.error && (resolved.error.code || resolved.error.message)) || 'unknown error'})`;
    return { error: `${side}: declared source ${rel} ${why} — external files are outside project authority` };
  }
  if (!resolved.exists) {
    return { error: `${side}: declared source ${rel} does not exist — it is DECLARED, so its absence is a fault and not a project without tasks` };
  }
  let text;
  try { text = fs.readFileSync(resolved.realPath, 'utf8'); }
  catch (e) {
    return { error: `${side}: declared source ${rel} could not be read (${(e && e.code) || e})` };
  }
  let doc;
  try { doc = JSON.parse(text); }
  catch (e) { return { error: `${side}: declared source ${rel} is not parseable JSON (${e.message})` }; }

  if (doc && typeof doc === 'object' && !Array.isArray(doc) && doc.schemaVersion !== undefined && doc.schemaVersion !== SCHEMA_VERSION) {
    return { error: `${side}: ${rel} declares schemaVersion ${JSON.stringify(doc.schemaVersion)}, this kernel supports ${SCHEMA_VERSION}`, klass: 'UNSUPPORTED_SCHEMA_VERSION' };
  }
  const rows = at(doc, spec.pointer);
  if (rows === undefined) return { error: `${side}: ${rel} has nothing at pointer "${spec.pointer || '(root)'}"` };
  if (!Array.isArray(rows)) return { error: `${side}: ${rel} pointer "${spec.pointer || '(root)'}" is ${rows === null ? 'null' : typeof rows}, expected an array of records` };
  return { rows };
}

/*
 * An adapter is the project's own tool, invoked and INTERPRETED — never reimplemented. It must print
 * JSON on stdout. `critical: true` demands discriminating controls, exactly as the validator adapters
 * do: a critical check never shown to answer differently for known-good and known-bad input has its
 * verdict discarded, because DF-007 #7 was precisely a check that answered the same for both.
 */
function loadAdapterSource(dir, spec, side) {
  const run = (args) => {
    try { return { code: 0, out: execFileSync(spec.command, args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: spec.timeoutMs || 120000 }) }; }
    catch (e) {
      if (e && e.code === 'ENOENT') return { missing: true, code: null, out: '' };
      return { code: typeof e.status === 'number' ? e.status : 1, out: `${(e && e.stdout) || ''}${(e && e.stderr) || ''}` };
    }
  };
  if (!spec.command) return { error: `${side}: declared as kind "adapter" with no command` };

  if (spec.critical) {
    if (!spec.controls || !spec.controls.good || !spec.controls.bad) {
      return { error: `${side}: adapter "${spec.command}" is declared critical but ships no known-good/known-bad controls — an unproven critical check is decoration, not evidence` };
    }
    const probe = assertLib.discriminates((args) => run(args).code, spec.controls.good, spec.controls.bad);
    if (!probe.ok) return { error: `${side}: adapter controls do not discriminate — ${probe.detail}. Verdict discarded.` };
  }

  const r = run(spec.args || []);
  if (r.missing) return { error: `${side}: adapter command not found: ${spec.command} — declared but not installed, so this side did not run` };
  if (r.code !== 0) return { error: `${side}: adapter exited ${r.code} — ${String(r.out).trim().split(/\r?\n/).slice(-2).join(' | ').slice(0, 300)}` };
  let doc;
  try { doc = JSON.parse(r.out); }
  catch (e) { return { error: `${side}: adapter "${spec.command}" did not print parseable JSON (${e.message})` }; }
  if (doc && typeof doc === 'object' && !Array.isArray(doc) && doc.schemaVersion !== undefined && doc.schemaVersion !== SCHEMA_VERSION) {
    return { error: `${side}: adapter declares schemaVersion ${JSON.stringify(doc.schemaVersion)}, this kernel supports ${SCHEMA_VERSION}`, klass: 'UNSUPPORTED_SCHEMA_VERSION' };
  }
  const rows = at(doc, spec.pointer);
  if (!Array.isArray(rows)) return { error: `${side}: adapter output pointer "${spec.pointer || '(root)'}" is not an array of records` };
  return { rows };
}

/** The kernel's OWN requirement rows, offered so the common case needs no adapter at all. */
function loadRequirementsSource(dir, side) {
  const stateLib = require('./state.js');
  const abs = path.join(dir, stateLib.STATE_DIR, 'requirements.json');
  let text;
  try { text = fs.readFileSync(abs, 'utf8'); }
  catch (e) {
    return { error: e && e.code === 'ENOENT'
      ? `${side}: kind "requirements" is declared, but ${stateLib.STATE_DIR}/requirements.json does not exist`
      : `${side}: ${stateLib.STATE_DIR}/requirements.json could not be read (${(e && e.code) || e})` };
  }
  let doc;
  try { doc = JSON.parse(text); }
  catch (e) { return { error: `${side}: ${stateLib.STATE_DIR}/requirements.json is not parseable JSON (${e.message})` }; }
  const rows = Array.isArray(doc && doc.requirements) ? doc.requirements : null;
  if (!rows) return { error: `${side}: requirements.json has no \`requirements\` array` };
  return {
    rows: rows.map((r) => ({
      id: r && r.id,
      title: (r && r.title) || '',
      // A requirement is CLOSED when the project has waived it; otherwise it is live work.
      status: r && r.waived ? 'waived' : 'open',
      requirement: r && r.id,
      gate: (r && r.gate) || null,
    })),
  };
}

function loadSide(dir, spec, side) {
  if (!spec || typeof spec !== 'object') return { error: `${side}: no source declared` };
  const kind = String(spec.kind || '');
  if (kind === 'json') return loadJSONSource(dir, spec, side);
  if (kind === 'adapter') return loadAdapterSource(dir, spec, side);
  if (kind === 'requirements') return loadRequirementsSource(dir, side);
  return { error: `${side}: unsupported source kind ${JSON.stringify(kind)} — supported kinds are "json", "adapter", "requirements"` };
}

/** Normalize raw rows into the comparable record shape, keeping every rejection explicit. */
function normalizeRows(rows, cfg, sourceLabel) {
  const records = [], problems = [], seen = new Map();
  rows.forEach((raw, i) => {
    const r = raw && typeof raw === 'object' ? raw : {};
    const id = typeof r.id === 'string' ? r.id.trim() : '';
    if (!id) { problems.push({ klass: 'SOURCE_UNREADABLE', detail: `${sourceLabel}: record ${i} has no string \`id\` — a record with no stable identifier cannot be reconciled with anything` }); return; }
    const status = normalizeStatus(r.status, cfg);
    if (status === null) {
      problems.push({ klass: 'SOURCE_UNREADABLE', id, detail: `${sourceLabel}: record ${JSON.stringify(id)} has status ${JSON.stringify(r.status)}, which maps to neither open nor closed. Declare it in openStatuses/closedStatuses — it is NOT assumed to be either.` });
      return;
    }
    if (seen.has(id)) { problems.push({ klass: 'DUPLICATE_ID', id, detail: `${sourceLabel}: identifier ${JSON.stringify(id)} appears more than once (records ${seen.get(id)} and ${i}) — a duplicate makes every comparison against it ambiguous` }); return; }
    seen.set(id, i);
    records.push({
      id, title: typeof r.title === 'string' ? r.title : '', status,
      source: sourceLabel,
      requirement: typeof r.requirement === 'string' ? r.requirement : null,
      gate: typeof r.gate === 'string' ? r.gate : null,
    });
  });
  return { records, problems };
}

/**
 * Compare the two sides. Returns a verdict with named drift rows.
 *
 * ⛔ BOTH DIRECTIONS, ALWAYS. Comparing only task → project is the defect DF-005 describes, half
 * implemented: it finds the tasks with no gap and is structurally blind to the gaps with no task,
 * which is the direction that leaves real work unscheduled.
 */
function compare(taskRecords, projectRecords, ignore) {
  const excluded = new Map((ignore || []).map((e) => [String((e && e.id) || e), (e && e.reason) || null]));
  const rows = [];
  const tasks = new Map(taskRecords.map((r) => [r.id, r]));
  const project = new Map(projectRecords.map((r) => [r.id, r]));

  for (const [id, reason] of excluded) {
    if (!tasks.has(id) && !project.has(id)) continue;
    rows.push({ klass: 'EXCLUDED_ID', id, detail: `${id} is declared out of scope${reason ? `: ${reason}` : ' with NO reason given — an exclusion without a justification is an unaudited one'}` });
  }

  for (const [id, t] of tasks) {
    if (excluded.has(id)) continue;
    const p = project.get(id);
    if (!p) { rows.push({ klass: 'TASK_WITHOUT_PROJECT_RECORD', id, detail: `task ${JSON.stringify(id)}${t.title ? ` (${t.title})` : ''} has no gap/gate/requirement record in the project` }); continue; }
    if (t.status !== p.status) rows.push({ klass: 'STATUS_CONFLICT', id, detail: `${id} is ${t.status} in the task source and ${p.status} in the project records` });
  }
  for (const [id, p] of project) {
    if (excluded.has(id) || tasks.has(id)) continue;
    rows.push({ klass: 'PROJECT_RECORD_WITHOUT_TASK', id, detail: `project record ${JSON.stringify(id)}${p.title ? ` (${p.title})` : ''} has no task tracking it` });
  }
  return rows;
}

/**
 * Run reconciliation for `dir`.
 * @returns {{status: string, why: string, checks: Array, rows: Array, counts: object, configured: boolean}}
 */
function runReconciliation(dir) {
  const label = 'reconcile';
  const configRead = readConfigClassified(dir);
  if (configRead.status === 'MALFORMED') {
    return {
      status: 'CANNOT_DETERMINE', configured: false, rows: [], counts: { tasks: 0, project: 0, drift: 0 },
      why: `${configRead.detail} — malformed configuration is not the same state as absent configuration`,
      checks: [result(OUTCOME.CANNOT_DETERMINE, label, configRead.detail, { checked: 0, domain: 'coverage' })],
    };
  }
  const cfg = configRead.value;

  /*
   * ⛔ A KEY WITH NOTHING IN IT IS STILL "NOBODY CONFIGURED THIS", AND SAYING OTHERWISE MADE THE
   * MESSAGE WORSE THE MORE THE FOUNDER HAD DONE. An ABSENT `state.reconcile` produced the guidance
   * below — declare two sources, or declare notApplicable with a reason. A PRESENT but empty one
   * (`"reconcile": {}`, or a seeded placeholder carrying only a note) fell through to the loaders and
   * came back "a declared source could not be read or interpreted — tasks: no source declared ·
   * project: no source declared", which is false twice over: nothing was declared, and nothing failed
   * to read. So the founder who started filling this in got a more confusing answer than the one who
   * ignored it, and the installer could not seed a placeholder without making its own output worse.
   *
   * ONE SIDE declared is NOT this case and deliberately still errors: that is a real half-configuration
   * and naming the missing side is the useful answer.
   */
  /*
   * ⛔ `=== undefined`, NOT FALSINESS. A truthiness test read `tasks: null` — a malformed source, a
   * template someone half-filled, a generator that emitted a null — as "no key here" and answered
   * NOT_CONFIGURED, which is the reassuring answer. The key is PRESENT and unusable, which is a
   * configuration fault and belongs in the loaders below where it is named. Absent means absent.
   */
  const unconfigured = !cfg || (cfg.notApplicable !== true && !own(cfg, 'tasks') && !own(cfg, 'project'));
  if (unconfigured) {
    const where = cfg ? 'state.reconcile in respawnpack.config.json declares no sources' : 'no state.reconcile in respawnpack.config.json';
    return {
      status: 'NOT_CONFIGURED', configured: false, rows: [], counts: { tasks: 0, project: 0, drift: 0 },
      why: `${where} — this project has declared no task source and no project record source, so nothing was compared`,
      /*
       * `domain: 'coverage'` marks WHICH QUESTION this row answers — "has anybody decided whether this
       * applies here" rather than "do the lists agree" — so savepoint can report the two separately. It
       * changes no outcome: an unconfigured reconciliation is still CANNOT_DETERMINE and still not a
       * pass. See kernel/lib/applicability.js.
       */
      checks: [result(OUTCOME.CANNOT_DETERMINE, label, `${where}. Declare a task source and a project record source, or declare state.reconcile.notApplicable with a reason. An unconfigured reconciliation is not a passing one.`, { checked: 0, domain: 'coverage' })],
    };
  }

  if (cfg.notApplicable === true) {
    /*
     * ⛔ NOT_APPLICABLE IS DECLARED, WITH A REASON, OR IT IS NOT AVAILABLE. The quality gate learned
     * this the expensive way: four YAML skip-branches inferred "nothing to check" and reported green.
     */
    if (!cfg.reason || !String(cfg.reason).trim()) {
      return {
        status: 'CANNOT_DETERMINE', configured: true, rows: [], counts: { tasks: 0, project: 0, drift: 0 },
        why: 'state.reconcile.notApplicable is true with no reason — an opt-out nobody has to justify is an opt-out nobody reviews',
        checks: [result(OUTCOME.CANNOT_DETERMINE, label, 'notApplicable declared without a reason', { checked: 0, domain: 'coverage' })],
      };
    }
    return {
      status: 'NOT_APPLICABLE', configured: true, rows: [], counts: { tasks: 0, project: 0, drift: 0 },
      why: `declared not applicable: ${cfg.reason}`,
      checks: [result(OUTCOME.NOT_APPLICABLE, label, `declared not applicable: ${cfg.reason}`, { domain: 'coverage' })],
    };
  }

  const taskSide = loadSide(dir, cfg.tasks, 'tasks');
  const projSide = loadSide(dir, cfg.project, 'project');
  const loadErrors = [];
  for (const s of [taskSide, projSide]) if (s.error) loadErrors.push({ klass: s.klass || 'SOURCE_UNREADABLE', detail: s.error });

  if (loadErrors.length) {
    return {
      status: 'CANNOT_DETERMINE', configured: true, rows: loadErrors, counts: { tasks: 0, project: 0, drift: 0 },
      why: loadErrors.map((e) => e.detail).join(' · '),
      checks: [result(OUTCOME.CANNOT_DETERMINE, label, `a declared source could not be read or interpreted — ${loadErrors.map((e) => e.detail).join(' · ')}`, { checked: 0 })],
    };
  }

  const t = normalizeRows(taskSide.rows, cfg, 'tasks');
  const p = normalizeRows(projSide.rows, cfg, 'project');
  const problems = [...t.problems, ...p.problems];

  /*
   * ⛔ ZERO RECORDS IS NEVER AGREEMENT. Two empty lists agree perfectly and mean nothing was checked.
   * This branch is the single most important line in the file, and it is placed BEFORE the comparison
   * so no code path can reach a PASS through it.
   */
  const zero = [];
  if (!t.records.length) zero.push({ klass: 'ZERO_RECORDS', detail: `tasks: the declared source parsed to ZERO usable records${t.problems.length ? ` (${t.problems.length} record(s) rejected — see below)` : ''}. Comparing nothing against something is not agreement.` });
  if (!p.records.length) zero.push({ klass: 'ZERO_RECORDS', detail: `project: the declared source parsed to ZERO usable records${p.problems.length ? ` (${p.problems.length} record(s) rejected — see below)` : ''}. Comparing nothing against something is not agreement.` });
  if (zero.length) {
    const rows = [...zero, ...problems];
    return {
      status: 'CANNOT_DETERMINE', configured: true, rows,
      counts: { tasks: t.records.length, project: p.records.length, drift: 0 },
      /*
       * ⛔ THE REJECTIONS TRAVEL WITH THE COUNT. "Zero usable records" without saying WHY they were
       * unusable sends the reader hunting for an empty file that is not empty — the single most
       * common cause of a zero here is every record being rejected for one nameable reason.
       */
      why: [...zero, ...problems].map((z) => z.detail).join(' · '),
      checks: [result(OUTCOME.CANNOT_DETERMINE, label, rows.map((r) => r.detail).join(' · ').slice(0, 900), { checked: 0 })],
    };
  }

  const driftRows = compare(t.records, p.records, cfg.ignore);
  const rows = [...problems, ...driftRows];
  const real = rows.filter((r) => r.klass !== 'EXCLUDED_ID');
  const undetermined = real.filter((r) => r.klass === 'SOURCE_UNREADABLE' || r.klass === 'UNSUPPORTED_SCHEMA_VERSION');
  const drift = real.filter((r) => !undetermined.includes(r));
  const counts = { tasks: t.records.length, project: p.records.length, drift: drift.length };

  if (undetermined.length) {
    return {
      status: 'CANNOT_DETERMINE', configured: true, rows, counts,
      why: `${undetermined.length} record(s) could not be interpreted: ${undetermined.map((r) => r.detail).join(' · ').slice(0, 600)}`,
      checks: [result(OUTCOME.CANNOT_DETERMINE, label, `${undetermined.length} record(s) could not be interpreted — ${undetermined.map((r) => r.detail).join(' · ').slice(0, 800)}`, { checked: counts.tasks + counts.project })],
    };
  }

  if (drift.length) {
    const byClass = {};
    for (const r of drift) (byClass[r.klass] = byClass[r.klass] || []).push(r.id);
    const summary = Object.entries(byClass).map(([k, ids]) => `${k}: ${ids.join(', ')}`).join(' · ');
    return {
      status: 'DRIFT', configured: true, rows, counts,
      why: summary,
      checks: [result(OUTCOME.FAIL, label, `${counts.tasks} task record(s) and ${counts.project} project record(s) DISAGREE — ${summary}`, { checked: counts.tasks + counts.project })],
    };
  }

  return {
    status: 'PASS', configured: true, rows, counts,
    why: `${counts.tasks} task record(s) and ${counts.project} project record(s) agree`,
    checks: [result(OUTCOME.PASS, label, `${counts.tasks} task record(s) and ${counts.project} project record(s) agree`, { checked: counts.tasks + counts.project })],
  };
}

/**
 * The doctor's view: is reconciliation configured and active, not configured, broken, or unsupported?
 * Kept separate from the verdict because "is this wired up" and "do the lists agree" are different
 * questions, and answering the first with the second is how a broken check reads as a clean project.
 */
function surveyReconciliation(dir) {
  const configRead = readConfigClassified(dir);
  if (configRead.status === 'MALFORMED') return { state: 'BROKEN', detail: configRead.detail };
  const cfg = configRead.value;
  // Same rule as runReconciliation: a key with neither side declared is unconfigured, not broken.
  if (!cfg || (cfg.notApplicable !== true && !own(cfg, 'tasks') && !own(cfg, 'project'))) {
    return {
      state: 'NOT_CONFIGURED',
      detail: `${cfg ? 'state.reconcile declares no sources' : 'no state.reconcile in respawnpack.config.json'} — the harness task list and this project's records are not compared`,
    };
  }
  if (cfg.notApplicable === true) {
    return String(cfg.reason || '').trim()
      ? { state: 'NOT_APPLICABLE', detail: `declared not applicable: ${cfg.reason}` }
      : { state: 'BROKEN', detail: 'notApplicable declared with no reason' };
  }
  for (const [side, spec] of [['tasks', cfg.tasks], ['project', cfg.project]]) {
    if (!spec || typeof spec !== 'object') return { state: 'BROKEN', detail: `the ${side} source is not declared` };
    if (!['json', 'adapter', 'requirements'].includes(String(spec.kind || ''))) {
      return { state: 'UNSUPPORTED', detail: `the ${side} source declares kind ${JSON.stringify(spec.kind)}, which this kernel does not support` };
    }
  }
  const r = runReconciliation(dir);
  if (r.status === 'CANNOT_DETERMINE') return { state: 'BROKEN', detail: r.why };
  return { state: 'ACTIVE', detail: r.why, verdict: r.status };
}

module.exports = {
  SCHEMA_VERSION, DRIFT, DEFAULT_OPEN, DEFAULT_CLOSED,
  readConfig, readConfigClassified, runReconciliation, surveyReconciliation,
};
