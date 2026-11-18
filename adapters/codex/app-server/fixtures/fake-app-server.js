#!/usr/bin/env node
/*
 * RespawnPack · adapters/codex/app-server/fixtures/fake-app-server.js — a SCRIPTED stand-in for
 * `codex app-server`, used only by rpc.test.mjs.
 *
 * ⛔ IT IS NOT A MODEL OF THE HOST AND MUST NEVER BE CITED AS ONE. It exists so the REAL transport —
 * spawn, argv, JSONL framing, chunk boundaries, dispatch, the server→client responder, exit handling —
 * is exercised end to end as a child process rather than through an in-process shortcut that would
 * quietly skip the framing. What it emits is whatever the plan tells it to; the plans that matter are
 * built from the captured fixtures beside it, so the BYTES are the host's even though the sender is not.
 *
 * ⭐ `splitBytes` IS THE POINT OF THE WHOLE FILE. Writing every reply in tiny chunks forces the reader
 * to reassemble lines across `data` events — the failure mode a test that writes one line per write
 * cannot reach, and the one a real pipe produces under load.
 *
 * Plan (env RP_FAKE_PLAN, JSON):
 *   { prelude:      ["<raw line>", …]                  emitted immediately on start
 *     responses:    { "<method>": {result}|{error}|{silent:true} }
 *     afterRequest: { "<method>": ["<raw line>", …] }  emitted after that method is answered
 *     serverRequests: ["<raw line>", …]                server→client REQUESTS, emitted on start
 *     splitBytes:   n                                  write stdout in n-byte chunks (0 = whole lines)
 *     tornTail:     "<partial text>"                   written without a newline, then exit
 *     exitAfter:    "<method>"                         exit(0) once this method has been answered
 *     delayMs:      n                                  delay before answering every request }
 */

'use strict';

// `--version` is answered because the supervisor's probe() reads it through the SAME resolved script,
// so a fake that only understood `app-server` would make every probe fail before the transport ran.
if (process.argv[2] === '--version') { process.stdout.write(`${process.env.RP_FAKE_VERSION || 'codex-cli 0.0.0-fake'}\n`); process.exit(0); }

if (process.argv[2] !== 'app-server') {
  process.stderr.write(`fake-app-server: expected argv "app-server", got ${JSON.stringify(process.argv.slice(2))}\n`);
  process.exit(3);
}

const plan = JSON.parse(process.env.RP_FAKE_PLAN || '{}');
const split = Number(plan.splitBytes) || 0;

function out(text) {
  if (!split) { process.stdout.write(text); return; }
  for (let i = 0; i < text.length; i += split) process.stdout.write(text.slice(i, i + split));
}

const line = (obj) => out(`${typeof obj === 'string' ? obj : JSON.stringify(obj)}\n`);

for (const l of plan.prelude || []) line(l);
for (const l of plan.serverRequests || []) line(l);

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  for (;;) {
    const nl = buf.indexOf('\n');
    if (nl < 0) break;
    const raw = buf.slice(0, nl).replace(/\r$/, '');
    buf = buf.slice(nl + 1);
    if (raw.trim()) handle(raw);
  }
});
process.stdin.on('end', () => { setTimeout(() => process.exit(0), 10); });

function handle(raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }
  // A response we sent to a server→client request: acknowledged by staying silent, like the real thing.
  if (msg.id !== undefined && msg.method === undefined) return;

  const spec = (plan.responses || {})[msg.method];
  const after = () => {
    for (const l of ((plan.afterRequest || {})[msg.method] || [])) line(l);
    if (plan.exitAfter === msg.method) {
      if (plan.tornTail) out(plan.tornTail);
      setTimeout(() => process.exit(0), 10);
    }
  };
  const send = () => {
    if (!spec) { line({ id: msg.id, error: { code: -32601, message: `fake-app-server has no plan for ${msg.method}` } }); after(); return; }
    if (spec.silent) { after(); return; }
    if (spec.error) { line({ id: msg.id, error: spec.error }); after(); return; }
    line({ id: msg.id, result: spec.result === undefined ? {} : spec.result });
    after();
  };
  if (plan.delayMs) setTimeout(send, plan.delayMs); else send();
}
