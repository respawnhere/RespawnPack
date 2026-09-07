/*
 * RespawnPack · conformance/runner.js — replays a recorded lifecycle trace through the REAL state machine.
 *
 * ⛔ A RUNNER THAT CANNOT FAIL IS DECORATION. Every fixture declares what it expects; the runner reports
 * MISMATCHES rather than throwing, and conformance.test.mjs proves the runner discriminates by mutating
 * a known-good trace's expectation and requiring the mismatch to appear. A harness whose known-good and
 * known-bad inputs produce the same answer has proven that it runs, not that it can detect anything —
 * that is DF-007 #7, and it is the reason the control pair is part of the suite rather than a habit.
 *
 * ⛔ AND NOTHING HERE RE-IMPLEMENTS THE MACHINE. The runner only feeds JSON in and reads the journal
 * out. If it contained its own idea of what a transition does, the fixtures would be testing the runner
 * and passing regardless of core/. Every state it reports comes from core/lifecycle/machine.js; every
 * journal row it counts was read back off disk.
 *
 * A trace is data. Steps:
 *   apply             {transition, eventId, evidence[], failureCode?, expectStatus?, expectFailure?}
 *   write-handoff     {as, handoff}            — real write + read-back through core/state/handoff.js
 *   tamper-handoff    {ref, append}            — mutate the bytes AFTER verification
 *   revoke-verification {ref}                 — remove the verification receipt: an unverified handoff
 *   reverify-handoff  {ref, as}                — re-read and compare against the ORIGINAL written digest
 *   consume-handoff   {ref, consumerId, expectStatus?}
 *   latch             {threshold, atPercent}
 *   crash             — drop the in-memory machine; the next step reopens it from disk
 *   delete-snapshot   — the crash landed before state.json was written
 *   stale-snapshot    {state} — the crash landed between the journal append and the snapshot
 *   truncate-journal  {bytes} — the crash landed mid-append
 *   expect-state      {state}
 *   expect-open       {restored?, tornTailDiscarded?, snapshotStale?, cycleFileRewritten?}
 *
 * Evidence may reference something an earlier step produced: {"$ref": "h1.written"}. `"$cycleId"` as a
 * string value is substituted with the machine's current context-cycle id.
 */
const fs = require('fs');
const path = require('path');
const core = require('../core/index.js');

const { machine, handoff, thresholds, journal, states } = core;

function replay(trace, { projectDir }) {
  const mismatches = [];
  const note = (what) => mismatches.push(what);

  const host = trace.host;
  const conversationId = trace.conversationId;
  const dir = machine.conversationDir(projectDir, host, conversationId);

  const refs = {};
  const observed = {
    id: trace.id,
    opens: [],
    steps: [],
    consumptions: [],
    statesEntered: [],
    finalState: null,
    haltCode: null,
    outcome: null,
    cycleIds: [],
  };

  let m = null;
  let lastOpen = null;

  function ensure() {
    if (m) return m;
    const r = machine.open({ projectDir, host, conversationId });
    if (!r.ok) {
      lastOpen = { failed: true, failure: r.failure };
      observed.opens.push(lastOpen);
      return null;
    }
    m = r.machine;
    lastOpen = { failed: false, ...r.opened, state: m.state(), cycleId: m.cycleId() };
    observed.opens.push(lastOpen);
    if (!observed.cycleIds.includes(m.cycleId())) observed.cycleIds.push(m.cycleId());
    if (!observed.statesEntered.includes(m.state())) observed.statesEntered.push(m.state());
    return m;
  }

  /** Resolve {"$ref": "h1.written"} and "$cycleId" inside a trace value. */
  function resolve(value) {
    if (Array.isArray(value)) return value.map(resolve);
    if (value && typeof value === 'object') {
      if (typeof value.$ref === 'string') {
        const [name, field] = value.$ref.split('.');
        const holder = refs[name];
        if (!holder) { note(`step referenced ${value.$ref}, and nothing produced ${name}`); return {}; }
        return field ? holder[field] : holder;
      }
      const out = {};
      for (const [k, v] of Object.entries(value)) out[k] = resolve(v);
      return out;
    }
    if (value === '$cycleId') return m ? m.cycleId() : null;
    return value;
  }

  for (const [i, step] of (trace.steps || []).entries()) {
    const label = `${trace.id} step ${i} (${step.do})`;

    if (step.do === 'crash') { m = null; continue; }

    if (step.do === 'delete-snapshot') {
      try { fs.rmSync(journal.snapshotPath(dir)); } catch { /* never written, which is the case being simulated */ }
      continue;
    }

    if (step.do === 'stale-snapshot') {
      const snap = core.io.readJSONClassified(journal.snapshotPath(dir));
      const base = snap.status === 'OK' ? snap.doc : {};
      core.io.writeAtomicJSON(journal.snapshotPath(dir), { ...base, state: step.state });
      continue;
    }

    if (step.do === 'truncate-journal') {
      const p = journal.journalPath(dir);
      const text = fs.readFileSync(p, 'utf8');
      fs.writeFileSync(p, text.slice(0, Math.max(0, text.length - step.bytes)));
      continue;
    }

    if (step.do === 'expect-state') {
      const mm = ensure();
      const actual = mm ? mm.state() : '<machine could not open>';
      if (actual !== step.state) note(`${label}: expected state ${step.state}, observed ${actual}`);
      continue;
    }

    if (step.do === 'expect-open') {
      ensure();
      for (const k of ['restored', 'tornTailDiscarded', 'snapshotStale', 'cycleFileRewritten']) {
        if (step[k] !== undefined && Boolean(lastOpen && lastOpen[k]) !== step[k]) {
          note(`${label}: expected open.${k}=${step[k]}, observed ${Boolean(lastOpen && lastOpen[k])}`);
        }
      }
      continue;
    }

    const mm = ensure();
    if (!mm) { note(`${label}: the machine could not be opened (${lastOpen && lastOpen.failure && lastOpen.failure.code})`); break; }

    if (step.do === 'write-handoff') {
      const rec = handoff.build(resolve(step.handoff));
      const w = handoff.writeVerified(dir, rec);
      if (!w.ok) {
        refs[step.as] = { handoffId: rec.handoffId, failed: true, failure: w.failure, ...(w.evidence || {}) };
        if (step.expectOk !== false) note(`${label}: the handoff could not be written and verified: ${w.failure.code}`);
      } else {
        refs[step.as] = { handoffId: rec.handoffId, handoffPath: w.handoffPath, writtenDigest: w.writtenDigest, written: w.evidence.written, readback: w.evidence.readback };
      }
      observed.steps.push({ i, do: step.do, handoffId: rec.handoffId, ok: w.ok });
      continue;
    }

    if (step.do === 'tamper-handoff') {
      const holder = refs[step.ref];
      if (!holder) { note(`${label}: no handoff named ${step.ref}`); continue; }
      fs.appendFileSync(holder.handoffPath, step.append || '\n');
      observed.steps.push({ i, do: step.do, ref: step.ref });
      continue;
    }

    if (step.do === 'revoke-verification') {
      const holder = refs[step.ref];
      if (!holder) { note(`${label}: no handoff named ${step.ref}`); continue; }
      try { fs.rmSync(handoff.verifiedPathFor(dir, holder.handoffId)); } catch { note(`${label}: there was no verification receipt to remove`); }
      observed.steps.push({ i, do: step.do, ref: step.ref });
      continue;
    }

    if (step.do === 'reverify-handoff') {
      const holder = refs[step.ref];
      if (!holder) { note(`${label}: no handoff named ${step.ref}`); continue; }
      const now = core.io.readTextClassified(holder.handoffPath);
      const rec = core.evidence.make(core.evidence.KINDS.HANDOFF_READBACK, {
        handoffId: holder.handoffId, handoffPath: holder.handoffPath,
        writtenDigest: holder.writtenDigest,
        readBackDigest: now.status === 'OK' ? now.digest : 'unreadable',
        equal: now.status === 'OK' && now.digest === holder.writtenDigest,
      });
      refs[step.as || step.ref] = { ...holder, readback: rec };
      observed.steps.push({ i, do: step.do, equal: rec.equal });
      continue;
    }

    if (step.do === 'consume-handoff') {
      const holder = refs[step.ref];
      if (!holder) { note(`${label}: no handoff named ${step.ref}`); continue; }
      const r = handoff.consume(dir, holder.handoffId, { consumerId: step.consumerId });
      mm.journalConsumption({ handoffId: holder.handoffId, status: r.status, consumerId: step.consumerId, receiptPath: r.receiptPath || null });
      observed.consumptions.push({
        status: r.status,
        pointsToFirst: Boolean(r.firstConsumption && r.firstConsumption.consumedAt),
        firstConsumerId: (r.firstConsumption && r.firstConsumption.consumerId) || null,
        failureCode: (r.failure && r.failure.code) || null,
      });
      if (step.expectStatus && r.status !== step.expectStatus) note(`${label}: expected consume ${step.expectStatus}, observed ${r.status}`);
      continue;
    }

    if (step.do === 'latch') {
      const read = thresholds.readLatches(dir);
      const forCycle = thresholds.forCycle(read.record, mm.cycleId());
      thresholds.writeLatches(dir, thresholds.latch(forCycle.record, step.threshold, { atPercent: step.atPercent }));
      observed.steps.push({ i, do: step.do, threshold: step.threshold, rearmed: forCycle.rearmed });
      continue;
    }

    if (step.do === 'apply') {
      const event = {
        transition: step.transition,
        eventId: step.eventId,
        evidence: resolve(step.evidence || []),
        ...(step.failureCode ? { failureCode: step.failureCode } : {}),
        ...(step.detail ? { detail: step.detail } : {}),
      };
      const r = mm.apply(event);
      observed.steps.push({ i, do: 'apply', transition: step.transition, status: r.status, state: r.state, failure: (r.failure && r.failure.code) || null });
      if (!observed.statesEntered.includes(r.state)) observed.statesEntered.push(r.state);
      if (r.cycleId && !observed.cycleIds.includes(r.cycleId)) observed.cycleIds.push(r.cycleId);

      if (step.expectStatus && r.status !== step.expectStatus) {
        note(`${label}: expected ${step.transition} to be ${step.expectStatus}, observed ${r.status}${r.failure ? ` (${r.failure.code})` : ''}`);
      }
      if (step.expectFailure) {
        const code = (r.failure && r.failure.code) || null;
        if (code !== step.expectFailure) note(`${label}: expected failure ${step.expectFailure}, observed ${code}`);
      }
      continue;
    }

    note(`${label}: unknown step kind ${JSON.stringify(step.do)}`);
  }

  const mm = ensure();
  if (mm) {
    observed.finalState = mm.state();
    observed.haltCode = mm.halted() ? mm.halted().code : null;
    observed.haltOutcome = mm.halted() ? mm.halted().outcome : null;
    observed.recovery = mm.halted() ? mm.halted().recovery : null;
    observed.outcome = mm.outcome();
    observed.counts = mm.counts();
    observed.cycleAdvances = mm.cycleAdvances().length;
    observed.cycleIndex = mm.cycleIndex();
    observed.rows = mm.rows();
    observed.journalKinds = [...new Set(observed.rows.map((r) => r.kind))];
    observed.transitionsApplied = observed.rows.filter((r) => r.kind === journal.ROW_KINDS.TRANSITION).map((r) => r.transition);
    observed.rolloverOutcome = rolloverOutcome(observed);

    const lat = thresholds.readLatches(dir);
    const fc = thresholds.forCycle(lat.record, mm.cycleId());
    observed.latchesAfter = { rearmed: fc.rearmed, latched: Object.keys(fc.record.latched) };
  }

  compare(trace.expect || {}, observed, note);
  return { trace: trace.id, class: trace.class, ok: mismatches.length === 0, mismatches, observed };
}

/** The rollover's own verdict, derived from what actually landed in the journal. */
function rolloverOutcome(observed) {
  if (observed.haltCode) return 'HALTED';
  const applied = observed.transitionsApplied || [];
  if (applied.includes('verify-identity')) return 'ROLLED_OVER';
  if (applied.includes('noop-return')) return 'NO_OP_NO_COMPACTION';
  return 'INCOMPLETE';
}

function compare(expect, observed, note) {
  const eq = (key, actual) => {
    if (expect[key] === undefined) return;
    if (actual !== expect[key]) note(`expected ${key}=${JSON.stringify(expect[key])}, observed ${JSON.stringify(actual)}`);
  };
  eq('finalState', observed.finalState);
  eq('outcome', observed.outcome);
  eq('haltCode', observed.haltCode);
  eq('haltOutcome', observed.haltOutcome);
  eq('rolloverOutcome', observed.rolloverOutcome);
  eq('cycleAdvances', observed.cycleAdvances);
  eq('cycleIndex', observed.cycleIndex);

  if (expect.counts) {
    for (const [k, v] of Object.entries(expect.counts)) {
      if (!observed.counts || observed.counts[k] !== v) note(`expected counts.${k}=${v}, observed ${observed.counts ? observed.counts[k] : 'nothing'}`);
    }
  }
  if (expect.neverEntered) {
    for (const s of expect.neverEntered) {
      if ((observed.statesEntered || []).includes(s)) note(`the machine entered ${s}, which this trace forbids`);
    }
  }
  if (expect.journalKinds) {
    for (const k of expect.journalKinds) {
      if (!(observed.journalKinds || []).includes(k)) note(`the journal has no ${k} row`);
    }
  }
  if (expect.transitionsApplied) {
    const actual = (observed.transitionsApplied || []).join(',');
    const wanted = expect.transitionsApplied.join(',');
    if (actual !== wanted) note(`expected applied transitions [${wanted}], observed [${actual}]`);
  }
  if (expect.consumptions) {
    expect.consumptions.forEach((want, i) => {
      const got = (observed.consumptions || [])[i];
      if (!got) { note(`expected a consumption at index ${i} and there was none`); return; }
      for (const [k, v] of Object.entries(want)) {
        if (got[k] !== v) note(`consumption ${i}: expected ${k}=${JSON.stringify(v)}, observed ${JSON.stringify(got[k])}`);
      }
    });
  }
  if (expect.latchesAfter) {
    const got = observed.latchesAfter || {};
    if (expect.latchesAfter.rearmed !== undefined && got.rearmed !== expect.latchesAfter.rearmed) {
      note(`expected latchesAfter.rearmed=${expect.latchesAfter.rearmed}, observed ${got.rearmed}`);
    }
    if (expect.latchesAfter.latched) {
      const a = (got.latched || []).slice().sort().join(',');
      const b = expect.latchesAfter.latched.slice().sort().join(',');
      if (a !== b) note(`expected latchesAfter.latched=[${b}], observed [${a}]`);
    }
  }
  if (expect.recoveryMentions) {
    const text = String(observed.recovery || '');
    for (const needle of expect.recoveryMentions) {
      if (!text.toLowerCase().includes(String(needle).toLowerCase())) {
        note(`the halt's recovery instruction does not mention ${JSON.stringify(needle)} — a code with no actionable instruction is a label`);
      }
    }
  }
}

/** Load every fixture from a directory. Ids are checked against a DECLARED list by the suite. */
function loadFixtures(dirPath) {
  return fs.readdirSync(dirPath)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => ({ file: f, trace: JSON.parse(fs.readFileSync(path.join(dirPath, f), 'utf8')) }));
}

module.exports = { replay, loadFixtures, rolloverOutcome, STATES: states.STATES };
