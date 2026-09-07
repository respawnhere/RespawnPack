// Extended tests: negative (spine) entities, lessonsFor (living-skill feed), spine import,
// and a real MCP round-trip through the in-memory transport.
import { createEngine } from '../src/engine.mjs';
import { buildServer } from '../src/mcp.mjs';
import { parseRemovals, importRemovals } from '../src/spine.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  PASS', m); } else { fail++; console.log('  FAIL', m); } };

// --- negative entities + the ⛔ caveat ---
{
  const m = await createEngine({ dataDir: 'memory:', persistFiles: false });
  await m.remember({ id: 'decision:legacy-uploader', negative: true, confidence: 1, body: '## ⛔ Removed: legacy uploader\nReplaced by signed URLs; the old multipart path must not return.' });
  const hit = (await m.query('legacy uploader multipart'))[0];
  ok(hit?.id === 'decision:legacy-uploader', 'negative entity is searchable');
  ok(hit?.caveat === '⛔ deliberately removed — do not reintroduce', 'negative entity surfaces the ⛔ caveat');
  await m.close();
}

// --- spine import: DECISIONS.md ⛔ removals -> negative entities ---
{
  const root = '/tmp/rmem-spine';
  rmSync(root, { recursive: true, force: true });
  mkdirSync(`${root}/docs`, { recursive: true });
  writeFileSync(`${root}/docs/DECISIONS.md`, `# Decisions
### D-001 — adopt signed URLs · 2026-06-01 · accepted
- Decision: use signed URLs
### D-007 — multipart uploader retired · 2026-06-02 · accepted · ⛔ removal
- Decision: signed URLs replace it
- ⛔ Removal: the multipart uploader is retired because it leaked credentials. Do not reintroduce.
`);
  const parsed = parseRemovals(`### D-007 — multipart uploader retired · x · ⛔ removal\n- ⛔ Removal: leaked creds. Do not reintroduce.`);
  ok(parsed.length === 1 && parsed[0].dId === 'D-007', 'parseRemovals finds the ⛔ removal entry only');

  const m = await createEngine({ root, dataDir: 'memory:', persistFiles: false });
  const r = await importRemovals(m);
  ok(r.found && r.imported === 1, 'importRemovals imports exactly the one ⛔ removal (not the plain decision)');
  const hit = (await m.query('multipart uploader'))[0];
  ok(hit?.negative === true && hit?.caveat?.startsWith('⛔'), 'imported removal recalls as a ⛔ negative');
  await m.close();
  rmSync(root, { recursive: true, force: true });
}

// --- lessonsFor: the living-skill overlay feed ---
{
  const m = await createEngine({ dataDir: 'memory:', persistFiles: false });
  await m.remember({ id: 'gotcha:fly-secret-order', confidence: 0.9, relations: ['applies-to|skill:mcp-fly'], body: 'Set fly secrets and deploy them before rolling the release.' });
  await m.remember({ id: 'gotcha:fly-region-pin', confidence: 0.7, relations: ['applies-to|skill:mcp-fly'], body: 'Pin the primary region or machines scatter.' });
  await m.remember({ id: 'gotcha:unrelated', confidence: 1, body: 'nothing to do with fly' });
  const ls = await m.lessonsFor('mcp-fly');
  ok(ls.length === 2, 'lessonsFor returns only the skill-keyed lessons');
  ok(ls[0].id === 'gotcha:fly-secret-order', 'lessons are ordered by confidence');
  await m.close();
}

// --- MCP round-trip via in-memory transport ---
{
  const engine = await createEngine({ dataDir: 'memory:', persistFiles: false });
  const server = buildServer(engine);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(clientT);

  const tools = (await client.listTools()).tools.map((t) => t.name);
  ok(tools.includes('memory_query') && tools.includes('memory_remember') && tools.includes('memory_recall'), 'MCP exposes the memory tools');

  await client.callTool({ name: 'memory_remember', arguments: { id: 'gotcha:cors-preflight', body: '## Symptom\nCORS preflight 403 on the API.\n## Fix\nallow OPTIONS + the Authorization header.', confidence: 0.9 } });
  const res = await client.callTool({ name: 'memory_query', arguments: { query: 'cors preflight 403' } });
  ok(res.content[0].text.includes('gotcha:cors-preflight'), 'MCP memory_remember then memory_query round-trips');

  await client.close();
  await engine.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
