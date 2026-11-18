/*
 * RespawnPack · adapters/claude-code/sdk-supervisor/stream.js — the Claude Code stream-json protocol
 * reader, and the one place the COMPACTION EVIDENCE CONTRACT is spelled out.
 *
 * ⛔ THE FACT THIS FILE EXISTS FOR: A FAILED COMPACTION RETURNS A SUCCESS RESULT.
 * Captured verbatim from this environment (fixtures/captured/04-compact-attempt1.jsonl, the real
 * bytes of a real `/compact` that did not happen):
 *
 *   {"type":"system","subtype":"status","status":"compacting", …}
 *   {"type":"system","subtype":"status","status":null,"compact_result":"failed",
 *    "compact_error":"Error during compaction: Failed to authenticate: …"}
 *   …
 *   {"is_error":false, …, "subtype":"success", "num_turns":0, "type":"result",
 *    "result":"Error during compaction: Failed to authenticate: …"}
 *
 * `is_error:false`. `subtype:"success"`. A supervisor that keyed completion on the result envelope —
 * the obvious thing to key it on — would have recorded a compaction that never occurred, advanced its
 * context cycle, consumed its handoff, and continued into a session whose context was never reduced.
 *
 * ⭐ SO THE VERDICT IS KEYED ON THE CONTROL-FLOW MESSAGES, NEVER ON THE RESULT ENVELOPE:
 *
 *   COMPLETED      a `{type:"system",subtype:"compact_boundary"}` message arrived. This is the
 *                  documented completion signal (SDKCompactBoundaryMessage, carrying
 *                  compact_metadata.{trigger,pre_tokens,post_tokens,duration_ms,preserved_*}).
 *   FAILED         a status message carried `compact_result:"failed"` (with `compact_error`).
 *   NOOP           no boundary, no failure, and the host said, in its own words, that there was
 *                  nothing to compact ("Not enough messages to compact."). A typed NON-failure.
 *   CONTRADICTORY  both a boundary AND a failure. Not success, not failure — the two signals disagree,
 *                  which is exactly the CANNOT_DETERMINE shape.
 *   UNOBSERVED     none of the above arrived. A closed stream, an exhausted wait and a process exit
 *                  are observations of a CLOCK. They are returned as UNOBSERVED and never as anything
 *                  else; core/lifecycle/evidence.js refuses them by name if this file ever tries.
 *
 * ⛔ AND `apiKeySource:"none"` IS NOT AN AUTH VERDICT. It appears on init in this environment for both
 * an OAuth session and no session at all — the init message is emitted BEFORE credentials are used.
 * Authentication is judged only from what the host SAID went wrong: the assistant message's
 * `error:"authentication_failed"`, or a result/compact_error whose text names the failure.
 *
 * Every function here is PURE over lines of text. No spawn, no filesystem: the supervisor's fake-spawn
 * tests drive this exact code with the exact captured bytes.
 */

'use strict';

/** Message shapes this adapter reads. Open sets: an unrecognised line is COUNTED, never interpreted. */
const MSG = {
  INIT: 'init',
  STATUS: 'status',
  COMPACT_BOUNDARY: 'compact_boundary',
  ASSISTANT: 'assistant',
  USER: 'user',
  RESULT: 'result',
  OTHER_SYSTEM: 'other-system',
  UNRECOGNISED: 'unrecognised',
};

const VERDICT = {
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  NOOP: 'NOOP',
  CONTRADICTORY: 'CONTRADICTORY',
  UNOBSERVED: 'UNOBSERVED',
};

/*
 * The host's own words for "there was nothing to compact", verbatim from the documentation digest and
 * the SDK's behaviour. Matched narrowly ON PURPOSE: a loose pattern that also matched "Error during
 * compaction: …" would turn a failure into a benign no-op, which is the same class of mistake as
 * reading the result envelope.
 */
const NOOP_PHRASES = ['not enough messages to compact'];

/*
 * Auth failures as the host words them. Two spellings observed live in this environment (the bundled
 * binary and the PATH binary disagree), so the set is a list rather than one regex nobody can extend.
 */
const AUTH_PHRASES = [
  'failed to authenticate',
  'oauth session expired',
  'not logged in',
  'please run /login',
  'invalid api key',
  'authentication_failed',
];

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const lower = (v) => String(v === undefined || v === null ? '' : v).toLowerCase();
const containsAny = (text, phrases) => phrases.find((p) => lower(text).includes(p)) || null;

/**
 * Parse one stream line. A line that is not JSON, or is JSON but not an object, is REPORTED rather
 * than dropped: a supervisor that silently discards what it cannot read has no way to notice the day
 * the protocol grows a shape it does not know.
 *
 * @returns {{ok:true, msg:object, kind:string}|{ok:false, reason:string, raw:string}}
 */
function parseLine(line) {
  const text = String(line === undefined || line === null ? '' : line).trim();
  if (!text) return { ok: false, reason: 'empty line', raw: String(line) };
  let msg;
  try { msg = JSON.parse(text); } catch (e) {
    return { ok: false, reason: `not JSON (${e.message})`, raw: text };
  }
  if (!isObj(msg)) return { ok: false, reason: `JSON ${Array.isArray(msg) ? 'array' : typeof msg} — a protocol message must be an object`, raw: text };
  return { ok: true, msg, kind: classify(msg) };
}

/** Which shape a parsed message is. Never throws; an unknown shape is UNRECOGNISED, not an error. */
function classify(msg) {
  if (!isObj(msg)) return MSG.UNRECOGNISED;
  if (msg.type === 'system') {
    if (msg.subtype === 'init') return MSG.INIT;
    if (msg.subtype === 'status') return MSG.STATUS;
    if (msg.subtype === 'compact_boundary') return MSG.COMPACT_BOUNDARY;
    return MSG.OTHER_SYSTEM;
  }
  if (msg.type === 'assistant') return MSG.ASSISTANT;
  if (msg.type === 'user') return MSG.USER;
  if (msg.type === 'result') return MSG.RESULT;
  return MSG.UNRECOGNISED;
}

/** The concatenated text of an assistant message's text blocks. '' when there is none. */
function assistantText(msg) {
  const content = msg && msg.message && msg.message.content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => isObj(b) && b.type === 'text').map((b) => String(b.text || '')).join('\n');
}

/**
 * Read a whole turn's lines into an OBSERVATION — the typed digest of what the host said, with every
 * line it was derived from kept verbatim.
 *
 * `lines` is an array of raw strings exactly as they came off stdout. Nothing is normalised: the raw
 * strings are what the evidence records carry, because a field this adapter re-spells today is a field
 * a later reviewer cannot re-interpret tomorrow.
 */
function observe(lines) {
  const obs = {
    lines: [],                 // { i, raw, kind } for every line, in order
    parsed: [],                // successfully parsed messages, in order
    unparsed: [],              // { i, raw, reason } — reported, never interpreted
    unrecognised: [],          // parsed, but no declared shape
    init: null,                // the FIRST init message
    inits: [],
    statuses: [],
    boundary: null,            // the FIRST compact_boundary message
    boundaries: [],            // all of them — a second one is a duplicate, and duplicates are events
    result: null,              // the LAST result message
    results: [],
    assistants: [],
    sessionIds: [],            // every distinct session_id seen, in first-seen order
    auth: { failed: false, phrase: null, verbatim: null, from: null },
  };

  (Array.isArray(lines) ? lines : []).forEach((raw, i) => {
    const p = parseLine(raw);
    if (!p.ok) {
      obs.lines.push({ i, raw: String(raw), kind: MSG.UNRECOGNISED });
      obs.unparsed.push({ i, raw: String(raw), reason: p.reason });
      return;
    }
    const { msg, kind } = p;
    obs.lines.push({ i, raw: String(raw), kind });
    obs.parsed.push(msg);

    if (typeof msg.session_id === 'string' && msg.session_id && !obs.sessionIds.includes(msg.session_id)) {
      obs.sessionIds.push(msg.session_id);
    }

    switch (kind) {
      case MSG.INIT:
        obs.inits.push(msg);
        if (!obs.init) obs.init = msg;
        break;
      case MSG.STATUS:
        obs.statuses.push(msg);
        break;
      case MSG.COMPACT_BOUNDARY:
        obs.boundaries.push({ msg, raw: String(raw), i });
        if (!obs.boundary) obs.boundary = { msg, raw: String(raw), i };
        break;
      case MSG.ASSISTANT:
        obs.assistants.push(msg);
        break;
      case MSG.RESULT:
        obs.results.push({ msg, raw: String(raw), i });
        obs.result = { msg, raw: String(raw), i };
        break;
      case MSG.UNRECOGNISED:
        obs.unrecognised.push({ i, raw: String(raw) });
        break;
      default:
        break;
    }
  });

  detectAuth(obs);
  return obs;
}

/**
 * Did the host report an AUTHENTICATION failure? Judged from what it said, in this order of directness:
 * the assistant message's own `error` field, then a compact_error, then the result text.
 */
function detectAuth(obs) {
  for (const a of obs.assistants) {
    if (lower(a.error) === 'authentication_failed') {
      obs.auth = { failed: true, phrase: 'authentication_failed', verbatim: assistantText(a) || String(a.error), from: 'assistant.error' };
      return obs;
    }
  }
  for (const s of obs.statuses) {
    const hit = containsAny(s.compact_error, AUTH_PHRASES);
    if (hit) {
      obs.auth = { failed: true, phrase: hit, verbatim: String(s.compact_error), from: 'status.compact_error' };
      return obs;
    }
  }
  for (const a of obs.assistants) {
    const text = assistantText(a);
    const hit = containsAny(text, AUTH_PHRASES);
    if (hit) { obs.auth = { failed: true, phrase: hit, verbatim: text, from: 'assistant.text' }; return obs; }
  }
  if (obs.result) {
    const hit = containsAny(obs.result.msg.result, AUTH_PHRASES);
    if (hit) { obs.auth = { failed: true, phrase: hit, verbatim: String(obs.result.msg.result), from: 'result.result' }; return obs; }
  }
  return obs;
}

/**
 * THE COMPACTION VERDICT. See the header: keyed on control-flow messages, never on `result.subtype`
 * or `result.is_error`.
 *
 * @param obs        an observation from observe()
 * @param waitedMs   how long the caller waited. Carried ONLY on UNOBSERVED, where it is the single
 *                   fact the record has — and even there it is a measurement of the clock, not of a
 *                   compaction.
 * @returns {{verdict, signal, sessionId, raw, detail, …}}
 */
function compactVerdict(obs, { waitedMs = null } = {}) {
  const failedStatus = obs.statuses.find((s) => lower(s.compact_result) === 'failed') || null;
  const successStatus = obs.statuses.find((s) => lower(s.compact_result) === 'success') || null;
  const compactingStatus = obs.statuses.find((s) => lower(s.status) === 'compacting') || null;

  const base = {
    sawCompactingStatus: Boolean(compactingStatus),
    sawSuccessStatus: Boolean(successStatus),
    boundaryCount: obs.boundaries.length,
    // Recorded so a reader can SEE that the envelope disagreed with the verdict, which is the whole
    // point of this module. Never consulted to decide anything.
    resultEnvelope: obs.result
      ? { subtype: obs.result.msg.subtype ?? null, is_error: obs.result.msg.is_error ?? null, num_turns: obs.result.msg.num_turns ?? null }
      : null,
  };

  if (obs.boundary && failedStatus) {
    return {
      ...base,
      verdict: VERDICT.CONTRADICTORY,
      signal: null,
      sessionId: obs.boundary.msg.session_id || null,
      raw: [obs.boundary.raw, JSON.stringify(failedStatus)],
      detail: `the host emitted a compact_boundary AND compact_result:"failed" (${String(failedStatus.compact_error || 'no compact_error')}). `
        + 'Two documented signals disagree, so this is neither a completion nor a failure.',
    };
  }

  if (obs.boundary) {
    const meta = isObj(obs.boundary.msg.compact_metadata) ? obs.boundary.msg.compact_metadata : {};
    return {
      ...base,
      verdict: VERDICT.COMPLETED,
      signal: 'compact_boundary',
      sessionId: obs.boundary.msg.session_id || (obs.result && obs.result.msg.session_id) || null,
      raw: obs.boundary.raw,
      // Typed beside the raw line, never instead of it. Absent fields stay null rather than 0: a
      // post_tokens the host did not send is not a context that compacted to nothing.
      metadata: {
        trigger: meta.trigger ?? null,
        preTokens: Number.isFinite(meta.pre_tokens) ? meta.pre_tokens : null,
        postTokens: Number.isFinite(meta.post_tokens) ? meta.post_tokens : null,
        durationMs: Number.isFinite(meta.duration_ms) ? meta.duration_ms : null,
        preservedSegment: meta.preserved_segment || null,
        preservedMessages: meta.preserved_messages || null,
      },
      detail: null,
    };
  }

  if (failedStatus) {
    return {
      ...base,
      verdict: VERDICT.FAILED,
      signal: null,
      sessionId: failedStatus.session_id || (obs.result && obs.result.msg.session_id) || null,
      raw: JSON.stringify(failedStatus),
      compactError: failedStatus.compact_error ? String(failedStatus.compact_error) : null,
      detail: `the host reported compact_result:"failed"${failedStatus.compact_error ? `: ${failedStatus.compact_error}` : ''}`,
    };
  }

  const noopText = obs.result ? containsAny(obs.result.msg.result, NOOP_PHRASES) : null;
  if (noopText) {
    return {
      ...base,
      verdict: VERDICT.NOOP,
      signal: null,
      sessionId: obs.result.msg.session_id || null,
      raw: obs.result.raw,
      hostResult: String(obs.result.msg.result),
      detail: 'the host declined to compact and said so in its own words; no boundary was emitted',
    };
  }

  return {
    ...base,
    verdict: VERDICT.UNOBSERVED,
    signal: null,
    sessionId: (obs.result && obs.result.msg.session_id) || obs.sessionIds[0] || null,
    raw: obs.lines.length ? obs.lines.map((l) => l.raw).join('\n') : null,
    waitedMs,
    reason: obs.result ? 'no-signal' : 'stream-closed',
    detail: obs.result
      ? 'the turn produced a result and NO compaction signal of any kind. The result envelope says nothing about compaction and is not read here.'
      : 'the stream ended without a result and without any compaction signal',
  };
}

/**
 * The occupancy numbers off the latest assistant message. Documented usage fields; see measure.js for
 * what they are divided BY, which is the part this host does not publish.
 *
 * @returns {{ok:boolean, usedTokens, parts, raw, model, why}}
 */
function latestUsage(obs) {
  for (let i = obs.assistants.length - 1; i >= 0; i -= 1) {
    const a = obs.assistants[i];
    const u = a && a.message && a.message.usage;
    if (!isObj(u)) continue;
    const input = Number(u.input_tokens) || 0;
    const cacheRead = Number(u.cache_read_input_tokens) || 0;
    const cacheCreate = Number(u.cache_creation_input_tokens) || 0;
    // An all-zero usage block is what a synthetic/error message carries (observed live on the auth
    // failures). It is not a measurement of an empty context; it is the absence of one.
    if (input + cacheRead + cacheCreate === 0) continue;
    return {
      ok: true,
      usedTokens: input + cacheRead + cacheCreate,
      parts: { inputTokens: input, cacheReadInputTokens: cacheRead, cacheCreationInputTokens: cacheCreate, outputTokens: Number(u.output_tokens) || 0 },
      model: (a.message && a.message.model) || null,
      raw: u,
      why: null,
    };
  }
  return {
    ok: false, usedTokens: null, parts: null, model: null, raw: null,
    why: obs.assistants.length
      ? 'every assistant message in this turn carried an all-zero usage block, which is the shape an error/synthetic message has — not a measurement of an empty context'
      : 'the turn produced no assistant message, so there is no usage block to read',
  };
}

/**
 * The host-reported context window, when it is there. `modelUsage` is keyed by model id and each entry
 * is a ModelUsage carrying `contextWindow` — the ONLY published statement of the denominator.
 *
 * @returns {{ok:boolean, contextWindow:number|null, model:string|null, raw:any, why:string|null}}
 */
function reportedContextWindow(obs) {
  const mu = obs.result && obs.result.msg && obs.result.msg.modelUsage;
  if (!isObj(mu) || !Object.keys(mu).length) {
    return { ok: false, contextWindow: null, model: null, raw: mu || null, why: 'the result carried no populated modelUsage, so the host published no context-window size' };
  }
  let best = null;
  for (const [model, entry] of Object.entries(mu)) {
    if (isObj(entry) && Number.isFinite(entry.contextWindow) && entry.contextWindow > 0) {
      if (!best || entry.contextWindow > best.contextWindow) best = { model, contextWindow: entry.contextWindow, raw: entry };
    }
  }
  if (!best) return { ok: false, contextWindow: null, model: null, raw: mu, why: 'modelUsage is populated and no entry carries a usable contextWindow' };
  return { ok: true, contextWindow: best.contextWindow, model: best.model, raw: best.raw, why: null };
}

/** Does this host build dispatch `/compact`? Read off the init message's OPEN slash_commands set. */
function supportsCompactCommand(obs) {
  const cmds = obs.init && Array.isArray(obs.init.slash_commands) ? obs.init.slash_commands : null;
  if (!cmds) return { ok: false, present: false, why: 'no init message, so the slash-command set was never enumerated' };
  return {
    ok: true,
    present: cmds.includes('compact'),
    commands: cmds,
    why: cmds.includes('compact') ? null : `this build enumerated ${cmds.length} slash commands and "compact" is not among them`,
  };
}

/** The session id this turn belongs to, preferring the result (present on every result message). */
function sessionIdOf(obs) {
  if (obs.result && typeof obs.result.msg.session_id === 'string' && obs.result.msg.session_id) return obs.result.msg.session_id;
  if (obs.init && typeof obs.init.session_id === 'string' && obs.init.session_id) return obs.init.session_id;
  return obs.sessionIds[0] || null;
}

/** Every text block the assistant produced this turn, joined. Used to look for an echoed nonce. */
function allAssistantText(obs) {
  return obs.assistants.map(assistantText).filter(Boolean).join('\n');
}

module.exports = {
  MSG, VERDICT, NOOP_PHRASES, AUTH_PHRASES,
  parseLine, classify, observe, compactVerdict,
  latestUsage, reportedContextWindow, supportsCompactCommand,
  sessionIdOf, assistantText, allAssistantText,
};
