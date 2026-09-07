// MCP server: exposes the memory engine as tools so Claude Code (/debug Step 0, /knowledge)
// calls it. Schema = the knowledge graph (entities/observations/relations).
//   claude mcp add respawn-memory -- rmem mcp
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createEngine } from './engine.mjs';
import { importRemovals } from './spine.mjs';

const text = (o) => ({ content: [{ type: 'text', text: typeof o === 'string' ? o : JSON.stringify(o, null, 2) }] });
// Catch handler errors so a bad call returns isError instead of rejecting / crashing the server.
const safe = (fn) => async (args) => {
  try { return await fn(args); }
  catch (e) { return { content: [{ type: 'text', text: `memory error: ${e.message}` }], isError: true }; }
};

const ID = z.string().min(1).max(200);
const K = z.number().int().min(1).max(100).optional();

/** Build an MCP server bound to an engine (exported so it can be unit-tested without stdio). */
export function buildServer(engine) {
  const server = new McpServer({ name: 'respawn-memory', version: '0.1.0' });

  server.registerTool('memory_query', {
    description: 'Hybrid semantic + keyword search of project memory; returns ranked entities (gotchas / infra / decisions / …) each with a verify-before-trusting or ⛔ removed caveat. Query memory FIRST before investigating a problem.',
    inputSchema: { query: z.string().min(1).max(2000), k: K },
  }, safe(async ({ query, k }) => text(await engine.query(query, { k: k || 8 }))));

  server.registerTool('memory_recall', {
    description: 'Graph-augmented recall: find the seed entities by meaning, then expand along their typed relations (e.g. a gotcha plus its fix and the infra it touches). Returns { seeds, related }.',
    inputSchema: { query: z.string().min(1).max(2000), k: K, expand: z.number().int().min(1).max(5).optional() },
  }, safe(async ({ query, k, expand }) => text(await engine.recall(query, { k: k || 5, expand: expand ?? 1 }))));

  server.registerTool('memory_remember', {
    description: 'Capture or upsert a memory entity (the unit of memory). id is "type:slug" where type ∈ gotcha|infra|compat|decision|hyp. body holds the observations (e.g. ## Symptom / ## Root cause / ## Fix). relations are "verb|dst-id" using depends-on|causes|fixed-by|supersedes|relates-to|applies-to.',
    inputSchema: {
      id: ID, body: z.string().min(1).max(100000),
      aliases: z.array(z.string().max(200)).max(50).optional(),
      relations: z.array(z.string().max(200)).max(100).optional(),
      confidence: z.number().min(0).max(1).optional(), verify_against_code: z.boolean().optional(), negative: z.boolean().optional(),
    },
  }, safe(async (a) => { const e = await engine.remember(a); return text(`remembered ${e.id}`); }));

  server.registerTool('memory_add_observation', {
    description: 'Extend an existing entity with a new observation (extend, do not duplicate near-identical entities).',
    inputSchema: { id: ID, text: z.string().min(1).max(100000) },
  }, safe(async ({ id, text: t }) => { const e = await engine.addObservation(id, t); return text(`extended ${e.id}`); }));

  server.registerTool('memory_neighbors', {
    description: 'Traverse an entity\'s typed relations (graph edges, in and out).',
    inputSchema: { id: ID, rel: z.string().max(40).optional() },
  }, safe(async ({ id, rel }) => text(await engine.neighbors(id, rel ? { rel } : {}))));

  server.registerTool('memory_lessons', {
    description: 'Lessons keyed to a skill (entities with applies-to|skill:<name>) — the source a living skill\'s "Learned" overlay is regenerated from.',
    inputSchema: { skill: z.string().min(1).max(120) },
  }, safe(async ({ skill }) => text(await engine.lessonsFor(skill))));

  server.registerTool('memory_feedback', {
    description: 'Record recall feedback on an entity. "useful" refreshes its freshness (observed_at -> now) with a small confidence nudge (+0.05, capped at 1.0). "wrong" (note required) appends a ## Correction observation and reduces confidence (-0.2, floored at 0.1). A ⛔ negative (do-not-reintroduce) entity is never altered by feedback beyond appending the Correction text on "wrong".',
    inputSchema: { id: ID, outcome: z.enum(['useful', 'wrong']), note: z.string().max(2000).optional() },
  }, safe(async ({ id, outcome, note }) => { const e = await engine.feedback(id, outcome, note); return text(`feedback recorded on ${e.id} (${outcome}); confidence now ${e.confidence ?? '–'}`); }));

  server.registerTool('memory_sync', {
    description: 'Rebuild the index from the markdown source of truth (source of truth wins). Incremental: entities whose content is unchanged since the last sync are skipped (no re-embed).',
    inputSchema: {},
  }, safe(async () => { const r = await engine.sync(); return text(`synced ${r.total} entities — ${r.changed} changed, ${r.unchanged} unchanged, ${r.pruned} pruned`); }));

  server.registerTool('memory_spine_sync', {
    description: 'Import the docs spine\'s DECISIONS.md ⛔ removals as negative entities, so recall surfaces "deliberately removed — do not reintroduce".',
    inputSchema: { path: z.string().max(400).optional() },
  }, safe(async ({ path }) => text(await importRemovals(engine, path))));

  server.registerTool('memory_doctor', {
    description: 'Health-check the store: orphan relations, unknown entity-types/relation-verbs in the source, duplicate entities/observations, stale entries, and index-vs-source drift. Read-only by default; fix:true applies ONLY safe deterministic fixes (dedup identical observations, drop truly orphan relations) and reports what changed.',
    inputSchema: { fix: z.boolean().optional() },
  }, safe(async ({ fix }) => text(await engine.doctor({ fix: !!fix }))));

  return server;
}

/** Start the stdio MCP server. */
export async function startMcpServer(opts = {}) {
  const engine = await createEngine(opts);
  const server = buildServer(engine);
  const shutdown = async () => { try { await engine.close(); } catch { /* closing */ } process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  await server.connect(new StdioServerTransport());
}
