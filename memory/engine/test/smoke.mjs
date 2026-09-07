// Smoke test: the unified entity/observation/relation model + hybrid recall + graph
// augmentation + traversal, on the zero-config local embedder (no network).
import { createEngine } from '../src/engine.mjs';

const m = await createEngine({ root: process.cwd(), dataDir: 'memory:', persistFiles: false });
let pass = 0, fail = 0;
const ok = (c, msg) => { if (c) { pass++; console.log('  PASS', msg); } else { fail++; console.log('  FAIL', msg); } };

// A gotcha entity, with typed relations to its fix and the infra it touches (the original
// knowledge-graph model), plus aliases for name recall.
await m.remember({
  id: 'gotcha:redis-tls-mismatch', confidence: 0.9, verify_against_code: true,
  aliases: ['redis tls', 'connection refused tls'],
  relations: ['fixed-by|decision:redis-rediss-scheme', 'relates-to|infra:cache-plane'],
  body: '## Symptom\nRedis handshake fails in prod only.\n## Root cause\nManaged Redis requires the rediss:// (TLS) scheme; the client defaulted to redis://.\n## Fix\nPin rediss:// in config.',
});
await m.remember({ id: 'decision:redis-rediss-scheme', confidence: 1.0, body: 'Standardize on the rediss:// TLS scheme for all managed Redis URLs.' });
await m.remember({ id: 'infra:cache-plane', body: 'Managed Redis (TLS-only) backing sessions and rate limits.' });

ok((await m.count()) === 3, 'remembered 3 entities');

// 1. Hybrid recall — finds the gotcha by MEANING, not just its name.
const r1 = await m.query('redis handshake error connection refused in production');
ok(r1[0]?.id === 'gotcha:redis-tls-mismatch', 'hybrid search finds the gotcha by meaning');
ok(r1[0]?.caveat === 'verify against current code before relying', 'CODE-WINS caveat surfaces');

// 2. Name/alias recall via the synthetic name observation.
const r2 = await m.query('redis tls');
ok(r2[0]?.id === 'gotcha:redis-tls-mismatch', 'alias recall finds the gotcha');

// 3. Graph-augmented recall — seed on the gotcha, then expand to its (non-seed) neighbors.
// k:1 isolates the augmentation; a precise query keeps the offline embedder reliable (real
// embedders seed correctly on vaguer queries too).
const rec = await m.recall('redis handshake fails in production', { k: 1, expand: 1 });
ok(rec.seeds[0]?.id === 'gotcha:redis-tls-mismatch', 'recall seed is the gotcha');
const relIds = rec.related.map((x) => x.id);
ok(relIds.includes('decision:redis-rediss-scheme'), 'recall expands to the fix (fixed-by)');
ok(relIds.includes('infra:cache-plane'), 'recall expands to the related infra');
ok(rec.related.find((x) => x.id === 'decision:redis-rediss-scheme')?.via === 'fixed-by', 'expansion records the relation it came via');

// 4. Pure graph traversal.
const nb = await m.neighbors('gotcha:redis-tls-mismatch');
ok(nb.some((n) => n.rel === 'fixed-by' && n.other === 'decision:redis-rediss-scheme'), 'neighbors() traverses typed edges');

// 5. Extend-don't-duplicate: add an observation, still one entity, newly searchable.
await m.addObservation('gotcha:redis-tls-mismatch', '## Detection\nThe error string is "ERR unencrypted connection".');
ok((await m.count()) === 3, 'addObservation extends, does not duplicate');
ok((await m.query('unencrypted connection ERR'))[0]?.id === 'gotcha:redis-tls-mismatch', 'the new observation is searchable');

await m.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
