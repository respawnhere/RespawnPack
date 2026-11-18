/*
 * RespawnPack · kernel/lib/living.js — the living-skill lifecycle, for the canaries that have one.
 *
 * ⛔ OVERCLAIMS #1 AND #2, AND WHY THE FIX IS HALF MECHANISM AND HALF SUBTRACTION. README.md advertised
 * "living skills that learn from a persistent memory engine" and
 * spine/reference/living-skills.md said **every** RespawnPack-owned skill has two forms. The tree said
 * 9 of 20 shipped a `SKILL.base.md`, **zero** `.skill-meta.json` existed anywhere, and nothing generated
 * an overlay, checked drift, or reset one. The doctrine was complete and the machinery was absent.
 *
 * Owner decision OD-1 refused both halves of the obvious binary: do NOT manufacture twenty baselines to
 * make a count true, and do NOT quietly drop the idea. Stabilise the lifecycle on a few useful CANARIES
 * — `debug`, `savepoint`, `knowledge` — narrow every claim to exactly those, and say plainly that a
 * skill without living machinery is a fully supported STATIC skill rather than a second-class one.
 *
 * ⭐ WHAT "NO MANUFACTURED BASELINE" MEANS HERE, precisely. Enabling a canary FREEZES the skill that is
 * already on disk as its `SKILL.base.md`. That is not authorship: the base IS the authored skill,
 * captured at the moment someone opted in. Nothing is invented, nothing is back-dated, and the pack
 * ships no new baseline files — so the "9 of 20 ship a base" count stays exactly as true as it was.
 *
 * ⛔ AND THE OVERLAY IS DERIVED, OR IT IS NOTHING. Every learned line is traceable to a memory entity
 * that declares `applies-to|skill:<name>`, and carries that entity's DATE, CONFIDENCE and SOURCE PATH.
 * A line nobody can trace back to a memory entry cannot appear, because the failure this replaces is a
 * documentation layer that asserted things with no source. Regeneration is deterministic (sorted by
 * confidence, then date, then id) and budget-capped, and what the budget dropped is REPORTED — a silent
 * cap reads as "this is everything we know", which is the same false completeness in a smaller box.
 *
 * ⛔ THE MARKDOWN IS THE SOURCE, NOT THE ENGINE. `memory/graph/**` is the source of truth by the memory
 * engine's own design; the engine is an index over it. Reading the markdown directly means the canary
 * lifecycle works with the ZERO-SETUP default backend and does not smuggle in an engine dependency —
 * which would put an "optional" component on the critical path of a feature that advertises itself as
 * working out of the box.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { OUTCOME, result } = require('./outcome.js');

/*
 * ⛔ THE CANARIES, AS A CLOSED LIST. Named here rather than discovered, because "every owned skill" is
 * exactly the claim that was false. Expanding this list is a decision someone makes after dogfood shows
 * adaptation actually improves the skill — not a side effect of a glob matching more files.
 */
const CANARIES = ['debug', 'savepoint', 'knowledge'];

const OVERLAY_HEADING = '## Learned (living)';
const OVERLAY_NOTE = '<!-- regenerated from memory entities keyed `applies-to|skill:<name>`; do not hand-edit -->';
const DEFAULT_BUDGET_LINES = 12;
const META = '.skill-meta.json';

const sha256 = (t) => crypto.createHash('sha256').update(t).digest('hex');
const readText = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
const readJSON = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const norm = (t) => String(t == null ? '' : t).replace(/\r\n/g, '\n');

/**
 * Where a skill lives. Installed targets keep skills under `.claude/skills/`; this repository keeps its
 * own under `skills/`. Both are checked so the lifecycle is testable in the pack and real in a target.
 */
function skillDir(dir, name) {
  for (const rel of [path.join('.claude', 'skills', name), path.join('skills', name)]) {
    const abs = path.join(dir, rel);
    if (fs.existsSync(path.join(abs, 'SKILL.md'))) return abs;
  }
  return null;
}

const isCanary = (name) => CANARIES.includes(String(name));

// --- the memory feed --------------------------------------------------------------------------------

/**
 * Memory entities keyed to a skill, read from the markdown source of truth.
 *
 * Returns { status, lessons, scanned, reason }. An unreadable memory root is CANNOT_DETERMINE, never an
 * empty lesson list — "we found nothing" and "we could not look" must not render the same overlay.
 */
function lessonsFor(dir, name) {
  const roots = [path.join(dir, 'memory', 'graph')];
  const lessons = [];
  let scanned = 0;
  let found = false;

  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    found = true;
    const walk = (abs) => {
      let entries;
      try { entries = fs.readdirSync(abs, { withFileTypes: true }); }
      catch (e) { throw Object.assign(new Error(`${abs}: ${e.code || e.message}`), { unreadable: true }); }
      for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const child = path.join(abs, e.name);
        if (e.isDirectory()) { walk(child); continue; }
        if (!e.isFile() || !e.name.endsWith('.md')) continue;
        scanned += 1;
        const text = readText(child);
        if (text === null) throw Object.assign(new Error(`${child}: unreadable`), { unreadable: true });
        const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
        if (!fm) continue;
        const field = (k) => {
          const m = new RegExp(`^${k}:\\s*(.*)$`, 'm').exec(fm[1]);
          return m ? m[1].trim() : null;
        };
        const relations = String(field('relations') || '').replace(/^\[|\]$/g, '');
        if (!new RegExp(`applies-to\\|skill:${name}(\\s*,|\\s*$|["'])`).test(`${relations},`)) continue;
        lessons.push({
          id: field('id') || path.basename(child, '.md'),
          confidence: Number(field('confidence')),
          observedAt: field('observed_at') || field('updated_at') || '',
          negative: /^true$/i.test(String(field('negative'))),
          source: path.relative(dir, child).replace(/\\/g, '/'),
          // The first non-heading line of the body is the lesson; the entity is the record, this is the
          // one line that belongs on an overlay someone reads at load time.
          text: (fm[2] || '').split(/\r?\n/).map((l) => l.trim())
            .find((l) => l && !l.startsWith('#') && !l.startsWith('<!--')) || '',
        });
      }
    };
    try { walk(root); }
    catch (e) {
      if (e && e.unreadable) return { status: 'CANNOT_DETERMINE', lessons: [], scanned, reason: `the memory source could not be read (${e.message})` };
      throw e;
    }
  }
  if (!found) return { status: 'CANNOT_DETERMINE', lessons: [], scanned: 0, reason: 'no memory/graph/ directory — there is no source to derive an overlay from' };
  return { status: 'PASS', lessons, scanned, reason: null };
}

/**
 * Render the overlay. DETERMINISTIC by construction: sorted by confidence, then date, then id, so the
 * same memory always produces byte-identical output and a regeneration diff means the MEMORY changed.
 */
function renderOverlay(lessons, budget) {
  const usable = lessons
    .filter((l) => l.text)
    .sort((a, b) => (Number.isFinite(b.confidence) ? b.confidence : -1) - (Number.isFinite(a.confidence) ? a.confidence : -1)
      || String(b.observedAt).localeCompare(String(a.observedAt))
      || String(a.id).localeCompare(String(b.id)));
  const kept = usable.slice(0, budget);
  const dropped = usable.slice(budget);
  const lines = kept.map((l) => {
    const when = /^\d{4}-\d{2}-\d{2}/.test(String(l.observedAt)) ? String(l.observedAt).slice(0, 10) : 'undated';
    // ⛔ EVERY LINE CARRIES ITS PROVENANCE. Date, confidence and the source file, so a reader can check
    // any claim on this overlay against the entity it came from — and an unsourced line is impossible.
    const conf = Number.isFinite(l.confidence) ? l.confidence.toFixed(2) : 'unrated';
    return `- [${when} · conf:${conf} · ${l.source}] ${l.negative ? '⛔ ' : ''}${l.text}`;
  });
  return {
    body: [OVERLAY_HEADING, OVERLAY_NOTE, ...(lines.length ? lines : ['- (no memory entity is keyed to this skill yet)']), ''].join('\n'),
    kept: kept.length,
    // ⛔ NEVER A SILENT CAP. What the budget dropped is named, because an overlay that quietly truncates
    // reads as "this is everything we know".
    dropped: dropped.map((l) => l.id),
  };
}

const splitOverlay = (text) => {
  const at = norm(text).indexOf(`\n${OVERLAY_HEADING}`);
  return at < 0 ? { base: norm(text), overlay: null } : { base: norm(text).slice(0, at + 1), overlay: norm(text).slice(at + 1) };
};

// --- the lifecycle ----------------------------------------------------------------------------------

/** Enable the living lifecycle for one canary: freeze what is on disk, record its metadata. */
function enable(dir, name) {
  if (!isCanary(name)) {
    return result(OUTCOME.FAIL, `living:${name}`,
      `"${name}" is not one of the living-skill canaries (${CANARIES.join(', ')}). The lifecycle is proven on those ` +
      'three and claimed for those three; every other skill is a fully supported STATIC skill, which is a ' +
      'complete state and not a second-class one. Vendor skills are never touched at all.', { checked: 0 });
  }
  const sd = skillDir(dir, name);
  if (!sd) return result(OUTCOME.FAIL, `living:${name}`, `no ${name}/SKILL.md in this project`, { checked: 0 });

  const skillPath = path.join(sd, 'SKILL.md');
  const basePath = path.join(sd, 'SKILL.base.md');
  const metaPath = path.join(sd, META);
  const live = norm(readText(skillPath));

  /*
   * ⛔ FREEZE WHAT IS THERE — and if a base already exists, KEEP IT. Overwriting an existing baseline
   * with a living form that has already accrued an overlay would make the fallback a copy of the thing
   * it is supposed to be a fallback from, which is the one way to lose the guarantee entirely.
   */
  const existingBase = readText(basePath);
  const base = existingBase === null ? splitOverlay(live).base : norm(existingBase);
  if (existingBase === null) fs.writeFileSync(basePath, base);

  const meta = {
    schemaVersion: '1.0.0',
    skill: name,
    baseHash: sha256(base),
    enabledAt: new Date().toISOString(),
    lastReset: null,
    overlayBudgetLines: DEFAULT_BUDGET_LINES,
    source: 'memory entities with `applies-to|skill:' + name + '`',
  };
  fs.writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`);

  return result(OUTCOME.PASS, `living:${name}`,
    `enabled — ${existingBase === null ? 'froze the current SKILL.md as SKILL.base.md' : 'kept the existing SKILL.base.md'}, ` +
    `budget ${meta.overlayBudgetLines} lines. Nothing is rewritten until \`living regenerate\` runs.`, { checked: 1 });
}

/** Regenerate the overlay from memory. Never touches the base; never invents a line. */
function regenerate(dir, name, { write = false } = {}) {
  // ⛔ The stamp is IGNORED here, deliberately. status() reports a superseded overlay as FAIL and tells
  // the founder to run this verb — so gating this verb on that same status would make the recommended
  // remedy unreachable and leave the only exit a reset that discards the lesson. Every OTHER failure
  // still stops the regeneration: a missing base or a hand-edited living form is not recoverable by
  // re-deriving on top of it.
  const st = status(dir, name, { ignoreSuperseded: true });
  if (st.outcome !== OUTCOME.PASS) return st;

  const sd = skillDir(dir, name);
  const meta = readJSON(path.join(sd, META));
  const base = norm(readText(path.join(sd, 'SKILL.base.md')));
  const feed = lessonsFor(dir, name);
  if (feed.status !== 'PASS') {
    return result(OUTCOME.CANNOT_DETERMINE, `living:${name}`,
      `${feed.reason} — the overlay was NOT regenerated. An empty overlay and an unreadable source are ` +
      'different facts, and rendering the first for the second is how a derived document starts lying.', { checked: 0 });
  }
  /*
   * ⛔ FILTERED-TO-ZERO IS NOT A SUCCESSFUL REGENERATION. A fresh install contains only
   * `memory/graph/.gitkeep`; an unrelated or unkeyed markdown entity is the same effective corpus for
   * this skill. Before the shared outcome constructor enforced checked > 0, this rendered an empty
   * overlay and called it PASS. After that invariant landed it escaped as a CLI-wide FAIL exception.
   * Name the actual uncertainty and leave SKILL.md untouched instead.
   */
  if (feed.lessons.length === 0) {
    return result(OUTCOME.CANNOT_DETERMINE, `living:${name}`,
      `no memory entity is keyed to skill:${name} after scanning ${feed.scanned} markdown file(s) — ` +
      'the overlay was NOT regenerated because zero checked subjects cannot pass.', { checked: 0 });
  }

  const budget = Number(meta.overlayBudgetLines) || DEFAULT_BUDGET_LINES;
  const overlay = renderOverlay(feed.lessons, budget);
  const next = `${base.replace(/\s*$/, '')}\n\n${overlay.body}`;
  if (write) {
    fs.writeFileSync(path.join(sd, 'SKILL.md'), next);
    // Rebuilding the overlay is the founder acting on a superseded-by-upgrade report — clear the stamp
    // so status stops reporting a loss that no longer describes what is on disk. The ARCHIVE stays.
    const mp = path.join(sd, META);
    const m = readJSON(mp);
    if (m && m.supersededByUpgrade) {
      delete m.supersededByUpgrade;
      fs.writeFileSync(mp, `${JSON.stringify(m, null, 2)}\n`);
    }
  }

  return result(OUTCOME.PASS, `living:${name}`,
    `${overlay.kept} learned line(s) from ${feed.lessons.length} keyed memory entit(y/ies) across ${feed.scanned} file(s); ` +
    `budget ${budget} line(s)` +
    `${overlay.dropped.length ? `; ${overlay.dropped.length} over budget and NOT included: ${overlay.dropped.join(', ')}` : ''}` +
    `${write ? '' : ' — preview only, nothing written'}`,
    { checked: feed.lessons.length, rendered: next, dropped: overlay.dropped });
}

/** Is the living form still what the base plus a generated overlay would produce? */
function status(dir, name, { ignoreSuperseded = false } = {}) {
  const sd = skillDir(dir, name);
  if (!sd) return result(OUTCOME.NOT_APPLICABLE, `living:${name}`, `no ${name}/SKILL.md in this project`, { checked: 0 });

  const metaRaw = readText(path.join(sd, META));
  if (metaRaw === null) {
    return result(OUTCOME.NOT_APPLICABLE, `living:${name}`,
      `${name} is a STATIC skill here — no ${META}, so the living lifecycle was never enabled. That is a complete, ` +
      'supported state; run `living enable` to opt in.', { checked: 0 });
  }
  let meta;
  try { meta = JSON.parse(metaRaw); }
  catch (e) {
    return result(OUTCOME.CANNOT_DETERMINE, `living:${name}`,
      `${META} does not parse (${e.message}) — whether this skill drifted cannot be established.`, { checked: 0 });
  }
  /*
   * ⛔ `JSON.parse` SUCCEEDS ON `null`, `[]`, `123` AND `"s"`. A sixth gate found that a `.skill-meta.json`
   * containing `null` parsed fine, sailed past the catch above, and then crashed the field loop below
   * with a raw `TypeError` reading `meta[field]` — a stack trace where the four-outcome contract owes a
   * verdict. A non-object is exactly the "incomplete metadata" case that loop exists to report.
   */
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) {
    return result(OUTCOME.CANNOT_DETERMINE, `living:${name}`,
      `${META} parses but is not an object (${meta === null ? 'null' : Array.isArray(meta) ? 'an array' : typeof meta}) — `
      + 'whether this skill drifted cannot be established. Delete it and re-run `living enable`.', { checked: 0 });
  }
  for (const field of ['schemaVersion', 'baseHash', 'overlayBudgetLines']) {
    if (meta[field] === undefined || meta[field] === null) {
      return result(OUTCOME.CANNOT_DETERMINE, `living:${name}`,
        `${META} is missing "${field}" — incomplete metadata is not a clean bill of health.`, { checked: 0 });
    }
  }
  /*
   * ⛔ THE UPGRADE THAT ATE THE OVERLAY. `--for-upgrade` unlinks SKILL.md and the installer re-lays
   * the pack's copy. When that copy equals the frozen base — the common case — every check below is
   * TRUE and this returned `PASS · overlay 0/12 line(s)`: a green outcome over lines that had been
   * destroyed minutes earlier. The uninstaller now archives the living form and stamps this field;
   * a stamped meta is reported BEFORE any check that would read as clean, and the stamp is cleared
   * by `regenerate --write` (which rebuilds the overlay) or by `reset` (which declares the base is
   * what the founder wants). Nothing here deletes the archive.
   */
  if (meta.supersededByUpgrade && !ignoreSuperseded) {
    const arch = meta.supersededByUpgrade.archive || 'SKILL.superseded.md';
    const n = meta.supersededByUpgrade.lines;
    return result(OUTCOME.FAIL, `living:${name}`,
      `an upgrade replaced the living form. The pre-upgrade SKILL.md (${n} line(s)) is archived at ` +
      `${name}/${arch} — it was NOT merged into the new pack skill, so any lesson it carried is not in ` +
      'effect right now. Re-derive it with `living regenerate --write`, or accept the new base with `living reset`.',
      { checked: 1 });
  }
  const base = readText(path.join(sd, 'SKILL.base.md'));
  if (base === null) {
    return result(OUTCOME.FAIL, `living:${name}`,
      'the living lifecycle is enabled but SKILL.base.md is MISSING — the guaranteed-good floor is gone, ' +
      'so a reset has nothing to restore to.', { checked: 0 });
  }
  if (sha256(norm(base)) !== meta.baseHash) {
    return result(OUTCOME.FAIL, `living:${name}`,
      'SKILL.base.md has changed since the lifecycle was enabled. The base is WRITE-ONCE canonical: change it ' +
      'to change the skill\'s INTENT, and re-run `living enable` to re-record the hash — never to record a lesson.', { checked: 1 });
  }

  const live = norm(readText(path.join(sd, 'SKILL.md')));
  const split = splitOverlay(live);
  if (norm(split.base).replace(/\s*$/, '') !== norm(base).replace(/\s*$/, '')) {
    return result(OUTCOME.FAIL, `living:${name}`,
      'SKILL.md no longer contains its base verbatim — the living form has been hand-edited outside the overlay. ' +
      'Recover with `living reset`, which archives the overlay and restores the base; the source memory is untouched.', { checked: 1 });
  }
  const overlayLines = split.overlay ? split.overlay.split(/\r?\n/).filter((l) => l.trim().startsWith('- ')).length : 0;
  if (overlayLines > Number(meta.overlayBudgetLines)) {
    return result(OUTCOME.FAIL, `living:${name}`,
      `the overlay carries ${overlayLines} lines against a budget of ${meta.overlayBudgetLines}.`, { checked: 1 });
  }
  return result(OUTCOME.PASS, `living:${name}`,
    `living, base intact, overlay ${overlayLines}/${meta.overlayBudgetLines} line(s)`, { checked: 1 });
}

/** Restore SKILL.md from its base, archiving the overlay. Source memory is never touched. */
function reset(dir, name) {
  const sd = skillDir(dir, name);
  if (!sd) return result(OUTCOME.FAIL, `living:${name}`, `no ${name}/SKILL.md in this project`, { checked: 0 });
  const base = readText(path.join(sd, 'SKILL.base.md'));
  if (base === null) {
    return result(OUTCOME.FAIL, `living:${name}`,
      'there is no SKILL.base.md to restore from — reset cannot invent the floor it exists to return to.', { checked: 0 });
  }
  const live = norm(readText(path.join(sd, 'SKILL.md')));
  const overlay = splitOverlay(live).overlay;
  let archived = null;
  if (overlay && overlay.trim()) {
    archived = path.join(sd, `SKILL.overlay.${new Date().toISOString().replace(/[:.]/g, '-')}.md`);
    fs.writeFileSync(archived, overlay);
  }
  fs.writeFileSync(path.join(sd, 'SKILL.md'), norm(base));

  const metaPath = path.join(sd, META);
  const meta = readJSON(metaPath);
  // Accepting the base is the founder acting on a superseded-by-upgrade report — the stamp goes, the
  // ARCHIVE stays on disk. Reset has always archived rather than deleted; that does not change here.
  if (meta) {
    delete meta.supersededByUpgrade;
    fs.writeFileSync(metaPath, `${JSON.stringify({ ...meta, lastReset: new Date().toISOString() }, null, 2)}\n`);
  }

  return result(OUTCOME.PASS, `living:${name}`,
    `restored from SKILL.base.md${archived ? `; the overlay is archived at ${path.relative(dir, archived).replace(/\\/g, '/')}` : ''}. ` +
    'The source memory entities are untouched, so the next regeneration can re-propose them.', { checked: 1 });
}

/** Every canary's state in this project — the honest per-install answer to "are skills living here?". */
function survey(dir) {
  return CANARIES.map((name) => ({ name, ...status(dir, name) }));
}

module.exports = {
  enable, regenerate, status, reset, survey, lessonsFor, renderOverlay, skillDir, isCanary,
  CANARIES, OVERLAY_HEADING, DEFAULT_BUDGET_LINES, META,
};
