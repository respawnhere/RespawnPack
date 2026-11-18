/*
 * RespawnPack · adapters/providers/turn-claude.js — one bounded turn on the Claude family, through the
 * existing headless CLI supervisor.
 *
 * Spec: the class audit Class G, "Providers" ("Claude through sdk-supervisor/cli.js"); the second run's task list
 * P4-M-4 ("Claude's turn uses `sdk-supervisor/cli.js runTurn` with `--tools ""` (no tools) and the
 * result text from the stream").
 *
 * ⛔ AN OFFLOAD IS NOT A SESSION, AND `--tools ""` IS WHERE THAT BECOMES MECHANICAL. Anti-drift item 54
 * splits the two: a task session is a Claude Code session with the pack's hooks armed, and an offload is
 * a bounded, hookless unit of work with a receipt. A turn with no tools cannot read a file, cannot write
 * one and cannot spawn anything, so an offload cannot quietly become the session it was defined not to
 * be. `buildTurnArgs` emits `--tools ""` for `tools: ''` and omits the flag entirely for null, which is
 * why this module passes the empty string explicitly rather than leaving the option out.
 *
 * ⛔ THE PROBE RESOLVES A PATH AND SPAWNS NOTHING. Availability is one question here: does an executable
 * this process could run exist. `resolveExecutable` answers it from the filesystem and PATH with no
 * child process at all, which is what lets the offload build an availability map for three families
 * without paying three startups for a route it may not take. It says nothing about whether the operator
 * is signed in; that is settled by the turn itself, reported as its own failure kind, and never inferred
 * from a path that happened to exist (anti-drift item 41's discipline, one level up from a capability
 * declaration).
 *
 * ⛔ AND NO ELAPSED CLOCK IS A COMPLETION (anti-drift item 38). A deadline that passed resolves as
 * `{ok:false, kind:'TIMEOUT'}` carrying the observation, never as a turn that produced a short answer.
 * The same holds for a non-zero exit and for a stream with no assistant text in it: each is its own
 * kind, so "could not run", "ran and refused" and "ran and said nothing" reach the receipt as three
 * different findings.
 */

'use strict';

const path = require('path');

const cliLib = require(path.join(__dirname, '..', 'claude-code', 'sdk-supervisor', 'cli.js'));
const stream = require(path.join(__dirname, '..', 'claude-code', 'sdk-supervisor', 'stream.js'));

/** This provider's own name on the receipt. One string, spelled once. */
const PROVIDER = 'claude-code-cli';

/** The family whose sessions carry the pack's hooks, and the only family this module speaks for. */
const FAMILY = 'anthropic';

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/*
 * Every way one turn can fail to produce text. `EXIT_<code>` is generated rather than listed: the host's
 * own exit code is more informative than a bucket this file would have to keep in step with it.
 */
const TURN_FAILURE = {
  NO_CLI: 'NO_CLI',       // no executable resolved, so nothing was spawned
  SPAWN: 'SPAWN',         // the child could not be started, or its stdin could not be written
  TIMEOUT: 'TIMEOUT',     // the deadline passed and the child was killed
  AUTH: 'AUTH',           // the host itself said the credential failed
  EMPTY: 'EMPTY',         // exit 0, and no assistant text in the stream
};

/**
 * Is a Claude turn reachable from this process?
 *
 * @param {{cli?:object, env?:object}} opts - `cli` is the process surface (the real one, or a test's
 *   fake of the same shape). Injectable so the offload's suite can run with this family present and
 *   absent without touching the machine's PATH.
 * @returns {{ok:boolean, why:string, detail:object|null}}
 */
function probe({ cli = cliLib.realCli, env = process.env } = {}) {
  const r = cli.resolveExecutable({ env });
  if (!r || !r.ok) {
    return {
      ok: false,
      why: (r && r.why) || 'the claude executable could not be resolved',
      detail: null,
    };
  }
  return {
    ok: true,
    why: `a claude executable resolved from ${r.source}. Resolving a path is not a sign-in: whether the credential works is settled by the turn.`,
    detail: { source: r.source || null },
  };
}

/**
 * One bounded turn, with no tools.
 *
 * @param {{prompt:string, model?:string|null, cwd?:string, timeoutMs?:number, cli?:object, env?:object}} opts
 * @returns {Promise<{ok:true, text, usage, model, kind:null, durationMs}
 *                 | {ok:false, text:null, usage, model, kind, detail, durationMs}>}
 */
async function runTurn({
  prompt,
  model = null,
  cwd = undefined,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  cli = cliLib.realCli,
  env = process.env,
} = {}) {
  if (typeof prompt !== 'string' || !prompt.length) {
    throw new Error('adapters/providers/turn-claude.js runTurn: `prompt` must be a non-empty string');
  }

  const r = await cli.runTurn({
    cwd,
    env,
    prompt,
    promptVia: 'stdin',
    model: model || null,
    // ⛔ THE EMPTY STRING, NOT null. null omits the flag and leaves the host's default tool set armed.
    tools: '',
    timeoutMs,
  });

  const durationMs = Number.isFinite(r && r.durationMs) ? r.durationMs : 0;
  const fail = (kind, detail) => ({ ok: false, text: null, usage: { input: null, output: null }, model: model || null, kind, detail, durationMs });

  if (r && r.spawnError) {
    /*
     * ⛔ THE TWO MESSAGES THE RESOLVER PRODUCES, MATCHED EXACTLY. "the project directory does not
     * exist" is the CWD check's own sentence and it is deliberately NOT matched here: the same libuv
     * errno once made a missing directory read as a missing binary, which is the confusion
     * sdk-supervisor/cli.js's `checkCwd` exists to end, and re-creating it one layer up would undo it.
     */
    const noCli = /no `claude` executable was found|the configured claude executable does not exist/i.test(String(r.spawnError));
    return fail(noCli ? TURN_FAILURE.NO_CLI : TURN_FAILURE.SPAWN, `the claude CLI could not be run: ${r.spawnError}`);
  }
  if (r && r.timedOut) {
    return fail(TURN_FAILURE.TIMEOUT, `the turn was killed at the ${timeoutMs}ms deadline. That is an observation of a clock and never a completion.`);
  }

  const obs = stream.observe((r && r.stdoutLines) || []);
  if (obs.auth && obs.auth.failed) {
    return fail(TURN_FAILURE.AUTH, `the host reported an authentication failure (${obs.auth.phrase}). Sign in with \`claude\` in this shell; no credential is read from a file or a config by this pack.`);
  }
  if (!r || r.code !== 0) {
    return fail(`EXIT_${r && r.code === null ? 'NULL' : r.code}`, `claude exited ${r && r.code}. The verbatim stderr was ${JSON.stringify(String((r && r.stderr) || '').slice(0, 300))}.`);
  }

  const text = stream.allAssistantText(obs);
  const u = stream.latestUsage(obs);
  const usage = u.ok
    ? { input: u.usedTokens, output: (u.parts && u.parts.outputTokens) || 0 }
    : { input: null, output: null };

  if (typeof text !== 'string' || !text.trim()) {
    return { ...fail(TURN_FAILURE.EMPTY, `the turn exited 0 and produced no assistant text (${obs.assistants.length} assistant message(s), ${obs.lines.length} stream line(s)). An answer with nothing in it is not a failure of the request.`), usage };
  }

  return {
    ok: true,
    text,
    usage,
    model: (u.ok && u.model) || model || null,
    kind: null,
    durationMs,
  };
}

module.exports = { PROVIDER, FAMILY, TURN_FAILURE, DEFAULT_TIMEOUT_MS, probe, runTurn };
