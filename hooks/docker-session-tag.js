#!/usr/bin/env node
/*
 * RespawnPack · docker-session-tag.js — PreToolUse rewrite hook on Bash. When Claude runs a plain, leading
 * `docker run …` / `docker create …`, it stamps the container so it is (a) session-scoped and (b) humanly
 * identifiable — the two properties the owner's container-lifecycle policy needs to reap AI-started
 * containers safely at session boundaries (see mcp-reaper.js). RespawnPack-original (see ATTRIBUTION.md).
 *
 * WHAT IT INJECTS, immediately after the `run`/`create` subcommand:
 *   • `--label respawnpack.session=<session_id>`  — ALWAYS (this is what mcp-reaper filters on at SessionEnd).
 *   • `--name respawnpack-<imagebase>-<4hex>`      — ONLY when the command has no `--name` already AND the
 *                                                     image basename parsed with confidence (else skipped —
 *                                                     the label alone is enough; the name is cosmetic).
 * It deliberately does NOT inject a CLASS label: the human/AI declares `--label respawnpack.class=temp` for a
 * disposable on purpose, and absence-of-class = infra = stop-only at reap time (the safe default). So a wrong
 * guess here can never escalate a container to "removable" — only an explicit temp label does that.
 *
 * PRECISION FIRST — rewrite only the case we can parse with confidence; ADVISE (never mis-rewrite) otherwise:
 *   • Only a SINGLE, plain, LEADING `docker run`/`create` is rewritten. Multi-line / heredoc / `&&`-chained
 *     multiple docker runs / a docker run that is not the first command → advisory systemMessage instead.
 *   • `docker compose up -d` (and legacy `docker-compose up -d`) → advisory ONLY: compose has per-service
 *     label semantics (labels live under each service in the compose file), so this hook never rewrites it.
 *   • Image parsing is best-effort and self-aware: an unknown flag whose value-arity we can't determine → we
 *     skip the NAME (keep the label). The label is always placed right after the subcommand, which is valid
 *     regardless of the rest of the command.
 *   • A malformed/absent session id, or a session id outside [A-Za-z0-9._-] (Claude session ids are UUIDs), →
 *     advisory rather than embedding an unvalidated value into a shell command string.
 *
 * Mirrors websearch-freshness.js's verified output contract: a rewrite is emitted via
 * `hookSpecificOutput.updatedInput` (the tool-input-middleware field the current harness honors) paired with
 * `permissionDecision:"allow"`, plus a one-line `systemMessage`; an advisory is a bare `systemMessage`.
 * Never denies (a docker run is legitimate; the worst we do is decline to rewrite and remind the convention).
 *
 * Opt-out: `.respawnpack/docker-session-tag.off` in the project dir.
 *
 * POSTURE (ADR-003 / P3-T-10c): the label/name rewrite above is `docker-session-tag:label`, fixed ON in
 * every profile (the rework task list, anti-drift item 26) — it is never routed through hooks/_posture.js at all,
 * because mcp-reaper reaps by that label and an absent label is an unreaped container. Only the
 * compose/chained ADVISORY (adviseGeneric/adviseCompose below) is switchable as `docker-session-tag:advise`:
 * silent under `light`, unchanged (a systemMessage) under `standard`/`strict`, and under a config that is
 * absent, invalid or unreadable (all of which resolve to strict). Resolved once per invocation, beside
 * the `.off` marker check above, and threaded down to both advisory functions.
 *
 * Contract (Claude Code hooks): stdin = PreToolUse JSON {tool_name, session_id, tool_input:{command}}.
 * Rewrite = stdout JSON {hookSpecificOutput:{hookEventName,permissionDecision:"allow",updatedInput}, systemMessage} + exit 0.
 * Advise  = stdout JSON {systemMessage} + exit 0.  Non-docker / malformed stdin / marker-off → silent exit 0.
 *
 * ⭐ TWO ENTRY POINTS, ONE DECISION (P4-T-15a). `check(ctx)` is the whole policy and returns the verdict
 * as data; the standalone path below builds the context from stdin and the environment and prints it.
 * The posture arrives as `ctx.profile` and is still taken at the SAME point in the pass it always was —
 * beside the `.off` marker check — because the getter behind it memoises rather than resolving eagerly.
 * See hooks/README.md, "The `check(ctx)` contract".
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
/*
 * Booted through _boot.js like every other hook with a shared dependency, and armed DENY: if the
 * posture reader will not load, this hook cannot know whether to advise, but it also cannot label,
 * and an unlabelled container is exactly what the fixed rule (anti-drift item 26) forbids. A hook that
 * cannot label refuses the docker command rather than letting an unreapable container through.
 */
const boot = require('./_boot.js');
boot.arm('deny');
const posture = boot.need('./_posture.js');

const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();

// Docker `run`/`create` SHORT flags: boolean (consume no following token) vs value-taking (consume one).
// Everything unknown biases toward "skip the name," never toward mistaking a flag value for the image.
const BOOL_SHORT = new Set(['d', 'i', 't', 'P']);                    // -d -i -t (and clusters like -it), -P
const VALUE_SHORT = new Set(['e', 'p', 'v', 'l', 'u', 'w', 'm', 'h', 'a']); // -e -p -v -l -u -w -m -h -a
// Value-taking is the majority of docker LONG flags, so we enumerate only the common BOOLEAN longs and treat
// every other `--flag value` (space form) as value-taking. A miss here just eats the image → name skipped.
const BOOL_LONG = new Set([
  '--detach', '--interactive', '--tty', '--rm', '--privileged', '--init', '--read-only', '--publish-all',
  '--no-healthcheck', '--oom-kill-disable', '--sig-proxy', '--disable-content-trust', '--quiet', '--help',
]);

// Quote-aware tokenizer: split into shell-ish tokens, honoring '…' and "…" as grouping (quotes stripped).
function tokenize(s) {
  const toks = [];
  let cur = '', q = null, has = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) { if (ch === q) q = null; else cur += ch; has = true; continue; }
    if (ch === '"' || ch === "'") { q = ch; has = true; continue; }
    if (/\s/.test(ch)) { if (has) { toks.push(cur); cur = ''; has = false; } continue; }
    cur += ch; has = true;
  }
  if (has) toks.push(cur);
  return toks;
}

// Split a command into shell segments on ; | & (incl. && ||) and newlines that are OUTSIDE quotes.
function splitSegments(s) {
  const segs = [];
  let cur = '', q = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) { cur += ch; if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { q = ch; cur += ch; continue; }
    if (ch === ';' || ch === '\n' || ch === '|' || ch === '&') {
      segs.push(cur); cur = '';
      while (i + 1 < s.length && (s[i + 1] === '|' || s[i + 1] === '&')) i++;
      continue;
    }
    cur += ch;
  }
  if (cur) segs.push(cur);
  return segs.filter((x) => x.trim());
}

// Mask quoted spans (contents → spaces) so a docker-run mention that is only quoted DATA can't trip the
// advisory fallback (e.g. `echo "docker run nginx"` stays silent).
function maskQuoted(s) {
  let out = '', q = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) { out += (ch === q ? (q = null, ' ') : ' '); continue; }
    if (ch === '"' || ch === "'" || ch === '`') { q = ch; out += ' '; continue; }
    out += ch;
  }
  return out;
}

// Lead parse of a segment: strip env-assignments + benign prefixes (sudo/env/…), return the binary basename
// (`word`), its next token (`sub`), and everything after the binary (`after`, which starts at `sub`).
function segLead(seg) {
  let t = seg.replace(/^[\s(]+/, '');
  for (;;) {
    const b = t;
    t = t.replace(/^\w+=\S*\s+/, '');                                     // FOO=bar
    t = t.replace(/^(?:sudo|command|env|time|nice|nohup|exec)\s+/i, '');  // benign launch prefixes
    if (t === b) break;
  }
  const m = /^(\S+)\s*(\S*)/.exec(t);
  if (!m) return { word: '', sub: '', after: '' };
  const word = m[1].toLowerCase().replace(/^.*[\\/]/, '');
  const sub = (m[2] || '').toLowerCase();
  const after = t.slice(m[1].length).replace(/^\s+/, '');
  return { word, sub, after };
}

const isDockerRun = (lead) => lead.word === 'docker' && (lead.sub === 'run' || lead.sub === 'create');

function isComposeUpDetached(lead) {
  let composeArgs = null;
  if (lead.word === 'docker-compose') composeArgs = lead.after;                       // "up -d …"
  else if (lead.word === 'docker' && lead.sub === 'compose') composeArgs = lead.after.replace(/^compose\s*/i, '');
  else return false;
  const hasUp = /(?:^|\s)up(?:\s|$)/.test(composeArgs);
  const hasDetach = /(?:^|\s)(?:-d|--detach)(?:\s|$)/.test(composeArgs) || /(?:^|\s)-[a-z]*d[a-z]*(?:\s|$)/i.test(composeArgs);
  return hasUp && hasDetach;
}

// A short-flag token like "-it": does it consume the NEXT token as a value? {consume, confident}.
function classifyShort(tok) {
  const body = tok.slice(1);
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (BOOL_SHORT.has(c)) continue;
    if (VALUE_SHORT.has(c)) return { consume: i === body.length - 1, confident: true }; // last→next token, else attached value
    return { consume: false, confident: false };                                        // unknown short flag → bail
  }
  return { consume: false, confident: true };                                           // all-boolean cluster
}

// Walk the args after run/create and return the first non-flag token (the IMAGE), or null if not confident.
function parseImage(argToks) {
  let i = 0;
  while (i < argToks.length) {
    const tok = argToks[i];
    if (tok === '--') { i++; break; }                         // explicit end-of-flags → next token is the image
    if (tok.startsWith('--')) {
      if (tok.includes('=')) { i++; continue; }               // --flag=value  → self-contained
      if (BOOL_LONG.has(tok)) { i++; continue; }              // known boolean → no value
      i += 2; continue;                                        // assume value-taking long flag → skip its value
    }
    if (tok.startsWith('-') && tok.length > 1) {
      const { consume, confident } = classifyShort(tok);
      if (!confident) return null;
      i += consume ? 2 : 1; continue;
    }
    return tok;                                                // first bare token → the image
  }
  return argToks[i] || null;                                   // token right after `--`, if any
}

// image ref → sanitized basename sans registry path / tag / digest. '' if nothing usable survives.
function imageBase(ref) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$/.test(ref)) return '';  // not a plausible image ref → not confident
  const noDigest = ref.split('@')[0];
  const afterSlash = noDigest.slice(noDigest.lastIndexOf('/') + 1);       // strip registry/namespace path
  const colon = afterSlash.lastIndexOf(':');
  const noTag = colon >= 0 ? afterSlash.slice(0, colon) : afterSlash;     // strip :tag (safe: after last '/')
  return noTag.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// ---- convention reminders (advisory paths) ----------------------------------------------------------------
const CONVENTION =
  'Label AI-started containers so they can be closed out: `--label respawnpack.session=<id>`, a human ' +
  '`--name <project>-<service>`, and `--label respawnpack.class=temp` for disposables (stop+rm at session ' +
  'end). Unlabeled = infra = stop-only; `--label respawnpack.keep=true` survives session end.';

// `docker-session-tag:advise` (ADR-003): `off` under light, `advise` (today's systemMessage) under
// standard/strict. Anything other than `off` shows the advisory — the table only ever carries
// off/advise for this id, but a mis-wired consult must tighten, never loosen, so a stray override is
// read the same way as `advise` rather than silently swallowed.
function adviseSuppressed(resolved) {
  return posture.verdict(resolved, 'docker-session-tag:advise') === 'off';
}
function adviseGeneric(resolved) {
  if (adviseSuppressed(resolved)) return null;
  return {
    systemMessage:
      '🐳 RespawnPack docker-session-tag: left this command unchanged — I only auto-label a single, plain, ' +
      'leading `docker run`/`docker create` (this looked multi-line, chained, wrapped, or otherwise ' +
      'ambiguous, so I did not risk a bad rewrite). ' + CONVENTION,
  };
}
function adviseCompose(resolved) {
  if (adviseSuppressed(resolved)) return null;
  return {
    systemMessage:
      '🐳 RespawnPack docker-session-tag: docker compose uses per-service label semantics, so I will not ' +
      'rewrite the command — add labels under each service in the compose file instead (`labels: ' +
      '["respawnpack.session=<id>", "respawnpack.class=temp"]`). Unlabeled services default to infra ' +
      '(stop-only); `respawnpack.keep=true` survives session end.',
  };
}

/**
 * The context this check reads.
 *
 * ⛔ `profile` IS A LAZY GETTER SO THE RESOLUTION STAYS WHERE THE COMMENT SAYS IT IS — beside the `.off`
 * marker check, after the tool-name test, once per invocation. Resolving it at context-build time would
 * read `respawnpack.config.json` on every non-Bash call this hook has nothing to say about, and would
 * move the read away from the site the rule was written at.
 */
function context(input) {
  let resolved;
  return {
    input: input || {},
    projectDir,
    workDir: (input && input.cwd) || projectDir,
    principal: null,
    git: null,
    get profile() {
      if (resolved === undefined) resolved = posture.resolve(projectDir);
      return resolved;
    },
  };
}

/** The pure check. Returns this hook's PreToolUse output as data, or null. */
function check(ctx) {
  const input = ctx.input || {};
  boot.observed(input.hook_event_name); // so a later failure degrades in the shape THIS event expects
  if (input.tool_name !== 'Bash') return null;
  if (fs.existsSync(path.join(ctx.projectDir, '.respawnpack', 'docker-session-tag.off'))) return null;

  // Resolved once per invocation, beside the `.off` marker check just above, and threaded down to
  // both advisory paths. The label/rewrite path below never consults this — `docker-session-tag:label`
  // is fixed on in every posture (anti-drift item 26) and has no key in hooks/_posture.js at all.
  const resolved = ctx.profile;

  const cmd = (input.tool_input && input.tool_input.command) || '';
  if (!cmd) return null;

  const segs = splitSegments(cmd);
  if (!segs.length) return null;
  const firstLead = segLead(segs[0]);

  // Leading docker run/create — the only rewrite path.
  if (isDockerRun(firstLead)) {
    const runSegs = segs.filter((s) => isDockerRun(segLead(s)));
    const tooComplex = /\n/.test(cmd) || /<</.test(cmd) || runSegs.length > 1; // multi-line / heredoc / multiple runs
    if (tooComplex) return adviseGeneric(resolved);

    const sessionId = String(input.session_id || '');
    if (!/^[A-Za-z0-9._-]+$/.test(sessionId)) return adviseGeneric(resolved); // missing/odd session id → don't embed it

    // Build the injection: label always; name only if unnamed and the image parsed with confidence.
    const labelFlag = `--label respawnpack.session=${sessionId}`;
    const argToks = tokenize(firstLead.after.replace(/^\S+\s*/, '')); // args after the subcommand
    const hasName = argToks.some((t) => t === '--name' || t.startsWith('--name='));
    let nameFlag = '';
    if (!hasName) {
      const img = parseImage(argToks);
      const base = img ? imageBase(img) : '';
      if (base) nameFlag = `--name respawnpack-${base}-${crypto.randomBytes(2).toString('hex')}`;
    }

    // Anchor at the leading `docker <sub>` (mirroring segLead's prefix stripping) and splice in right after it.
    const anchor = new RegExp(
      `^(\\s*(?:(?:\\w+=\\S*|sudo|command|env|time|nice|nohup|exec)\\s+)*docker\\s+${firstLead.sub})\\b`, 'i');
    const m = anchor.exec(cmd);
    if (!m) return adviseGeneric(resolved); // couldn't confidently locate the splice point → advise instead of guess

    const inject = ' ' + labelFlag + (nameFlag ? ' ' + nameFlag : '');
    const rewritten = cmd.slice(0, m[0].length) + inject + cmd.slice(m[0].length);

    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        updatedInput: { ...input.tool_input, command: rewritten },
      },
      systemMessage:
        `🐳 RespawnPack docker-session-tag: added ${labelFlag}${nameFlag ? ' ' + nameFlag : ''} to your ` +
        `docker ${firstLead.sub} so this container is session-scoped${nameFlag ? ' and human-identifiable' : ''}. ` +
        'It defaults to infra (stopped, never removed, at session end) — add `--label respawnpack.class=temp` ' +
        'to make it a disposable (stop+rm), or `--label respawnpack.keep=true` to survive session end.',
    };
  }

  // Leading `docker compose up -d` / `docker-compose up -d` → advisory only (per-service label semantics).
  if (isComposeUpDetached(firstLead)) return adviseCompose(resolved);

  // A real (unquoted) docker run/create that wasn't the clean leading command → advise; else stay silent.
  if (/\bdocker\s+(?:run|create)\b/.test(maskQuoted(cmd))) return adviseGeneric(resolved);

  return null;
}

module.exports = { check, context };

// --- standalone entry point ---
if (require.main === module) {
  let raw = '';
  process.stdin.on('data', (d) => (raw += d));
  process.stdin.on('end', () => {
    let input;
    try { input = JSON.parse(raw || '{}'); } catch { process.exit(0); }
    const verdict = check(context(input));
    if (verdict) process.stdout.write(JSON.stringify(verdict));
    process.exit(0);
  });
}
