#!/usr/bin/env node
// rmem — the RespawnPack memory CLI. Thin shell over the engine.
import { existsSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createEngine } from './engine.mjs';
import { importRemovals } from './spine.mjs';
import { readQueryLog } from './querylog.mjs';

const argv = process.argv.slice(2);
const cmd = argv[0];
const rest = argv.slice(1);

// Tiny flag parser: --key=value or --key value (repeatable -> array), --flag (bool); else positional.
// The --key=value form lets a value legitimately start with '--'.
function parse(args) {
  const pos = [], flags = {};
  const set = (k, v) => { flags[k] = k in flags ? [].concat(flags[k], v) : v; };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 2) { set(a.slice(2, eq), a.slice(eq + 1)); continue; }
      const key = a.slice(2);
      const next = args[i + 1];
      if (next === undefined || next.startsWith('--')) flags[key] = true;
      else { set(key, next); i++; }
    } else pos.push(a);
  }
  return { pos, flags };
}
const list = (v) => (v === undefined ? [] : [].concat(v));
const firstLine = (s) => String(s || '').replace(/^#+\s*/, '').split('\n').find((l) => l.trim()) || '';

async function main() {
  if (cmd === 'init') return init();
  if (!cmd || cmd === 'help' || cmd === '--help') return help();
  if (cmd === 'mcp') { const { startMcpServer } = await import('./mcp.mjs'); return startMcpServer(); }
  if (cmd === 'hook') return hookCmd(); // pure fs — no need to spin up the engine/DB

  const m = await createEngine();
  try {
    const { pos, flags } = parse(rest);
    switch (cmd) {
      case 'remember': {
        const id = pos[0];
        if (!id) throw new Error('usage: rmem remember <type:slug> --body <text> [--alias a]... [--rel verb|dst]... [--confidence n] [--verify] [--negative]');
        const body = flags.body === true || flags.body === undefined ? readStdin() : flags.body;
        const e = await m.remember({
          id, body,
          aliases: list(flags.alias), relations: list(flags.rel),
          confidence: flags.confidence ? Number(flags.confidence) : undefined,
          verify_against_code: !!flags.verify, negative: !!flags.negative,
        });
        console.log(`remembered ${e.id} -> ${e.path || '(index only)'}`);
        break;
      }
      case 'add': {
        const [id, ...text] = pos;
        const e = await m.addObservation(id, text.join(' ') || readStdin());
        console.log(`extended ${e.id}`);
        break;
      }
      case 'query': {
        const hits = await m.query(pos.join(' '), { k: flags.k ? Number(flags.k) : 8 });
        printHits(hits);
        break;
      }
      case 'recall': {
        const r = await m.recall(pos.join(' '), { k: flags.k ? Number(flags.k) : 5, expand: flags.expand ? Number(flags.expand) : 1 });
        console.log('seeds:'); printHits(r.seeds);
        if (r.related.length) { console.log('related (via the graph):'); for (const x of r.related) console.log(`  ${x.id}  ← ${x.via} from ${x.from}`); }
        break;
      }
      case 'neighbors': {
        for (const n of await m.neighbors(pos[0])) console.log(`  ${n.dir === 'out' ? '→' : '←'} ${n.rel}  ${n.other}`);
        break;
      }
      case 'get': {
        const e = await m.get(pos[0]);
        console.log(e ? JSON.stringify(e, null, 2) : `not found: ${pos[0]}`);
        break;
      }
      case 'lessons': {
        const ls = await m.lessonsFor(pos[0]);
        if (!ls.length) console.log(`no lessons for skill ${pos[0]}`);
        for (const l of ls) console.log(`  [${l.confidence ?? '–'}] ${l.id}: ${firstLine(l.body)}`);
        break;
      }
      case 'feedback': {
        const [id, outcome] = pos;
        if (!id || !outcome) throw new Error('usage: rmem feedback <id> <useful|wrong> [--note "..."]');
        const e = await m.feedback(id, outcome, flags.note);
        console.log(`feedback recorded on ${e.id} (${outcome})${e.confidence != null ? ` — confidence now ${e.confidence}` : ''}`);
        break;
      }
      case 'sync': { const r = await m.sync(); console.log(`synced ${r.total} entities from ${m.cfg.memoryDir} — ${r.changed} changed, ${r.unchanged} unchanged, ${r.pruned} pruned`); break; }
      case 'reindex': { const r = await m.sync(); console.log(`reindexed ${r.total} entities — ${r.changed} changed, ${r.unchanged} unchanged, ${r.pruned} pruned`); break; }
      case 'doctor': { printDoctorReport(await m.doctor({ fix: !!flags.fix })); break; }
      case 'spine-sync': { const r = await importRemovals(m, pos[0]); console.log(r.found ? `imported ${r.imported} ⛔ removal(s) from ${r.path}` : `no DECISIONS.md at ${r.path}`); break; }
      case 'stats': {
        const log = readQueryLog(m.cfg);
        console.log(`${await m.count()} entities · embedder ${m.embedder.id} · dim ${m.dim} · ${log.length} logged quer${log.length === 1 ? 'y' : 'ies'}`);
        break;
      }
      case 'querylog': {
        const entries = readQueryLog(m.cfg, { limit: flags.limit ? Number(flags.limit) : 20 });
        if (!entries.length) { console.log('  (no logged queries — disabled, an ephemeral dataDir, or none run yet)'); break; }
        for (const e of entries) console.log(`  ${e.ts}  [${e.kind}]  "${e.query}"  k=${e.k}  ${e.duration_ms}ms  -> ${(e.hit_ids || []).join(', ') || '(no hits)'}`);
        break;
      }
      default: help(); process.exitCode = 1;
    }
  } finally { await m.close(); }
}

function printHits(hits) {
  if (!hits.length) { console.log('  (no matches)'); return; }
  for (const h of hits) {
    const s = typeof h.score === 'number' ? ` (${h.score.toFixed(4)})` : '';
    console.log(`  ${h.id}${s}  ${firstLine(h.body)}${h.caveat ? `  [${h.caveat}]` : ''}`);
  }
}

function printDoctorReport(r) {
  const s = r.summary;
  console.log(`rmem doctor — ${s.entities} entities checked`);
  const section = (label, items, render) => {
    console.log(`\n${label}: ${items.length}`);
    for (const it of items) console.log(`  ${render(it)}`);
  };
  section('orphan relations (dst has no entity)', r.orphanRelations, (o) => `${o.src} --${o.rel}--> ${o.dst}  [MISSING]`);
  section('unknown entity types', r.unknownTypes, (u) => `${u.id}  type="${u.type}"`);
  section('unknown relation verbs', r.unknownVerbs, (u) => `${u.id}  "${u.raw}"`);
  section('duplicate entities (same id, multiple files)', r.duplicateEntities, (d) => `${d.id}  x${d.count}`);
  section('duplicate observations', r.duplicateObservations, (d) => `${d.id}  x${d.count}  ${firstLine(d.text)}`);
  section('stale entries (possibly stale)', r.staleEntries, (e) => `${e.id}  decay=${e.decay.toFixed(3)}  as-of=${e.effectiveTimestamp || '(none)'}`);
  section('index-vs-source drift', r.drift, (d) => `${d.id}  ${d.issue}`);
  section('near-duplicate entities (flag-only — never auto-fixed)', r.nearDuplicates, (d) => `${d.a}  ~  ${d.b}  (score ${d.score})`);
  const total = s.orphanRelations + s.unknownTypes + s.unknownVerbs + s.duplicateEntities + s.duplicateObservations + s.staleEntries + s.drift + s.nearDuplicates;
  console.log(`\n${total} finding(s) total.`);
  if (r.applied) {
    console.log(`\n--fix applied:`);
    console.log(`  deduped ${r.applied.dedupedEntities.length} entit${r.applied.dedupedEntities.length === 1 ? 'y' : 'ies'}${r.applied.dedupedEntities.length ? ': ' + r.applied.dedupedEntities.join(', ') : ''}`);
    console.log(`  dropped ${r.applied.droppedRelations.length} orphan relation(s)${r.applied.droppedRelations.length ? ': ' + r.applied.droppedRelations.map((o) => `${o.src}--${o.rel}-->${o.dst}`).join(', ') : ''}`);
  } else if (total) {
    console.log('run `rmem doctor --fix` to apply the safe, deterministic fixes (dedup + drop truly orphan relations).');
  }
}

function readStdin() { try { return readFileSync(0, 'utf8').trim(); } catch { return ''; } }

function init() {
  const root = process.cwd();
  const cfgPath = resolve(root, 'respawn-memory.config.json');
  if (!existsSync(cfgPath)) {
    writeFileSync(cfgPath, JSON.stringify({
      memoryDir: 'memory/graph', dataDir: 'memory/.index',
      embeddings: { provider: 'local', dim: 256, _note: 'local is offline/lexical; set provider to ollama or openai for real recall' },
    }, null, 2) + '\n');
    console.log('wrote respawn-memory.config.json');
  } else console.log('respawn-memory.config.json already exists');
  mkdirSync(resolve(root, 'memory/graph'), { recursive: true });
  console.log('memory/graph/ ready · next: `rmem remember gotcha:<slug> --body "..."` then `rmem query "..."`');
}

/** `rmem hook install|uninstall|status` — pure fs, no engine/DB needed. The repo root is
 * resolved ONCE via resolveRepoRoot() (git rev-parse --show-toplevel) and shared by all three
 * subcommands, so install/status/uninstall always agree from any directory inside the repo —
 * status/uninstall run from a subpackage used to treat cwd as the root and report hooks
 * "absent" while they stayed active at the real root. */
async function hookCmd() {
  const { installHooks, uninstallHooks, statusHooks, resolveRepoRoot } = await import('./hook.mjs');
  const sub = rest[0];
  if (!['install', 'uninstall', 'status'].includes(sub)) {
    console.log('usage: rmem hook install|uninstall|status');
    process.exitCode = 1;
    return;
  }
  const root = resolveRepoRoot(process.cwd());
  if (sub === 'install') {
    for (const [name, info] of Object.entries(installHooks(root))) {
      console.log(info.status === 'installed' ? `installed ${name}` : `skipped ${name} — ${info.message}`);
    }
  } else if (sub === 'uninstall') {
    for (const [name, info] of Object.entries(uninstallHooks(root))) {
      if (info.status === 'removed') console.log(`removed ${name}`);
      else if (info.status === 'absent') console.log(`${name}: absent (nothing to remove)`);
      else console.log(`${name}: foreign — left untouched`);
    }
  } else if (sub === 'status') {
    for (const [name, st] of Object.entries(statusHooks(root))) console.log(`${name}: ${st}`);
  }
}

function help() {
  console.log(`rmem — RespawnPack memory
  init                         scaffold config + memory/graph
  remember <type:slug> [...]   capture an entity (--body --alias --rel verb|dst --confidence --verify --negative)
  add <id> <text>              extend an entity with an observation
  query <text> [--k]           hybrid search -> ranked entities
  recall <text> [--k --expand] graph-augmented: seeds + related
  neighbors <id>               typed-edge traversal
  get <id>                     show an entity
  feedback <id> <useful|wrong> [--note "..."]   record recall feedback (wrong requires --note)
  lessons <skill>              lessons keyed to a skill (living-skill feed)
  sync | reindex               rebuild the index from the markdown source of truth (incremental:
                                unchanged entities are skipped, no re-embed)
  spine-sync [DECISIONS.md]    import ⛔ removals as negative entities
  doctor [--fix]               health-check: orphans, unknown vocab, dupes, staleness, drift, near-dupes
                                (read-only by default; --fix applies only safe, deterministic fixes)
  hook install|uninstall|status   manage the post-merge/post-checkout freshness hook (runs rmem sync)
  stats                        index summary
  querylog [--limit N]         recent search()/recall() calls from query-log.jsonl
  mcp                          run the MCP server (claude mcp add respawn-memory -- rmem mcp)`);
}

main().catch((e) => { console.error('rmem:', e.message); process.exit(1); });
