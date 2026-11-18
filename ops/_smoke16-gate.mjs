/*
 * RespawnPack · ops/_smoke16-gate.mjs — the release-smoke step-16 verdict, as ONE importable function.
 *
 * ⛔ WHY THIS IS A MODULE AND NOT INLINE IN THE SMOKE. An independent audit ran the smoke three times
 * at unchanged b2b1d0b and got one step-16 FAIL (194 valid reads, zero read failures, every writer
 * landed — and distinctPayloadsSeen=1) followed by two passes. Two defects, both in the HARNESS:
 *
 *   1. The only rendezvous was a shared future timestamp. Nothing proved any reader was active
 *      before or during writer activity — a reader that booted late, or writers that spent the
 *      window blocked in rename-retry, could leave every read observing one unchanging payload.
 *      And the initial file was WRITER 0'S OWN PAYLOAD, so "saw p0" could not distinguish the
 *      pre-write file from writer activity at all.
 *   2. The parent aggregated `Math.max(reader.distinct)` over per-reader COUNTS. Two readers that
 *      each saw one different payload score 1, though the run displayed two. The union was not even
 *      computable, because readers reported counts instead of identities.
 *
 * The verdict now lives here so the smoke consumes the SAME object that kernel/concurrency.test.mjs
 * rejects and accepts shapes against. A copy in each place is how the two drift apart.
 *
 * The protocol whose reports this judges (implemented in ops/release-smoke.mjs step 16):
 * sentinel seeded → children spawn → every writer signals READY and BLOCKS on stdin → every reader
 * confirms it read the SENTINEL, signals READY, and keeps reading → the parent releases all writers
 * at once → each reader stops at its first non-sentinel observation or a bounded hard deadline.
 * Readers therefore run before AND during writer activity BY CONSTRUCTION, not by timing luck.
 */
import crypto from 'node:crypto';

export const sha256Hex = (text) => crypto.createHash('sha256').update(text).digest('hex');

/** The union of payload hashes observed across ALL readers — never a per-reader maximum. */
export function unionOfObservedHashes(readerReports) {
  const u = new Set();
  for (const r of readerReports || []) {
    for (const h of (r && Array.isArray(r.hashes) ? r.hashes : [])) u.add(h);
  }
  return u;
}

/**
 * Judge one step-16 run.
 *
 * @param {object} run
 *   exits          every child's native exit code, writers first then readers
 *   writers        per-writer reports `{ n, refused: [] }` — `n` completed replacements
 *   readers        per-reader reports `{ reads, bad: [], hashes: [], sentinelConfirmed, sawWriterPayload }`
 *   sentinelHash   sha256 of the seeded sentinel payload
 *   writerHashes   sha256 of every writer payload (iterable)
 *   finalHash      sha256 of the surviving target file
 *   temps          count of surviving *.tmp files
 * @returns {{ pass: boolean, failures: string[], union: Set<string>, distinctObserved: number }}
 */
export function evaluateStep16(run) {
  const failures = [];
  const writerHashes = new Set(run.writerHashes);
  const knownAll = new Set([run.sentinelHash, ...writerHashes]);

  if (!Array.isArray(run.exits) || !run.exits.length || !run.exits.every((c) => c === 0)) {
    failures.push(`child exits [${(run.exits || []).join(',')}] — a nonzero exit is a loud protocol failure `
      + '(never READY, never released, first read not the sentinel, or nothing observed by the deadline), not noise');
  }
  if (!Array.isArray(run.writers) || !run.writers.length || !run.writers.every((w) => w && w.n >= 1)) {
    failures.push(`writes=${(run.writers || []).map((w) => (w ? w.n : -1)).join(',')} — a writer that never landed a `
      + 'replacement is the sequential shape, whatever the exit codes say');
  }
  if (!Array.isArray(run.readers) || !run.readers.length || !run.readers.every((r) => r && r.sentinelConfirmed === true)) {
    failures.push('a reader never confirmed the sentinel before the writers were released — nothing proves it was '
      + 'watching before writer activity, which is exactly the shape the timestamp barrier could not exclude');
  }
  if (!(run.readers || []).every((r) => r && r.sawWriterPayload === true)) {
    failures.push('a reader never observed a writer payload — it was not watching DURING writer activity');
  }
  const badReads = (run.readers || []).flatMap((r) => (r && Array.isArray(r.bad) ? r.bad : ['CHILD_DIED']));
  if (badReads.length) {
    failures.push(`readFailures [${[...new Set(badReads)].join(',')}] — the installed pack reader must never report `
      + 'ABSENT, UNREADABLE or malformed content under replacement');
  }
  const union = unionOfObservedHashes(run.readers);
  const unknown = [...union].filter((h) => !knownAll.has(h));
  if (unknown.length) {
    failures.push(`${unknown.length} observed payload(s) match neither the sentinel nor any writer payload — a torn or mixed read`);
  }
  if (!union.has(run.sentinelHash)) {
    failures.push('the observed union does not contain the sentinel — the pre-release observation is missing');
  }
  if (![...union].some((h) => writerHashes.has(h))) {
    failures.push('the observed union contains no writer payload — the readers never watched the file change');
  }
  if (!writerHashes.has(run.finalHash)) {
    failures.push('the surviving file is not one complete WRITER payload — either no replacement landed or the survivor is torn');
  }
  if (run.temps !== 0) failures.push(`${run.temps} temporary file(s) survived the run`);

  return { pass: failures.length === 0, failures, union, distinctObserved: union.size };
}
