#!/usr/bin/env node
/*
 * RespawnPack · adapters/openai-compatible/probe.js — the cheap canary for one declared provider, run
 * against a target project's own `respawnpack.config.json`.
 *
 * ⭐ WHAT THIS PROVES, PRECISELY. Three things, and nothing beyond them: the environment variable the
 * project's provider block NAMES is set in this process; the provider's `/models` endpoint answers; and
 * every model id the block declares appears in the list that endpoint returned. It never requests a
 * completion, so a run costs nothing but one small GET. It is the OpenAI-compatible sibling of
 * `adapters/claude-code/task-runner/canary.js --probe-only`, and it is deliberately the cheap half:
 * a bounded LIVE probe that actually spends tokens on a model is the OWNER's action (the owner's brief for the second run
 * item 7), not something this pack's tests or an unattended session decide to do.
 *
 * ⛔ WHAT IT NEVER TOUCHES. The key. `--provider` names a block in the target's config; that block
 * carries the variable's NAME, and `client.js` reads the value at call time into a local. This CLI
 * prints rows the client produced, and the client scrubs its own output, so there is no path from a
 * value in the environment to a line on this stdout (anti-drift item 52).
 *
 * ⛔ AND "COULD NOT RUN" IS NEVER "FAILED" (anti-drift item 2). Every way this CLI can fail to get an
 * answer — a directory that is not there, a config that will not parse, no `providers` key, a provider
 * nobody declared, a block for a protocol this adapter does not speak, an unreachable host, a variable
 * that is unset — is CANNOT_DETERMINE at exit 2, with the row saying which. The ONE thing that exits 1
 * is the determined disagreement: a model id the declaration carries and the host's own list does not.
 *
 * Usage:
 *   node adapters/openai-compatible/probe.js --dir <project> --provider <name> [--json]
 *
 *   --dir <path>        the project whose respawnpack.config.json declares the provider (default: cwd)
 *   --provider <name>   the key inside that config's `providers` map
 *   --json              write the whole report to stdout as JSON instead of the human rows
 *   --timeout <ms>      deadline for the one GET (default: client.js's PROBE_TIMEOUT_MS)
 *
 * Exit: 0 PASS · 1 FAIL · 2 CANNOT_DETERMINE.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const PACK_ROOT = path.join(__dirname, '..', '..');
const core = require(path.join(PACK_ROOT, 'core', 'index.js'));
const { createClient, check, PROTOCOL } = require('./client.js');

const { OUTCOME, exitCodeFor } = core.failures;

const CONFIG_NAME = 'respawnpack.config.json';

/** A report with one CANNOT_DETERMINE row: every way this CLI can fail to reach the client at all. */
const cannotDetermine = (name, detail, provider = null, dir = null) => ({
  kind: 'respawnpack-openai-compatible-probe',
  provider,
  dir,
  checks: [check(name, OUTCOME.CANNOT_DETERMINE, detail)],
  outcome: OUTCOME.CANNOT_DETERMINE,
});

function parseArgs(argv) {
  const out = { dir: null, provider: null, json: false, timeoutMs: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[i += 1];
    if (a === '--dir') out.dir = next();
    else if (a === '--provider') out.provider = next();
    else if (a === '--json') out.json = true;
    else if (a === '--timeout') out.timeoutMs = Number(next());
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`unknown option ${JSON.stringify(a)}`);
  }
  return out;
}

/** The header, up to and not including the line that closes it — found by its end, not a line count. */
function helpText() {
  const lines = fs.readFileSync(__filename, 'utf8').split('\n');
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '*/');
  return lines.slice(1, end > 0 ? end : 60).join('\n');
}

/**
 * Read one provider block out of a target's config.
 *
 * @returns {{ok:true, block:object, configPath:string}|{ok:false, report:object}}
 */
function readProviderBlock({ dir, provider }) {
  const root = path.resolve(dir || process.cwd());
  const FOUND = 'the project declares this provider';
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    return { ok: false, report: cannotDetermine(FOUND, `the project directory does not exist: ${root}`, provider, root) };
  }
  const configPath = path.join(root, CONFIG_NAME);
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e) {
    return {
      ok: false,
      report: cannotDetermine(FOUND,
        `${configPath} could not be read as JSON (${(e && e.code) || (e && e.message) || 'unreadable'}), so which providers this project declares is UNKNOWN.`,
        provider, root),
    };
  }
  const providers = doc && typeof doc === 'object' ? doc.providers : null;
  if (!providers || typeof providers !== 'object' || Array.isArray(providers)) {
    return {
      ok: false,
      report: cannotDetermine(FOUND,
        `${configPath} declares no \`providers\` map. Add one, or run this probe against a project that has one; `
        + 'a project with no provider block has nothing for this adapter to reach and that is a legitimate state.',
        provider, root),
    };
  }
  const names = Object.keys(providers);
  const block = Object.prototype.hasOwnProperty.call(providers, provider) ? providers[provider] : null;
  if (!block || typeof block !== 'object' || Array.isArray(block)) {
    return {
      ok: false,
      report: cannotDetermine(FOUND,
        `${configPath} declares no provider named ${JSON.stringify(provider)}. It declares: ${names.length ? names.join(', ') : '(none)'}.`,
        provider, root),
    };
  }
  if (block.protocol !== PROTOCOL) {
    return {
      ok: false,
      report: cannotDetermine(FOUND,
        `the provider block ${JSON.stringify(provider)} declares protocol ${JSON.stringify(block.protocol)}, and this adapter speaks "${PROTOCOL}". `
        + 'A block for another protocol is somebody else\'s adapter to run, not a failure of this one.',
        provider, root),
    };
  }
  return { ok: true, block, configPath, root };
}

/**
 * Build the client for one declared block and run its probe with the REAL fetch and the REAL process
 * environment. This is the one place in this adapter that reaches a network, and it is a CLI an operator
 * invokes: nothing in the pack's own suites calls it.
 */
async function runProbe({ dir, provider, timeoutMs = null, env = process.env, fetchImpl = globalThis.fetch } = {}) {
  if (typeof provider !== 'string' || !provider.trim()) {
    return cannotDetermine('the project declares this provider', '--provider is required: name the key inside the config\'s `providers` map.', provider || null, dir || null);
  }
  const found = readProviderBlock({ dir, provider });
  if (!found.ok) return found.report;

  let client;
  try {
    client = createClient({
      name: provider,
      baseUrl: found.block.baseUrl,
      apiKeyEnv: found.block.apiKeyEnv,
      models: found.block.models,
      protocol: found.block.protocol,
      fetch: fetchImpl,
      env,
    });
  } catch (e) {
    return cannotDetermine('the provider block is well formed',
      `${found.configPath} declares ${JSON.stringify(provider)} in a shape this client refuses: ${(e && e.message) || String(e)}`,
      provider, found.root);
  }

  const report = await client.probe(Number.isFinite(timeoutMs) && timeoutMs > 0 ? { timeoutMs } : {});
  return {
    kind: 'respawnpack-openai-compatible-probe',
    dir: found.root,
    configPath: found.configPath,
    ...report,
  };
}

function printReport(report) {
  const log = (s) => process.stdout.write(`${s}\n`);
  log(`RespawnPack · openai-compatible probe (${report.provider || '(no provider named)'})`);
  if (report.baseUrl) log(`  base URL: ${report.baseUrl}`);
  if (report.apiKeyEnv) log(`  key variable: ${report.apiKeyEnv} (NAME only; the value is never read into this report)`);
  for (const c of report.checks) log(`  [${c.outcome}] ${c.name} — ${c.detail}`);
  log(`  → ${report.outcome}`);
}

async function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    process.stderr.write(`  ${e.message}\n  Run with --help for the option list.\n`);
    return exitCodeFor(OUTCOME.CANNOT_DETERMINE);
  }
  if (opts.help) { process.stdout.write(`${helpText()}\n`); return 0; }

  const report = await runProbe({ dir: opts.dir, provider: opts.provider, timeoutMs: opts.timeoutMs });
  if (opts.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else printReport(report);
  return exitCodeFor(report.outcome);
}

module.exports = { parseArgs, helpText, readProviderBlock, runProbe, printReport, main, CONFIG_NAME };

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => { process.exitCode = code; })
    .catch((e) => {
      process.stdout.write('  OUTCOME: CANNOT_DETERMINE\n');
      process.stdout.write(`    the probe itself threw — ${(e && e.stack) || e}\n`);
      process.exitCode = exitCodeFor(OUTCOME.CANNOT_DETERMINE);
    });
}
