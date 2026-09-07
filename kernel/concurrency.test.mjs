/*
 * RespawnPack · kernel/concurrency.test.mjs — what the atomic write and the lock actually guarantee.
 *
 * ⛔ WHY THIS SUITE EXISTS. `HANDOFF.json` carried this line under Phase 2 for the whole program:
 * "atomic-write and lock behavior is IMPLEMENTED (state.writeAtomic, _runtime.withLock) but not yet
 * independently fuzz/concurrency-tested at the kernel layer". Implemented-but-unproven is the exact
 * state this program exists to end, and a four-line function that says `atomic` in its own comment is
 * the easiest possible place to stop looking.
 *
 * ⛔ AND THE RULE THIS SUITE OBEYS, LEARNED FROM THIS REPOSITORY'S OWN FLAKE. Two fixtures in
 * hooks/hooks.test.mjs once claimed concurrency and called `spawnSync` inside `setImmediate` —
 * spawnSync BLOCKS the event loop, so "twelve concurrent children" ran strictly one after another and
 * the claim was unearned. Every fixture here that says CONTENTION launches real child processes
 * asynchronously and holds them behind a shared start timestamp, so they collide for real. A race that
 * only appears under contention cannot be demonstrated by a test that never creates any.
 *
 * ⛔ WHAT IS *NOT* RE-PROVEN HERE, DELIBERATELY. The lock under `_index-lease.js` already has real
 * multiprocess contention coverage, and duplicating it would add a second fixture that can rot
 * independently of the first. `describe('the lock — evidence that already exists')` REFERENCES that
 * coverage by asserting the fixtures are still present and still spawn real children; only the one
 * genuinely uncovered guarantee (a callback exception must not be swallowed) is added.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// The REAL step-16 gate — the same object ops/release-smoke.mjs judges its run with. Feeding shapes
// to a copy would let the fence and the smoke drift apart, which is how the last two step-16 defects
// shipped.
import { evaluateStep16, unionOfObservedHashes } from '../ops/_smoke16-gate.mjs';

const KERNEL = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(KERNEL);
const STATE_JS = path.join(KERNEL, 'lib', 'state.js');
const RUNTIME_JS = path.join(ROOT, 'hooks', '_runtime.js');
const LEASE_JS = path.join(ROOT, 'hooks', '_index-lease.js');
const HOOKS_SUITE = path.join(ROOT, 'hooks', 'hooks.test.mjs');

const require_ = createRequire(import.meta.url);
const cjsFs = require_('fs');
const stateLib = require_(STATE_JS);

const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
const read = (p) => fs.readFileSync(p, 'utf8');
const tmpdir = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `rp-conc-${tag}-`));
const rm = (d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } };

/**
 * Run `scripts` as real child processes, all released by one shared wall-clock instant.
 *
 * The barrier is a busy-wait on a timestamp rather than an IPC handshake on purpose: a handshake
 * serialises through this process's event loop, which is precisely the mistake that made the earlier
 * "concurrent" fixtures sequential.
 */
async function race(scripts, leadMs = 1200) {
  const startAt = Date.now() + leadMs;
  return Promise.all(scripts.map((make) => new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', make(startAt)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => resolve({ code, out: out.trim(), err: err.trim() }));
  })));
}

const J = JSON.stringify;

/*
 * Payloads are large on purpose. A 2 MB write is many syscalls; a direct write to the destination
 * leaves the target observably truncated and half-filled for a measurable window, which is exactly
 * what makes the mutation "write straight to the destination" killable. A small payload would land in
 * one write on most filesystems and the fixture would pass against the defect it exists to catch.
 */
const PAYLOAD_BYTES = 1024 * 1024;
const payloadFor = (n) => J({ writer: n, filler: String(n).repeat(PAYLOAD_BYTES / 8) });

// ---------------------------------------------------------------------------------------------
describe('writeAtomic · readers never observe a partial, mixed or absent target', () => {
  test('⛔ 6 writers and 3 readers, released together: every read is exactly one writer payload', async () => {
    const dir = tmpdir('tear');
    const target = path.join(dir, 'nested', 'STATE.json');
    const WRITERS = 6, READERS = 3, WINDOW_MS = 3000;

    const payloads = Array.from({ length: WRITERS }, (_, i) => payloadFor(i));
    const known = new Set(payloads.map(sha));

    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, payloads[0]); // seeded, so ENOENT is a VIOLATION and not a startup artifact

    // ⛔ The payloads reach the children through FILES, never through the command line. Embedding 2 MB
    // in `node -e` is `spawn ENAMETOOLONG` — which the first version of this fixture did, and which
    // fails the whole test in 60ms with a spawn error that looks nothing like a torn read.
    const srcOf = (i) => path.join(dir, `payload-${i}.bin`);
    payloads.forEach((p, i) => fs.writeFileSync(srcOf(i), p));

    try {
      /*
       * ⛔ A WRITER REPORTS A REFUSED REPLACEMENT; IT DOES NOT DIE OF ONE — and modelling that is the
       * point, not a convenience. On Windows a rename over a destination that another process
       * currently holds open returns ERROR_ACCESS_DENIED, and `fs.readFileSync` does not open with
       * FILE_SHARE_DELETE. Under SUSTAINED concurrent reads the bounded retry can therefore exhaust,
       * and `writeAtomic` throws. That is the correct outcome — the caller is told, and the previous
       * file is intact — but a fixture that counted it as a crash would be asserting a guarantee no
       * atomic-replace primitive can give on that platform.
       *
       * What is still asserted absolutely: no reader ever sees a torn, mixed or absent target.
       */
      const writer = (i) => (startAt) =>
        `const st=require(${J(STATE_JS)});` +
        `const p=require("fs").readFileSync(${J(srcOf(i))},"utf8");let n=0;const refused=[];` +
        `while(Date.now()<${startAt});` +
        `while(Date.now()<${startAt}+${WINDOW_MS}){` +
        `  try{st.writeAtomic(${J(target)},p);n++;}catch(e){refused.push(e.code||"UNKNOWN");}` +
        '}' +
        'process.stdout.write(JSON.stringify({writes:n,refused}));';

      /*
       * The readers are PACED by one millisecond. Not to be gentle: an unpaced spin holds the
       * destination open essentially continuously, which starves every replacement and measures the
       * platform rather than the code. One millisecond still lands many reads inside every 1 MB write,
       * so a direct write to the destination is still caught torn — verified by running the mutation.
       */
      const reader = () => (startAt) =>
        'const fs=require("fs"),crypto=require("crypto");' +
        'const pause=()=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1);' +
        `while(Date.now()<${startAt});` +
        'const seen=new Set();let reads=0;const bad=[];' +
        `while(Date.now()<${startAt}+${WINDOW_MS}){` +
        '  let t;' +
        `  try{t=fs.readFileSync(${J(target)},"utf8");}catch(e){bad.push("read:"+e.code);pause();continue;}` +
        '  reads++;' +
        '  seen.add(crypto.createHash("sha256").update(t).digest("hex"));' +
        '  pause();' +
        '}' +
        'process.stdout.write(JSON.stringify({reads,seen:[...seen],bad}));';

      const results = await race([
        ...Array.from({ length: WRITERS }, (_, i) => writer(i)),
        ...Array.from({ length: READERS }, () => reader()),
      ]);

      for (const r of results) assert.equal(r.code, 0, `a child died: ${r.err || r.out}`);

      const writes = results.slice(0, WRITERS).map((r) => JSON.parse(r.out).writes);
      const reads = results.slice(WRITERS).map((r) => JSON.parse(r.out));

      /*
       * ⛔ VACUITY GUARDS FIRST. Without them the fixture passes when nothing overlapped — a reader
       * that ran after every writer finished sees one clean payload and proves precisely nothing.
       *
       * The guards are on the AGGREGATE and on what the readers OBSERVED, not on a per-writer round
       * count: under six-way contention for one file the slowest writer can legitimately land a single
       * replacement in the window, and a fixture that fails for that is measuring the host's disk
       * rather than the guarantee.
       */
      for (const [i, w] of writes.entries()) assert.ok(w >= 1, `writer ${i} completed no write at all`);
      const totalWrites = writes.reduce((a, w) => a + w, 0);
      assert.ok(totalWrites >= WRITERS + 4, `only ${totalWrites} replacements across ${WRITERS} writers — too few to have overlapped`);

      // A refusal is legitimate (see the writer's note) but it must be a REPORTED one, with a code —
      // never a silent no-op that a caller would read as a completed write.
      const refusals = results.slice(0, WRITERS).flatMap((r) => JSON.parse(r.out).refused);
      const silent = refusals.filter((c) => !c || c === 'UNKNOWN');
      assert.deepEqual(silent, [], `a replacement failed without a diagnosable code (${silent.length} of ${refusals.length})`);
      const totalReads = reads.reduce((a, r) => a + r.reads, 0);
      assert.ok(totalReads >= 20, `readers only completed ${totalReads} read(s) — they did not overlap the writers`);
      const allSeen = new Set(reads.flatMap((r) => r.seen));
      assert.ok(allSeen.size >= 2, `readers only ever saw ${allSeen.size} distinct content(s) — the window did not span a replacement`);

      /*
       * ⛔ THE GUARANTEE, AS NARROWED. This assertion used to be `deepEqual(unreadable, [])` — that
       * every read succeeds — and it was FALSE. An external gate ran this fixture five times on
       * Windows and saw one `read:EPERM` and nine `read:ENOENT`; the same shape reproduces here under
       * pressure. `MoveFileEx` does not promise a concurrent OPEN will succeed.
       *
       * What is asserted instead is what the primitive actually gives and what has never once failed:
       * every read that SUCCEEDS returns exactly one writer's payload. Transient failures are counted
       * and reported rather than silently tolerated — and a SEPARATE fixture below proves the pack's
       * own retrying reader turns them into old-or-new, which is where that guarantee really lives.
       */
      const unreadable = reads.flatMap((r) => r.bad);
      const unexpected = unreadable.filter((b) => !/^read:(ENOENT|EPERM|EACCES|EBUSY)$/.test(b));
      assert.deepEqual(unexpected, [],
        `a raw reader failed for a reason the narrowed contract does not cover: ${unexpected.join(', ')}`);
      if (unreadable.length) {
        // Visible, never swallowed: this is the platform behaviour the contract now names.
        console.log(`      note: ${unreadable.length} transient raw-read failure(s) observed — ${[...new Set(unreadable)].join(', ')}`);
      }
      const foreign = [...allSeen].filter((d) => !known.has(d));
      assert.deepEqual(foreign, [], `readers observed content that is not any single writer's payload — ${foreign.length} torn or mixed state(s)`);

      // And the survivor is one complete payload, valid for the format that was written.
      const final = read(target);
      assert.ok(known.has(sha(final)), 'the final file is not byte-identical to any one writer payload');
      assert.doesNotThrow(() => JSON.parse(final), 'the final file is not valid JSON');
    } finally { rm(dir); }
  });

  test('⛔ the PACK\'S OWN reader never observes the target as absent or unreadable under the same contention', async () => {
    /*
     * This is where "old or new, always readable" actually lives. The primitive gives content
     * atomicity; `hooks/_artifact.js` gives availability, by separating "not there" from "not there
     * YET" with a bounded retry. Both readers run against the SAME writers in the SAME window, so the
     * comparison is a controlled one rather than two runs under different conditions.
     *
     * The failure this prevents is not cosmetic: `readDurableState` mapped a transient null to
     * `status: 'ABSENT'`, and `readContract` mapped it to a goal-mode session with no constraints and
     * no forbidden actions. A sub-millisecond race became a sentence about the project, and a lost
     * prohibition.
     */
    const dir = tmpdir('retryread');
    const target = path.join(dir, 'STATE.json');
    const ARTIFACT_JS = path.join(ROOT, 'hooks', '_artifact.js');
    const WRITERS = 6, WINDOW_MS = 2500;
    const payloads = Array.from({ length: WRITERS }, (_, i) => J({ writer: i, filler: String(i).repeat(PAYLOAD_BYTES / 8) }));
    const known = new Set(payloads.map(sha));
    fs.mkdirSync(dir, { recursive: true });
    const srcOf = (i) => path.join(dir, `payload-${i}.bin`);
    payloads.forEach((p, i) => fs.writeFileSync(srcOf(i), p));
    fs.writeFileSync(target, payloads[0]);

    try {
      const writer = (i) => (startAt) =>
        `const st=require(${J(STATE_JS)});` +
        `const p=require("fs").readFileSync(${J(srcOf(i))},"utf8");let n=0;` +
        `while(Date.now()<${startAt});` +
        `while(Date.now()<${startAt}+${WINDOW_MS}){try{st.writeAtomic(${J(target)},p);n++;}catch{}}` +
        'process.stdout.write(JSON.stringify({writes:n}));';

      // Two readers of the SAME target: one raw, one through the pack's boundary.
      const rawReader = () => (startAt) =>
        'const fs=require("fs");const pause=()=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1);' +
        `while(Date.now()<${startAt});let reads=0;const bad=[];` +
        `while(Date.now()<${startAt}+${WINDOW_MS}){try{fs.readFileSync(${J(target)},"utf8");reads++;}catch(e){bad.push(e.code||"UNKNOWN");}pause();}` +
        'process.stdout.write(JSON.stringify({kind:"raw",reads,bad}));';

      const packReader = () => (startAt) =>
        `const a=require(${J(ARTIFACT_JS)});const crypto=require("crypto");` +
        'const pause=()=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1);' +
        `while(Date.now()<${startAt});let reads=0;const bad=[];const seen=new Set();` +
        `while(Date.now()<${startAt}+${WINDOW_MS}){` +
        `  const r=a.readTextClassified(${J(target)});` +
        '  if(r.status==="OK"){reads++;seen.add(crypto.createHash("sha256").update(r.text).digest("hex"));}' +
        '  else bad.push(r.status);pause();}' +
        'process.stdout.write(JSON.stringify({kind:"pack",reads,bad,seen:[...seen]}));';

      const results = await race([
        ...Array.from({ length: WRITERS }, (_, i) => writer(i)),
        rawReader(), rawReader(), packReader(), packReader(),
      ]);
      for (const r of results) assert.equal(r.code, 0, `a child died: ${r.err || r.out}`);

      const writes = results.slice(0, WRITERS).map((r) => JSON.parse(r.out).writes);
      const readers = results.slice(WRITERS).map((r) => JSON.parse(r.out));
      const raw = readers.filter((r) => r.kind === 'raw');
      const pack = readers.filter((r) => r.kind === 'pack');

      // Vacuity first: replacements must actually have happened while both readers were running.
      assert.ok(writes.reduce((a, b) => a + b, 0) >= WRITERS, `only ${writes.reduce((a, b) => a + b, 0)} replacement(s) — no contention to observe`);
      assert.ok(pack.reduce((a, r) => a + r.reads, 0) >= 20, 'the pack reader barely ran — it did not overlap the writers');

      const rawFailures = raw.flatMap((r) => r.bad);
      const packFailures = pack.flatMap((r) => r.bad);

      // ⛔ THE ASSERTION THAT MATTERS. The pack's reader must never report ABSENT or UNREADABLE for a
      // file that is being continuously replaced and therefore always exists.
      assert.deepEqual(packFailures, [],
        `the pack's own reader reported ${packFailures.join(', ')} for a target that existed throughout — `
        + 'a present artifact classified as missing is exactly the defect the retry exists to remove');

      // And every payload it did read is a complete one.
      const foreign = pack.flatMap((r) => r.seen).filter((d) => !known.has(d));
      assert.deepEqual(foreign, [], 'the pack reader observed content that is not any one writer payload');

      console.log(`      raw reader: ${raw.reduce((a, r) => a + r.reads, 0)} read(s), ${rawFailures.length} transient failure(s) `
        + `[${[...new Set(rawFailures)].join(',') || 'none this run'}] · pack reader: ${pack.reduce((a, r) => a + r.reads, 0)} read(s), 0 failures`);
    } finally { rm(dir); }
  });

  test('⛔ a transient ENOENT is NOT absence — deterministically, not when the race happens to hit', () => {
    /*
     * The contention fixture above can only observe this when a replacement window is actually caught,
     * which is intermittent by nature: a mutation that removed the retry SURVIVED a full run of this
     * suite because no ENOENT happened to occur. An intermittently-discriminating fixture is not a
     * fence. So the window is injected instead of waited for, and the two directions are asserted
     * separately: a file that reappears was never gone, and a file that stays gone is gone.
     */
    const dir = tmpdir('enoent');
    const target = path.join(dir, 'STATE.json');
    fs.writeFileSync(target, '{"present":true}');
    const art = require_(path.join(ROOT, 'hooks', '_artifact.js'));
    const real = cjsFs.readFileSync;
    try {
      let injected = 0;
      cjsFs.readFileSync = function readFileSync(p, ...rest) {
        if (String(p) === target && injected < 3) {
          injected += 1;
          const e = new Error('ENOENT: no such file or directory'); e.code = 'ENOENT'; throw e;
        }
        return real.call(this, p, ...rest);
      };
      const r = art.readTextClassified(target);
      assert.equal(injected, 3, 'the fixture never injected the window, so it proves nothing');
      assert.equal(r.status, 'OK',
        'a file that was present the whole time was reported as ABSENT because three reads landed inside a replacement window. '
        + 'That is the defect: `readDurableState` turned exactly this into "this project has no compiled state".');
      assert.equal(r.text, '{"present":true}');
      assert.ok(r.attempts >= 4, `expected the read to have been retried, saw ${r.attempts} attempt(s)`);
    } finally { cjsFs.readFileSync = real; }

    try {
      // ⛔ THE CONTROL. Without it, a reader that simply never reports ABSENT would pass the above.
      const gone = art.readTextClassified(path.join(dir, 'does-not-exist.json'));
      assert.equal(gone.status, 'ABSENT', 'a genuinely absent file must still be ABSENT — retrying is not the same as never answering');
      assert.match(gone.detail, /not present after \d+ attempt/);
    } finally { rm(dir); }
  });

  test('a file that EXISTS but stays locked is UNREADABLE, never ABSENT', () => {
    // The third answer. Collapsing this into ABSENT would tell a project it has no state when what it
    // has is a permissions problem — and the two have opposite remedies.
    const dir = tmpdir('locked');
    const target = path.join(dir, 'STATE.json');
    fs.writeFileSync(target, '{}');
    const art = require_(path.join(ROOT, 'hooks', '_artifact.js'));
    const real = cjsFs.readFileSync;
    let injected = 0;
    cjsFs.readFileSync = function readFileSync(p, ...rest) {
      if (String(p) === target) { injected += 1; const e = new Error('EPERM'); e.code = 'EPERM'; throw e; }
      return real.call(this, p, ...rest);
    };
    try {
      const r = art.readTextClassified(target);
      assert.ok(injected > 1, 'a locked file was not retried at all');
      assert.equal(r.status, 'UNREADABLE', `a persistently locked file reported ${r.status}`);
      assert.match(r.detail, /EXISTS but stayed unreadable/);
    } finally { cjsFs.readFileSync = real; rm(dir); }
  });

  test('parent-directory creation is safe when 8 first writes race into a directory that does not exist', async () => {
    const dir = tmpdir('mkdir');
    const target = path.join(dir, 'a', 'b', 'c', 'first.json');
    const payloads = Array.from({ length: 8 }, (_, i) => J({ writer: i }));
    const known = new Set(payloads.map(sha));
    try {
      const results = await race(payloads.map((p) => (startAt) =>
        `const st=require(${J(STATE_JS)});` +
        `while(Date.now()<${startAt});` +
        `st.writeAtomic(${J(target)},${J(p)});` +
        'process.stdout.write("OK");'));

      const failed = results.filter((r) => r.code !== 0);
      assert.deepEqual(failed.map((r) => r.err), [], 'a concurrent first write raced mkdir and threw');
      assert.ok(known.has(sha(read(target))), 'the file left behind is not one complete payload');
    } finally { rm(dir); }
  });
});

// ---------------------------------------------------------------------------------------------
describe('the release smoke\'s concurrency predicate rejects a sequential run and the timing-only shape', () => {
  /*
   * ⛔ THE CONTROL FOR TWO DEFECTS THAT SHIPPED IN THE SAME STEP.
   *
   * FIRST: `ops/release-smoke.mjs` step 16 called `spawnSync` inside `payloads.map()`. spawnSync
   * BLOCKS, so child 0 consumed the whole timed window and children 1-4 started after it closed,
   * executed their loop body zero times, and exited 0. The shipped output said so plainly —
   * `writes=1445,0,0,0,0` — and the predicate passed, because it only required every child to exit 0
   * and the survivor to be a complete payload.
   *
   * SECOND (the b2b1d0b audit): the concurrent rewrite was only TIMING-synchronized — a shared future
   * timestamp, readers seeded with writer 0's own payload, and `Math.max` over per-reader distinct
   * COUNTS. One audited run at unchanged b2b1d0b scored `distinctPayloadsSeen=1` with 194 valid reads
   * and every writer landing; two later runs passed. An intermittent gate is not a gate. Step 16 now
   * runs a sentinel/READY/GO protocol judged by ops/_smoke16-gate.mjs, and THIS fixture feeds that
   * same gate both the audited failure shape (must refuse) and the protocol shape (must accept) —
   * deterministically, so the rejection of the old shape is not itself a matter of timing.
   *
   * This runs the SAME children both ways and asserts the corrected predicate separates them. Without
   * it, "the smoke is concurrent now" would be a claim about a diff rather than about behaviour.
   */
  const WRITERS = 4, WINDOW_MS = 700;

  function children(dir, startAt) {
    const target = path.join(dir, 'STATE.json');
    return Array.from({ length: WRITERS }, (_, i) =>
      `const st=require(${J(STATE_JS)});const p=${J(J({ writer: i, filler: String(i).repeat(20000) }))};` +
      `while(Date.now()<${startAt});let n=0;` +
      `while(Date.now()<${startAt}+${WINDOW_MS}){try{st.writeAtomic(${J(target)},p);n++;}catch{}}` +
      'process.stdout.write(JSON.stringify({n}));');
  }
  // The smoke's own non-vacuity requirement, applied to a writes vector.
  const everyWriterWrote = (writes) => writes.every((n) => n >= 1);

  test('sequential spawnSync leaves every writer but the first at ZERO, and the predicate FAILS', () => {
    const dir = tmpdir('seq');
    try {
      fs.writeFileSync(path.join(dir, 'STATE.json'), '{}');
      const startAt = Date.now() + 500;
      // Exactly the shipped defect: spawnSync inside a map.
      const writes = children(dir, startAt).map((src) => {
        const r = spawnSync(process.execPath, ['-e', src], { encoding: 'utf8', timeout: 60000 });
        try { return JSON.parse(r.stdout).n; } catch { return -1; }
      });
      assert.ok(writes[0] >= 1, `the first child did no work either — the fixture is not exercising the shape (${writes.join(',')})`);
      assert.ok(writes.slice(1).some((n) => n === 0),
        `sequential spawnSync did NOT starve the later children on this host (${writes.join(',')}) — the control cannot demonstrate the defect`);
      assert.equal(everyWriterWrote(writes), false,
        `the release smoke's predicate ACCEPTED a sequential run (${writes.join(',')}) — it would pass step 16 with one writer, exactly as it did before`);

      /*
       * ⛔ AND THE GATE REJECTS THE AUDITED TIMING-ONLY SHAPE, DETERMINISTICALLY. The b2b1d0b failed
       * run had every writer landing, 194 valid reads, zero read failures — and one observed payload,
       * with no sentinel in the protocol at all. That exact report must refuse, whatever the timing.
       */
      const H = { sentinel: 'h-sentinel', p: ['h-p0', 'h-p1', 'h-p2', 'h-p3', 'h-p4'] };
      const auditRun = evaluateStep16({
        exits: [0, 0, 0, 0, 0, 0, 0],
        writers: [{ n: 1, refused: [] }, { n: 7, refused: [] }, { n: 7, refused: [] }, { n: 7, refused: [] }, { n: 1, refused: [] }],
        readers: [
          { reads: 97, bad: [], hashes: [H.p[0]], sentinelConfirmed: false, sawWriterPayload: false },
          { reads: 97, bad: [], hashes: [H.p[0]], sentinelConfirmed: false, sawWriterPayload: false },
        ],
        sentinelHash: H.sentinel, writerHashes: H.p, finalHash: H.p[3], temps: 0,
      });
      assert.equal(auditRun.pass, false,
        'the corrected gate ACCEPTED the audited failure shape — every writer landed and every read was valid, but nothing proved a reader watched writer activity');
      assert.ok(auditRun.failures.some((f) => /sentinel/.test(f)),
        'the refusal must name the missing sentinel observation — the thing that separates "watched before and during" from timing luck');

      // The old aggregation, applied to a run that genuinely displayed two payloads across readers:
      // Math.max over per-reader counts scores it 1; the union scores it 2. That arithmetic is the
      // audited defect, demonstrated rather than described.
      const splitAcrossReaders = [{ hashes: [H.sentinel] }, { hashes: [H.p[1]] }];
      assert.equal(Math.max(...splitAcrossReaders.map((r) => r.hashes.length), 0), 1,
        'the demonstration input no longer reproduces the max-vs-union gap');
      assert.equal(unionOfObservedHashes(splitAcrossReaders).size, 2,
        'the union of the same reports is 2 — Math.max(reader.distinct) scored a two-payload run as one');
    } finally { rm(dir); }
  });

  test('barrier-released concurrent children all land, and the predicate PASSES', async () => {
    const dir = tmpdir('conc');
    try {
      fs.writeFileSync(path.join(dir, 'STATE.json'), '{}');
      const results = await race(children(dir, 0).map((src) => (startAt) => src.replace(/Date\.now\(\)<0/g, `Date.now()<${startAt}`).replace(/<0\+/g, `<${startAt}+`)), 700);
      for (const r of results) assert.equal(r.code, 0, `a child died: ${r.err}`);
      const writes = results.map((r) => { try { return JSON.parse(r.out).n; } catch { return -1; } });
      assert.equal(everyWriterWrote(writes), true,
        `a genuinely concurrent run produced a writer that never wrote (${writes.join(',')}) — the predicate would be unsatisfiable`);

      /*
       * And the gate ACCEPTS the protocol shape — including the case the old arithmetic scored wrong:
       * no single reader saw two writer payloads (per-reader max would say 1), but the cross-reader
       * union carries the sentinel and two different writer payloads. Union, never max.
       */
      const H = { sentinel: 'h-sentinel', p: ['h-p0', 'h-p1', 'h-p2', 'h-p3', 'h-p4'] };
      const healthy = evaluateStep16({
        exits: [0, 0, 0, 0, 0, 0, 0],
        writers: Array.from({ length: 5 }, () => ({ n: 3, refused: [] })),
        readers: [
          { reads: 12, bad: [], hashes: [H.sentinel, H.p[2]], sentinelConfirmed: true, sawWriterPayload: true },
          { reads: 9, bad: [], hashes: [H.sentinel, H.p[4]], sentinelConfirmed: true, sawWriterPayload: true },
        ],
        sentinelHash: H.sentinel, writerHashes: H.p, finalHash: H.p[4], temps: 0,
      });
      assert.equal(healthy.pass, true, `the gate refused a protocol-clean run: ${healthy.failures.join(' · ')}`);
      assert.equal(healthy.distinctObserved, 3,
        'the union across readers is 3 (sentinel + two writer payloads) — a per-reader maximum would have reported 2');
    } finally { rm(dir); }
  });
});

// ---------------------------------------------------------------------------------------------
describe('writeAtomic · a failure before replacement changes nothing and leaves nothing behind', () => {
  /**
   * Failure is injected by replacing `fs.renameSync` on the CommonJS `fs` module object that
   * `kernel/lib/state.js` itself holds. No production seam is added for testability: the module under
   * test is unmodified, and the same idiom already carries hooks/hooks.test.mjs's EPERM fixtures.
   */
  function withFailingRename(code, fn) {
    const real = cjsFs.renameSync;
    let calls = 0;
    cjsFs.renameSync = function renameSync() { calls += 1; const e = new Error(`${code}: injected`); e.code = code; throw e; };
    try { return fn(() => calls); } finally { cjsFs.renameSync = real; }
  }

  test('the prior target survives byte-for-byte, and the real error is not masked', () => {
    const dir = tmpdir('preserve');
    const target = path.join(dir, 'STATE.json');
    const before = J({ generation: 'first', keep: 'every byte' }) + '\n';
    fs.writeFileSync(target, before);
    try {
      withFailingRename('EIO', (calls) => {
        assert.throws(() => stateLib.writeAtomic(target, J({ generation: 'second' })),
          /EIO/, 'a replacement failure must propagate — a silent one is a lost write reported as a success');
        assert.equal(calls(), 1, 'the fixture never injected the failure, so it proves nothing');
      });
      assert.equal(read(target), before, 'the previous target was not preserved byte-for-byte');
    } finally { rm(dir); }
  });

  test('⛔ 25 failed writes leave ZERO temporary files — a failing write must not accrete', () => {
    const dir = tmpdir('litter');
    const target = path.join(dir, 'STATE.json');
    fs.writeFileSync(target, '{}\n');
    try {
      // EIO is deliberately NOT a contention code, so each attempt fails immediately instead of
      // burning the retry deadline. The retryable path is covered separately below.
      withFailingRename('EIO', (calls) => {
        for (let i = 0; i < 25; i += 1) {
          try { stateLib.writeAtomic(target, J({ attempt: i })); } catch { /* expected */ }
        }
        assert.ok(calls() >= 25, `expected at least 25 injected failures, got ${calls()}`);
      });
      // And once through the RETRYABLE path too: a write that exhausts the deadline must clean up on
      // the same terms as one that fails at the first syscall.
      withFailingRename('EPERM', (calls) => {
        try { stateLib.writeAtomic(target, J({ attempt: 'exhausted' })); } catch { /* expected */ }
        assert.ok(calls() > 1, 'the retryable code was not actually retried, so this half proves nothing');
      });
      const left = fs.readdirSync(dir).filter((f) => f !== 'STATE.json');
      assert.deepEqual(left, [], `a failed write left temporary files behind: ${left.join(', ')}`);
      assert.equal(read(target), '{}\n', 'the target moved despite every replacement failing');
    } finally { rm(dir); }
  });

  test('a transient EPERM on replacement is retried, not reported as a lost write', () => {
    const dir = tmpdir('retry');
    const target = path.join(dir, 'STATE.json');
    fs.writeFileSync(target, '{"generation":"first"}\n');
    const real = cjsFs.renameSync;
    let injected = 0;
    cjsFs.renameSync = function renameSync(...a) {
      if (injected < 2) { injected += 1; const e = new Error('EPERM: injected'); e.code = 'EPERM'; throw e; }
      return real.apply(this, a);
    };
    try {
      /*
       * ⛔ THE SAME LESSON hooks/_index-lease.js RECORDED FOR LOCK CREATION, ONE SYSCALL OVER. Windows
       * answers "this target is momentarily open" with ERROR_ACCESS_DENIED, which Node surfaces as
       * EPERM — indistinguishable, at the call site, from a permanent permission fault. Treating the
       * first one as fatal turns an ordinary replacement under a concurrent reader (or an antivirus
       * scan) into a failed write. Retrying does not weaken anything: a genuine fault still fails, a
       * few milliseconds later, with the same error.
       */
      stateLib.writeAtomic(target, '{"generation":"second"}\n');
      assert.equal(injected, 2, 'the fixture never injected the race, so it proves nothing');
      assert.equal(read(target), '{"generation":"second"}\n', 'a retried replacement did not land');
    } finally { cjsFs.renameSync = real; rm(dir); }
  });
});

// ---------------------------------------------------------------------------------------------
describe('writeAtomic · the temporary name cannot collide', () => {
  test('two writes to ONE path from ONE process use different temporary files', () => {
    const dir = tmpdir('tmpname');
    const target = path.join(dir, 'STATE.json');
    const real = cjsFs.writeFileSync;
    const seen = [];
    cjsFs.writeFileSync = function writeFileSync(p, ...rest) { seen.push(String(p)); return real.call(this, p, ...rest); };
    try {
      stateLib.writeAtomic(target, '{"n":1}');
      stateLib.writeAtomic(target, '{"n":2}');
    } finally { cjsFs.writeFileSync = real; }
    try {
      const temps = seen.filter((p) => p !== target);
      assert.equal(temps.length, 2, `expected two temporary writes, saw ${temps.length} — the fixture did not observe the mechanism`);
      assert.notEqual(temps[0], temps[1],
        'both writes used the SAME temporary name. It reads as unique because a pid is unique among live '
        + 'processes — but that makes the name a function of the PROCESS, not of the CALL, so anything that '
        + 'shares one shares the buffer, and two writers publish a mixture.');
      for (const t of temps) assert.ok(t.startsWith(target) && t.endsWith('.tmp'), `temporary ${t} is not beside its target`);
    } finally { rm(dir); }
  });

  test('the hook tree writes the same way — its twin is hardened, not left behind', () => {
    /*
     * ⛔ ONE FUNCTION WOULD BE BETTER THAN TWO, AND IS NOT AVAILABLE HERE. `hooks/_runtime.js` cannot
     * require `kernel/lib/state.js`: in this repository the kernel is at `kernel/lib/`, and on an
     * installed target it is at `.claude/respawnpack/lib/` while the hooks are at `.claude/hooks/` —
     * the two trees do not resolve each other identically. That is the same constraint that put
     * `_manifest.js` under `hooks/` rather than in the kernel. So the twin is hardened in place and
     * FENCED here, because "the lesson was applied where it was found rather than everywhere it holds"
     * is the failure shape this program has now caught six times.
     */
    /*
     * ⛔ THE FENCE JUDGES CODE, NOT PROSE — and its first version did not. Both files now QUOTE the
     * old `${file}.${process.pid}.tmp` spelling in a comment, to explain why per-process uniqueness is
     * the trap it is. The fence matched that explanation and failed the file for describing the defect
     * it had just fixed. Comments are stripped before anything is judged.
     */
    const codeOnly = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const [label, file] of [['hooks/_runtime.js', RUNTIME_JS], ['kernel/lib/state.js', STATE_JS]]) {
      const src = codeOnly(read(file));
      assert.match(src, /\.tmp`/, `${label} no longer writes through a temporary at all — the fence below is about nothing`);
      assert.doesNotMatch(src, /`\$\{file\}\.\$\{process\.pid\}\.tmp`/,
        `${label} still derives its temporary name from the process alone`);
      assert.match(src, /tmpSeq \+= 1/, `${label}'s temporary name has no per-call component`);
      assert.match(src, /unlinkSync\(tmp\)/, `${label} does not clean up its temporary on failure`);
      assert.match(src, /REPLACE_CONTENTION_CODES/, `${label} treats a momentarily-busy destination as a permanent fault again`);
    }
  });
});

// ---------------------------------------------------------------------------------------------
describe('writeAtomic · the guarantee is stated honestly', () => {
  test('the docblock claims atomic replacement and DISCLAIMS merge and multi-file transactions', () => {
    const src = read(STATE_JS);

    // ⛔ TWO-SIDED, in the direction that matters. Policing the sentence while the mechanism is gone
    // would leave a fence quietly guarding nothing, so the mechanism is checked FIRST — the same
    // shape counts-fence.test.mjs uses for the memory-activation claim.
    assert.match(src, /function writeAtomic/, 'writeAtomic is gone; the claim below is about nothing');
    assert.match(src, /renameSync/, 'writeAtomic no longer replaces by rename, so "atomic replacement" is unearned');

    const doc = src.slice(0, src.indexOf('function writeAtomic'));
    const tail = doc.slice(doc.lastIndexOf('/*'));
    for (const [claim, re] of [
      ['atomic replacement', /atomic replacement/i],
      ['last-completed-writer wins', /last-completed-writer wins/i],
      ['NOT a merge', /not a merge/i],
      ['NOT a transactional multi-file update', /not a transactional multi-file update/i],
      ['the caller needs a lock for read-modify-write', /read-modify-write/i],
      // ⛔ The narrowing an external gate forced. The absolute form of this claim was false on
      // Windows, and the fence now requires the DISCLAIMER as firmly as it requires the guarantee —
      // otherwise the next edit quietly restores an absolute that the platform does not support.
      ['NOT atomic availability', /not atomic availability/i],
      ['a reader can observe the target absent or locked', /momentarily absent or locked/i],
      ['where old-or-new is actually delivered', /hooks\/_artifact\.js/],
    ]) {
      assert.match(tail, re, `writeAtomic's contract does not state: ${claim}`);
    }
    assert.doesNotMatch(tail, /there is no instant at which the target is (truncated, half-filled or )?absent/i,
      'the falsified absolute is back in the contract: an external gate observed read:EPERM and read:ENOENT against exactly that sentence');
  });
});

// ---------------------------------------------------------------------------------------------
describe('the lock — evidence that already exists, referenced rather than duplicated', () => {
  /*
   * `hooks/_runtime.js` withLock is ONE LINE that delegates to `hooks/_index-lease.js` withLock. The
   * hardened implementation therefore already carries these guarantees, and it is already covered by
   * REAL multiprocess fixtures. Re-proving them here would create a second fixture that can rot
   * independently. What this block does instead is make the reference unrotable: if the named coverage
   * is deleted, renamed, or quietly made sequential, this fails and says which claim lost its evidence.
   */
  const CITED = [
    ['contention never executes a critical section unlocked',
      '⛔ the lease is EXCLUSIVE under REAL contention: 12 children released together'],
    ['all updates land under real concurrency',
      'concurrent dispatches all land — no lost update'],
    ['lock acquisition failure is explicit, and a fresh foreign lock is not broken',
      'the lease fails CLOSED when exclusivity cannot be established'],
    ['a transient contention code is retried rather than reported as unestablishable',
      'a transient EPERM on the lock file is retried, not reported as unestablishable'],
    ['retrying never becomes permitting',
      'a genuinely unopenable lock still fails CLOSED — retrying must not become permitting'],
    ['stale-lock recovery is bounded and recorded',
      'an aborted writer’s lease goes stale and is reclaimed, with the reclaim recorded'],
  ];

  test('every cited lock guarantee still has a live fixture in hooks/hooks.test.mjs', () => {
    const suite = read(HOOKS_SUITE);
    for (const [claim, title] of CITED) {
      assert.ok(suite.includes(title), `the fixture cited for "${claim}" is gone: ${title}`);
    }
  });

  test('the cited contention fixtures spawn REAL children — not spawnSync in a callback', () => {
    const suite = read(HOOKS_SUITE);
    for (const title of ['⛔ the lease is EXCLUSIVE under REAL contention: 12 children released together',
      'concurrent dispatches all land — no lost update']) {
      const body = suite.slice(suite.indexOf(title), suite.indexOf(title) + 2600);
      assert.match(body, /\bspawn\(/, `${title} no longer launches asynchronous children`);
      assert.doesNotMatch(body, /setImmediate\(\s*\(\)\s*=>\s*spawnSync/,
        `${title} has regressed to the sequential shape that made the original claim unearned`);
    }
  });

  test('there is exactly ONE lock implementation, and _runtime delegates to it', () => {
    const runtime = read(RUNTIME_JS);
    const body = runtime.slice(runtime.indexOf('function withLock'), runtime.indexOf('function withLock') + 220);
    assert.match(body, /_index-lease\.js'\)\.withLock\(file, fn\)/,
      '_runtime.js has grown its own lock body again. It had one once, with three defects the lease had '
      + 'already been corrected for; delegating removed the second copy rather than fixing it twice.');
    assert.doesNotMatch(body, /openSync/, '_runtime.js is creating lock files itself again');
  });

  test('⛔ an exception from the critical section is NOT swallowed, and the lock is still released', () => {
    /*
     * The one guarantee with no existing fixture. `_runtime.js`'s own header records that its deleted
     * copy "also swallowed exceptions from `fn` itself" — a caller whose critical section threw was
     * handed `{locked:true, value:undefined}` and carried on as though the update had landed. Nothing
     * asserted the corrected behaviour, so nothing would notice it coming back.
     */
    const dir = tmpdir('throw');
    const file = path.join(dir, 'runtime', 'counter.json');
    const rt = require_(RUNTIME_JS);
    try {
      const boom = new Error('the critical section failed');
      assert.throws(() => rt.withLock(file, () => { throw boom; }), /the critical section failed/,
        'withLock swallowed the callback exception — the caller would treat a failed update as a completed one');

      // And the lock is gone, so the next principal is not wedged by the throw.
      assert.equal(fs.existsSync(`${file}.lock`), false, 'the lock survived a throwing critical section');
      const after = rt.withLock(file, () => 'acquired');
      assert.deepEqual({ locked: after.locked, value: after.value }, { locked: true, value: 'acquired' },
        'the next acquisition was blocked by the previous throw');
    } finally { rm(dir); }
  });

  test('the lock reports an unestablished acquisition explicitly, and never runs the callback', () => {
    const dir = tmpdir('failclosed');
    const file = path.join(dir, 'runtime', 'counter.json');
    const rt = require_(RUNTIME_JS);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.lock`, 'held by someone else');
    const held = fs.statSync(`${file}.lock`).mtimeMs;
    try {
      let ran = false;
      const r = rt.withLock(file, () => { ran = true; return 'should never happen'; });
      assert.equal(ran, false, '⛔ the critical section RAN while exclusivity was unavailable — the one thing a lock must never do');
      assert.equal(r.locked, false, 'an unestablished lock did not report itself as unestablished');
      assert.match(String(r.why), /\S/, 'a refusal with no reason cannot be acted on');
      assert.ok(fs.existsSync(`${file}.lock`), 'a FRESH lock belonging to another owner was deleted by a failed acquisition');
      assert.equal(fs.statSync(`${file}.lock`).mtimeMs, held, "another owner's fresh lock was rewritten");
    } finally { rm(dir); }
  });

  test('stale-lock recovery is bounded — the window is a named constant, not an accident', () => {
    const lease = read(LEASE_JS);
    const m = /const STALE_LOCK_MS = (\d+);/.exec(lease);
    assert.ok(m, 'the stale-lock window is no longer a named constant in _index-lease.js');
    const ms = Number(m[1]);
    assert.ok(ms > 0 && ms <= 60_000, `the stale-lock window is ${ms}ms — unbounded recovery is not recovery`);
    assert.match(lease, /if \(age > STALE_LOCK_MS\)/, 'nothing consults the stale-lock window any more');
  });
});
