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

  test('⛔ a genuinely absent file is ABSENT in ONE attempt — a stat answers it, nothing waits', () => {
    /*
     * The defect this pins is COST, with correctness as its guard. ENOENT used to be a transient to be
     * waited out: a genuinely absent artifact took ABSENT_RETRIES+1 = 5 read attempts and four 3 ms
     * pauses, and on Windows each pause rounds up to the ~15.6 ms timer tick — ~62 ms per absent read,
     * paid on every hook's boot path (contract, cycle, latches, savepoint attempt). One statSync settles
     * absence now, so the read answers in a single attempt with no pause. `attempts` is the deterministic
     * proof — no timing bound, because this machine runs under load: the old reader could not reach 1,
     * the new reader cannot exceed it.
     */
    const dir = tmpdir('absent1');
    const art = require_(path.join(ROOT, 'hooks', '_artifact.js'));
    try {
      const gone = art.readTextClassified(path.join(dir, 'never-written.json'));
      assert.equal(gone.status, 'ABSENT', 'a file that was never written must be ABSENT');
      assert.equal(gone.attempts, 1,
        `an absent read took ${gone.attempts} attempt(s); the fix answers absence from one statSync, so it must be exactly 1 — `
        + 'the old reader retried the ENOENT four times and reported 5, which is the ~62 ms this task removed');
      assert.match(gone.detail, /not present after 1 attempt/);

      /*
       * ⛔ THE BYPASS. A reader that got "fast" by making ABSENT its catch-all would pass the line above.
       * A present-but-locked file must still be UNREADABLE, never ABSENT, so absence stays one of six
       * distinct answers and not the reader's default. statSync is NOT mocked here, so the file the
       * injected EACCES hides is genuinely on disk.
       */
      const target = path.join(dir, 'locked.json');
      fs.writeFileSync(target, '{}');
      const real = cjsFs.readFileSync;
      let injected = 0;
      cjsFs.readFileSync = function readFileSync(p, ...rest) {
        if (String(p) === target) { injected += 1; const e = new Error('EACCES'); e.code = 'EACCES'; throw e; }
        return real.call(this, p, ...rest);
      };
      try {
        const locked = art.readTextClassified(target);
        assert.equal(locked.status, 'UNREADABLE',
          `a present file that only ever returns EACCES must be UNREADABLE, not ${locked.status} — absence is not the catch-all`);
        assert.ok(injected > 1, 'the locked path did not retry, so the bounded deadline loop is gone');
      } finally { cjsFs.readFileSync = real; }
    } finally { rm(dir); }
  });

  test('⛔ an ENOENT with a replacement in flight is UNREADABLE, never ABSENT — deterministically', () => {
    /*
     * The contention fixture above caught the false ABSENT only when a window happened to be hit, and a
     * loaded CI runner proved a single statSync does NOT always catch it: the reader reported ABSENT for
     * a file replaced continuously for 2.5 s. The durable fix is that an ENOENT whose statSync also
     * ENOENTs is still NOT absence while a `writeAtomic` replacement is in flight — witnessed by the temp
     * sibling it publishes through. Injected here so it is proven every run, not when the race hits:
     * open and stat both ENOENT forever, a matching temp sibling is present, and the reader must refuse
     * ABSENT and fail closed to UNREADABLE instead.
     */
    const dir = tmpdir('inflight');
    const target = path.join(dir, 'STATE.json');
    const art = require_(path.join(ROOT, 'hooks', '_artifact.js'));
    // A sibling in the shape writeAtomic publishes through, so writeInFlight sees a landing replacement.
    fs.writeFileSync(path.join(dir, `${path.basename(target)}.4242.1.deadbeefcafe.tmp`), 'x');
    const realRead = cjsFs.readFileSync, realStat = cjsFs.statSync;
    let openEnoents = 0;
    cjsFs.readFileSync = function (p, ...rest) {
      if (String(p) === target) { openEnoents += 1; const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
      return realRead.call(this, p, ...rest);
    };
    cjsFs.statSync = function (p, ...rest) {
      if (String(p) === target) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
      return realStat.call(this, p, ...rest);
    };
    try {
      const r = art.readTextClassified(target);
      assert.notEqual(r.status, 'ABSENT',
        'a target with a replacement in flight was reported ABSENT — the exact false-missing defect under contention');
      assert.equal(r.status, 'UNREADABLE', `expected UNREADABLE while the open never clears, saw ${r.status}`);
      assert.match(r.detail, /replacement in flight/);
      assert.ok(openEnoents > 1, 'the in-flight ENOENT was not retried — it answered without out-waiting the window');
    } finally { cjsFs.readFileSync = realRead; cjsFs.statSync = realStat; rm(dir); }
  });

  test('⛔ RC: a temp that disappears between the checks because the replacement just landed is read, never ABSENT', () => {
    /*
     * The remaining window: open ENOENTs, every stat probe ENOENTs (the old name is gone, the temp not
     * yet renamed), and then the writer's rename lands, so by the time the reader scans for the temp
     * sibling it has VANISHED and the destination is already readable. The scan alone reads that as
     * "no replacement in flight" and answered ABSENT for a file that exists. Injected deterministically:
     * stat ENOENTs until the directory scan runs, the scan sees no temp, and the published file is real.
     */
    const dir = tmpdir('landed');
    const target = path.join(dir, 'STATE.json');
    fs.writeFileSync(target, '{"landed":true}');
    const art = require_(path.join(ROOT, 'hooks', '_artifact.js'));
    const realRead = cjsFs.readFileSync, realStat = cjsFs.statSync, realReaddir = cjsFs.readdirSync;
    let opens = 0, scanned = false;
    cjsFs.readFileSync = function (p, ...rest) {
      if (String(p) === target && opens++ === 0) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
      return realRead.call(this, p, ...rest);
    };
    cjsFs.statSync = function (p, ...rest) {
      if (String(p) === target && !scanned) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
      return realStat.call(this, p, ...rest);
    };
    cjsFs.readdirSync = function (p, ...rest) {
      if (String(p) === dir) scanned = true; // the rename lands as the scan runs: no temp, a real target
      return realReaddir.call(this, p, ...rest);
    };
    try {
      const r = art.readTextClassified(target);
      assert.ok(scanned, 'the fixture never reached the sibling scan, so it proves nothing');
      assert.equal(r.status, 'OK', `a replacement that landed between the checks was reported ${r.status}`);
      assert.equal(r.text, '{"landed":true}');
      // the control: a file that is genuinely gone (no temp, no destination) is still ABSENT in one attempt
      const gone = art.readTextClassified(path.join(dir, 'never.json'));
      assert.equal(gone.status, 'ABSENT');
      assert.equal(gone.attempts, 1);
    } finally { cjsFs.readFileSync = realRead; cjsFs.statSync = realStat; cjsFs.readdirSync = realReaddir; rm(dir); }
  });

  test('⛔ the reader\'s in-flight-temp predicate still matches the temp writeAtomic actually creates', () => {
    /*
     * hooks/_artifact.js (in hooks/, which cannot require the kernel — see its header) hard-codes the
     * `${basename}.*.tmp` shape of the sibling writeAtomic publishes through. That is the reader's ONLY
     * signal that an un-resolvable ENOENT is a replacement window and not absence. If the two spellings
     * drift, the reader silently loses the signal and the false ABSENT returns. This fence fails the
     * instant they part: it captures the real temp writeAtomic renames onto the target and asserts the
     * reader's own exported predicate recognises it.
     */
    const dir = tmpdir('tmpname');
    const target = path.join(dir, 'STATE.json');
    const art = require_(path.join(ROOT, 'hooks', '_artifact.js'));
    const realRename = cjsFs.renameSync;
    let captured = null;
    cjsFs.renameSync = function (from, to) { if (String(to) === target) captured = String(from); return realRename.call(this, from, to); };
    try { stateLib.writeAtomic(target, '{}'); } finally { cjsFs.renameSync = realRename; }
    try {
      assert.ok(captured, 'did not observe writeAtomic rename a temp onto the target');
      const tname = path.basename(captured);
      assert.ok(tname.startsWith(`${path.basename(target)}.`) && tname.endsWith('.tmp'),
        `writeAtomic temp "${tname}" no longer matches the \`${path.basename(target)}.*.tmp\` shape _artifact.js keys on`);
      // And the reader's own predicate agrees against a real sibling of that captured shape.
      fs.writeFileSync(path.join(dir, tname), 'x');
      assert.equal(art.writeInFlight(target), true, "the reader does not recognise writeAtomic's own temp as a replacement in flight");
      // Control: with no such sibling, the predicate must say nothing is in flight.
      const quiet = path.join(dir, 'other.json');
      assert.equal(art.writeInFlight(quiet), false, 'the predicate claimed a write in flight with no temp sibling present');
    } finally { rm(dir); }
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
  // G18 · WINDOW_MS is this file's local write window, NOT the smoke's (its predicate, evaluateStep16 in
  // ops/_smoke16-gate.mjs, is the shared fixture and is untouched here). It was tuned for a quiet machine:
  // under a concurrent kernel-suite load one of four children could be scheduled too little to land a single
  // 20 KB write inside 700 ms, so `everyWriterWrote` failed on a genuinely concurrent run. Widened to give
  // every released child time to land at least one write even under four concurrent suites; the sequential
  // control below still starves its later children because they start only after the window has elapsed.
  const WRITERS = 4, WINDOW_MS = 4000;

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
      // A wider barrier lead too (G18): under four concurrent suites, spawning four children can itself
      // outrun a 700 ms lead, leaving a late child only a sliver of the window. 1500 ms lets all four reach
      // the barrier before release, so the window they share is the full one.
      const results = await race(children(dir, 0).map((src) => (startAt) => src.replace(/Date\.now\(\)<0/g, `Date.now()<${startAt}`).replace(/<0\+/g, `<${startAt}+`)), 1500);
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

// ---------------------------------------------------------------------------------------------
describe('⛔ G17 R1 · the ops-log append lock — two honest appenders cannot splice the prevDigest chain', () => {
  /*
   * ⛔ THE DEFECT THIS FENCE EXISTS FOR. `kernel/respawnpack.js` appendOpsRow read the head and appended
   * with no lock, so two honest appenders (two `log` verbs, or a `log` during a `savepoint --write`) both
   * sealed a row with prevDigest = head H and both landed it — the second then reads as a SPLICE, the chain
   * is BROKEN at a row nobody rewrote, `--repair-tail` refuses it as corruption, and every later append is
   * refused. The lock serialises the read-head-then-append window. These fixtures run REAL child processes
   * (the rule this suite obeys: spawnSync in a callback is sequential and proves nothing): remove the lock
   * and the first fixture bricks the chain and goes red. The last two pin the wait and the refusal
   * deterministically, with no timing race.
   */
  const RESPAWN = path.join(KERNEL, 'respawnpack.js');
  const opsLog = (dir) => path.join(dir, '.respawnpack', 'ops-log.jsonl');
  const opsLock = (dir) => path.join(dir, '.respawnpack', 'ops-log.lock');

  // The real CLI, run synchronously, with its --json parsed.
  const run = (dir, ...args) => {
    const r = spawnSync(process.execPath, [RESPAWN, ...args, '--dir', dir, '--json'], { encoding: 'utf8' });
    let json = null; try { json = JSON.parse(r.stdout); } catch { /* left null */ }
    return { code: r.status, json, stdout: r.stdout, stderr: r.stderr };
  };

  // One real `log` append, as an async child released at a shared wall-clock instant so two collide for
  // real. The inner `log` process's own stdout+stderr is forwarded so a caller can tell a NAMED bounded-
  // wait refusal apart from a crash or a splice.
  const appendChild = (dir, tag, startAt) => {
    const src =
      `while(Date.now()<${startAt});` +
      'const {spawnSync}=require("child_process");' +
      `const r=spawnSync(process.execPath,[${J(RESPAWN)},"log","--dir",${J(dir)},"--action","act-"+${J(tag)},"--result","ok","--by",${J(tag)},"--json"],{encoding:"utf8"});` +
      'process.stdout.write((r.stdout||"")+(r.stderr||""));' +
      'process.exit(r.status===null?1:r.status);';
    return new Promise((resolve) => {
      const child = spawn(process.execPath, ['-e', src], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { out += d; });
      child.on('close', (code) => resolve({ code, out: out.trim() }));
    });
  };

  test('⛔ 20 rounds of two simultaneous appenders: the chain never splices, and a refusal is only ever a named bounded-wait loss', async () => {
    const dir = tmpdir('opslock');
    try {
      const ROUNDS = 20;
      /*
       * ⛔ NARROWED, for the reason the raw-reader assertion two describes up was narrowed, and proven by
       * CI: this used to assert ZERO of the 2·ROUNDS appends are ever refused, and a loaded windows-latest
       * runner falsified it (1 of 40 refused). The bounded wait is finite BY DESIGN (OPS_LOCK_WAIT_MS): a
       * race loser whose wait expires while the winner's whole `log` process is still running on a thrashing
       * host is REFUSED, named, with nothing written — the fixtures below pin exactly that. That refusal is
       * the lock SERIALISING under load, not failing, and it does NOT splice the chain, which is the one
       * guarantee this suite exists for. So the safety property is asserted in full and a refusal is
       * tolerated only as a diagnosable, bounded minority.
       */
      const REFUSAL_CAP = ROUNDS / 2; // a healthy lock refuses only a rare load-minority (CI saw 1/40); a
      // uselessly short wait would refuse the loser nearly every round (~ROUNDS), which this still trips.
      const refusals = [];
      for (let i = 0; i < ROUNDS; i += 1) {
        const startAt = Date.now() + 150; // both children busy-wait to this instant, then race for the lock
        const [a, b] = await Promise.all([appendChild(dir, `a${i}`, startAt), appendChild(dir, `b${i}`, startAt)]);
        // The winner of each race HOLDS the lock and lands; only the loser can ever be refused. Both
        // refused would mean the lock let neither in — it serialised no winner.
        assert.ok(!(a.code !== 0 && b.code !== 0), `both appenders in round ${i} were refused — the lock serialised no winner: ${a.out} | ${b.out}`);
        for (const r of [a, b]) if (r.code !== 0) refusals.push(r);
      }
      const refused = refusals.length;
      // Every refusal must be a NAMED bounded-wait lock loss (the exact `append was refused, nothing
      // written` the two refusal paths print), never a crash, a torn tail or a broken-chain splice.
      for (const r of refusals) {
        assert.match(r.out, /append was refused, nothing written/,
          `an append exited nonzero for something other than a named lock refusal — a crash or a splice, not a bounded-wait loss: ${r.out}`);
      }
      assert.ok(refused <= REFUSAL_CAP,
        `${refused} of ${ROUNDS * 2} appends were refused (cap ${REFUSAL_CAP}) — the bounded wait is too short or the lock does not serialise`);
      // ⛔ THE SAFETY GUARANTEE, UNCHANGED: the chain verifies and carries EXACTLY the rows that landed, so
      // a false splice (two rows sealed on one head) or a lost-but-sealed row still goes red here.
      const v = run(dir, 'log', '--verify');
      assert.equal(v.json.outcome, 'PASS', `the chain did not verify after ${ROUNDS * 2} concurrent appends — a false splice: ${v.stdout}`);
      assert.equal(v.json.rows, ROUNDS * 2 - refused,
        `expected ${ROUNDS * 2 - refused} sealed rows (${ROUNDS * 2} appends, ${refused} refused), the chain carries ${v.json.rows} — a row was lost or spliced`);
      assert.ok(!fs.existsSync(opsLock(dir)), 'the append lock was left behind after every appender finished — it is not released in a finally');
    } finally { rm(dir); }
  });

  test('⛔ a held lock within the wait window makes the second appender WAIT, then succeed', async () => {
    const dir = tmpdir('opsheld');
    try {
      assert.equal(run(dir, 'log', '--action', 'seed', '--result', 'ok', '--by', 'seed').code, 0, 'the seed append failed');
      // Hold the lock with a FRESH mtime (not stale), from before the appender starts.
      fs.mkdirSync(path.dirname(opsLock(dir)), { recursive: true });
      fs.writeFileSync(opsLock(dir), JSON.stringify({ pid: 'test-holder' }));
      const appendP = new Promise((resolve) => {
        const child = spawn(process.execPath, [RESPAWN, 'log', '--action', 'waited', '--result', 'ok', '--by', 'w', '--dir', dir, '--json'], { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = ''; child.stdout.on('data', (d) => { out += d; });
        child.on('close', (code) => resolve({ code, out }));
      });
      // Release at 400ms — well inside the 1000ms wait and after the child surely began contending, so the
      // appender CANNOT have succeeded or refused yet: it is in the wait loop when the lock clears.
      await new Promise((r) => setTimeout(r, 400));
      fs.unlinkSync(opsLock(dir));
      const res = await appendP;
      assert.equal(res.code, 0, `the second appender did not succeed after the held lock cleared: ${res.out}`);
      assert.equal(run(dir, 'log', '--verify').json.rows, 2, 'the waited append did not land as a second sealed row');
    } finally { rm(dir); }
  });

  test('⛔ a stale lock older than the window is reclaimed and NAMED; the append lands', () => {
    const dir = tmpdir('opsstale');
    try {
      assert.equal(run(dir, 'log', '--action', 'seed', '--result', 'ok', '--by', 'seed').code, 0, 'the seed append failed');
      fs.writeFileSync(opsLock(dir), JSON.stringify({ pid: 'dead-holder' }));
      const old = Date.now() - 30_000; // 30s, well past the 10s stale window
      fs.utimesSync(opsLock(dir), new Date(old), new Date(old));
      const r = run(dir, 'log', '--action', 'after-reclaim', '--result', 'ok', '--by', 'w');
      assert.equal(r.code, 0, `the append over a stale lock was refused rather than reclaiming it: ${r.stdout}`);
      assert.ok(r.json.reclaimed && /stale/.test(r.json.reclaimed),
        `the reclaim was not named in the result (never silent): ${JSON.stringify(r.json.reclaimed)}`);
      assert.equal(run(dir, 'log', '--verify').json.rows, 2, 'the reclaimed append did not land as a sealed row');
    } finally { rm(dir); }
  });

  test('⛔ a fresh lock that never clears refuses the append, names the lock, and leaves the file byte-identical', () => {
    const dir = tmpdir('opsnever');
    try {
      assert.equal(run(dir, 'log', '--action', 'seed', '--result', 'ok', '--by', 'seed').code, 0, 'the seed append failed');
      const before = fs.readFileSync(opsLog(dir));
      // A FRESH lock (mtime now) that nothing ever releases: the append waits the bounded window, then refuses.
      fs.writeFileSync(opsLock(dir), JSON.stringify({ pid: 'live-holder' }));
      const t0 = Date.now();
      const r = run(dir, 'log', '--action', 'blocked', '--result', 'ok', '--by', 'w');
      const waited = Date.now() - t0;
      assert.equal(r.code, 1, 'an append against a lock that never clears was not refused');
      assert.ok(/ops-log\.lock/.test((r.json && r.json.error) || r.stderr || ''), `the refusal did not name the lock: ${r.stderr || JSON.stringify(r.json)}`);
      assert.ok(waited >= 900, `the append did not wait the bounded window before refusing (waited ${waited}ms) — a refusal with no wait starves an honest second writer`);
      assert.ok(fs.readFileSync(opsLog(dir)).equals(before), 'the refused append changed the log file — a refusal must leave it byte-identical');
    } finally { rm(dir); }
  });

  test('⛔ RC: --repair-tail holds the lock end to end, so a repair that cannot take it changes nothing, and with the lock free it repairs once', () => {
    /*
     * The repair used to read, TRUNCATE and only then take the lock for its record row: with another
     * writer holding the lock, the torn bytes were already gone when the row was refused, and nothing
     * recorded their discard. Now the lock comes first and is held throughout, so a repair that cannot
     * take it leaves the log byte-identical, torn tail included, and a re-run repairs it once.
     */
    const dir = tmpdir('opsrepair');
    try {
      assert.equal(run(dir, 'log', '--action', 'seed', '--result', 'ok', '--by', 'seed').code, 0, 'the seed append failed');
      fs.appendFileSync(opsLog(dir), '{"schemaVersion":"1.0.0","at":"2026-');
      const before = fs.readFileSync(opsLog(dir));
      fs.writeFileSync(opsLock(dir), JSON.stringify({ pid: 'live-holder' }));
      const r = run(dir, 'log', '--repair-tail', '--by', 'w');
      assert.equal(r.code, 1, `a repair against a held lock was not refused: ${r.stdout}`);
      assert.ok(fs.readFileSync(opsLog(dir)).equals(before), 'a repair that could not take the lock changed the log: the torn bytes were discarded with nothing recording it');
      fs.rmSync(opsLock(dir));
      const ok = run(dir, 'log', '--repair-tail', '--by', 'w');
      assert.equal(ok.code, 0, `the repair with the lock free failed: ${ok.stdout}${ok.stderr}`);
      const v = run(dir, 'log', '--verify');
      assert.equal(v.code, 0, 'the chain does not verify after the repair');
      assert.equal(v.json.rows, 2, 'the repair was not recorded as exactly one sealed row');
      assert.ok(!fs.existsSync(opsLock(dir)), 'the repair left its lock behind');
    } finally { rm(dir); }
  });
});

// ---------------------------------------------------------------------------------------------
describe('⛔ G15 · the rules-file lock: concurrent rule promotions both land, and a held lock refuses with nothing written', () => {
  /*
   * ⛔ THE DEFECT THIS FENCE EXISTS FOR. `memory candidates promote --as rule/<slug>` planned the rules file
   * (read it, number the line, bump the version) before the store was touched and replaced the whole file
   * after the entity was written, with no lock. Two promotions released together both planned from the same
   * bytes and the second rename overwrote the first: both said PASS and the file held one rule. The fixture
   * below runs REAL child processes behind a shared start instant (this suite's rule), several rounds, and
   * asserts every rule landed with its own number and its own version. The second fixture pins the bounded
   * wait and the named, nothing-written refusal deterministically.
   */
  const RESPAWN = path.join(KERNEL, 'respawnpack.js');
  const candidatesLib = require_(path.join(ROOT, 'core', 'memory', 'candidates.js'));
  const rulesFile = (dir) => path.join(dir, 'docs', 'reference', 'wordsmith-rules.md');
  const rulesLock = (dir) => path.join(dir, '.respawnpack', 'rules-file.lock');
  // The host auto-memory mirror is not under test: pinned off so no child writes into an ambient directory.
  const childEnv = { ...process.env, RESPAWNPACK_AUTO_MEMORY_DIR: '' };
  const capture = (dir, claim) => {
    const r = candidatesLib.capture({ dir: path.join(dir, 'memory', 'candidates') }, { claim, klass: 'constraint', provenance: { cycleId: 'conc-cycle', by: 'fixture' } });
    assert.ok(r.ok, `the fixture candidate was not captured: ${r.reason}`);
    return r.record.id;
  };
  const promoteArgs = (dir, id, slug) => [RESPAWN, 'memory', 'candidates', 'promote', id, '--as', `rule/${slug}`, '--verified-by', 'fixture', '--by', 'fixture', '--dir', dir, '--json'];
  const runPromote = (dir, id, slug) => {
    const r = spawnSync(process.execPath, promoteArgs(dir, id, slug), { encoding: 'utf8', env: childEnv });
    let json = null; try { json = JSON.parse(r.stdout); } catch { /* left null */ }
    return { code: r.status, json, out: `${r.stdout || ''}${r.stderr || ''}` };
  };
  const promoteChild = (dir, id, slug, startAt) => {
    const src =
      `while(Date.now()<${startAt});` +
      'const {spawnSync}=require("child_process");' +
      `const r=spawnSync(process.execPath,${J(promoteArgs(dir, id, slug))},{encoding:"utf8",env:${J(childEnv)}});` +
      'process.stdout.write((r.stdout||"")+(r.stderr||""));' +
      'process.exit(r.status===null?1:r.status);';
    return new Promise((resolve) => {
      const child = spawn(process.execPath, ['-e', src], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { out += d; });
      child.on('close', (code) => resolve({ code, out: out.trim() }));
    });
  };

  test('⛔ 6 rounds of two simultaneous rule promotions: every rule lands with a distinct number and version, and the file version counts them all', async () => {
    const dir = tmpdir('ruleslock');
    try {
      const ROUNDS = 6;
      const ids = [];
      for (let i = 0; i < ROUNDS; i += 1) {
        const a = capture(dir, `rule a${i}: say a${i}`), b = capture(dir, `rule b${i}: say b${i}`);
        ids.push(a, b);
        const startAt = Date.now() + 150;
        const res = await Promise.all([promoteChild(dir, a, `ra${i}`, startAt), promoteChild(dir, b, `rb${i}`, startAt)]);
        res.forEach((r, k) => {
          if (r.code === 0) return;
          // Only a NAMED bounded-wait loss is tolerated (nothing written), and it is re-run so the totals
          // below still demand every rule; anything else is a crash or a lost write.
          assert.match(r.out, /promotion was refused, nothing written/, `a promotion exited ${r.code} for something other than a named lock refusal: ${r.out}`);
          const again = runPromote(dir, k === 0 ? a : b, k === 0 ? `ra${i}` : `rb${i}`);
          assert.equal(again.code, 0, `the re-run after a lock refusal failed: ${again.out}`);
        });
      }
      const text = fs.readFileSync(rulesFile(dir), 'utf8');
      const lines = text.split(/\r?\n/).map((l) => /^(\d+)\. \[reader\] .* \(rule:([a-z0-9-]+), confirmed v(\d+), (cm_[0-9a-f]+)\)$/.exec(l)).filter(Boolean);
      assert.equal(lines.length, ROUNDS * 2, `expected ${ROUNDS * 2} rule lines, the file holds ${lines.length} - a concurrent promotion overwrote another:\n${text}`);
      const nums = lines.map((m) => Number(m[1])).sort((x, y) => x - y);
      assert.deepEqual(nums, Array.from({ length: ROUNDS * 2 }, (_, k) => k + 1), `rule numbers collide or skip:\n${text}`);
      const vers = lines.map((m) => Number(m[3])).sort((x, y) => x - y);
      assert.deepEqual(vers, Array.from({ length: ROUNDS * 2 }, (_, k) => k + 2), `two rules were confirmed at one version:\n${text}`);
      assert.match(text, new RegExp(`^version: ${ROUNDS * 2 + 1}$`, 'm'), 'the file version does not count every promotion');
      assert.deepEqual(lines.map((m) => m[4]).sort(), ids.slice().sort(), 'a candidate is missing from the rules file or appears twice');
      assert.ok(!fs.existsSync(rulesLock(dir)), 'the rules-file lock was left behind - it is not released in a finally');
      assert.deepEqual(fs.readdirSync(path.dirname(rulesFile(dir))).filter((n) => n.includes('.rp-tmp-')), [], 'a temp file was left beside the rules file');
    } finally { rm(dir); }
  });

  test('⛔ a rules-file lock that never clears refuses the promotion after the bounded wait, names the lock, writes nothing; the same command lands once it clears', () => {
    const dir = tmpdir('rulesheld');
    try {
      const id = capture(dir, 'never say synergy');
      fs.mkdirSync(path.dirname(rulesLock(dir)), { recursive: true });
      fs.writeFileSync(rulesLock(dir), JSON.stringify({ pid: 'live-holder' }));
      const t0 = Date.now();
      const r = runPromote(dir, id, 'no-synergy');
      const waited = Date.now() - t0;
      assert.equal(r.code, 1, `a promotion against a held lock was not refused: ${r.out}`);
      assert.match(r.json.error, /rules-file\.lock/, 'the refusal did not name the lock');
      assert.match(r.json.error, /nothing written/);
      assert.ok(waited >= 2500, `the promotion did not wait the bounded window before refusing (waited ${waited}ms)`);
      const rec = JSON.parse(fs.readFileSync(path.join(dir, 'memory', 'candidates', `${id}.json`), 'utf8'));
      assert.equal(rec.verificationState, 'candidate', 'the refused promotion still verified the candidate');
      assert.ok(!fs.existsSync(rulesFile(dir)), 'the refused promotion still wrote a rules file');
      assert.ok(!fs.existsSync(path.join(dir, 'memory', 'graph', 'rule', 'no-synergy.md')), 'the refused promotion still wrote the entity');

      fs.unlinkSync(rulesLock(dir));
      const again = runPromote(dir, id, 'no-synergy');
      assert.equal(again.code, 0, again.out);
      assert.ok(fs.readFileSync(rulesFile(dir), 'utf8').includes(`1. [reader] never say synergy (rule:no-synergy, confirmed v2, ${id})`));
    } finally { rm(dir); }
  });
});
