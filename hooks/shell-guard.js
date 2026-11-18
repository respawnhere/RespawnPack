#!/usr/bin/env node
/*
 * RespawnPack · shell-guard.js — PreToolUse hard-block hook that denies categorically-destructive shell
 * commands. RespawnPack's other Bash deny-hooks (push-guard, secret-scan) are git-specific; nothing else
 * stopped `rm -rf /`, `mkfs`, `dd of=/dev/sda`, a fork bomb, `chmod -R 777 /`, or a remote script piped
 * into a shell. Concept credited to the aggregator's dangerous-command-blocker + shell-wrapper-guard hooks
 * (both MIT), adopted as the pair they are: the blocker's end-anchored patterns are bypassable through a
 * wrapper exactly the way its companion wrapper-guard catches, so shipping one without the other would be
 * pre-broken — re-derived in RespawnPack's file shape (see ATTRIBUTION.md).
 *
 * git is push-guard's lane — deliberately NOT duplicated here. This hook is destructive-shell only.
 *
 * DESIGN (precision first — a normal dev command must never trip):
 *   • COMMAND-AWARE, not blind string-matching. The command is split into segments (quote-aware, so a `|`
 *     or `;` inside quotes is data, not a separator) and each segment's LEAD WORD is examined. A
 *     destructive detector fires only when the lead word IS that destructive command — so `rm -rf /` denies
 *     but `echo "rm -rf /"` and `git commit -m "rm -rf /"` (the scary text is a quoted ARG = data) do not.
 *   • Layer 1 — direct danger classes on the operative command: recursive force-remove of a ROOT / HOME /
 *     DRIVE-ROOT target only (rm -rf / | ~ | C:\, incl. --no-preserve-root) — a specific/relative path like
 *     `rm -rf node_modules` or `rm -rf ./dist` is ALLOWED; filesystem creation (mkfs…); raw disk writes
 *     (dd of=/dev/sd…, > /dev/sd…); fork bombs (:(){ :|:& };:); blanket recursive perms on a root (chmod -R … /);
 *     remote/base64 script piped into a shell (curl … | sh, base64 -d | sh).
 *   • Layer 2 — wrapper detection: the SAME analysis re-runs against the inner command of a real execution
 *     wrapper — `sh -c '…'` / `bash -c "…"`, `eval …`, `$(…)`, backticks, `xargs …`. This is why the walk
 *     pairs the two upstream hooks: `sh -c "rm -rf /"`'s raw string ends in `/"`, not `/`, so a direct
 *     anchor misses it until the wrapper is unwrapped. Only *executed* inner strings are unwrapped (a
 *     substitution inside single quotes is literal → left alone), matching real shell semantics.
 *
 * This is a high-precision safety net, not a sandbox: deeply-obfuscated payloads (opaque base64, variable
 * indirection) are out of scope by design — the goal is to stop the catastrophic-by-accident command.
 *
 * Escape hatch (house convention, same as worktree-guard's .off marker): create
 * <project>/.respawnpack/shell-guard.off to disable, or remove the hook from .claude/settings.json.
 *
 * ⭐ AND ONE REVIEWED COMMAND AT A TIME (P1-E-1d). The `.off` marker switches off the WHOLE guard, is
 * untracked, and carries no reason — three properties that make it the wrong instrument for "this one
 * `rm -rf … --no-preserve-root` in our range teardown is fine". A declared exception in
 * `respawnpack.config.json` names ONE command by fingerprint, with a reason, in a tracked file
 * `index-guard`'s CONTROL_PLANE already keeps a subagent out of, and the guard still SAYS it lifted.
 * `shell-guard:catastrophe` stays `deny` for every other command (anti-drift item 25); the marker stays
 * as the untracked local escape it always was.
 *
 * Contract (Claude Code hooks): stdin = PreToolUse JSON {tool_name, tool_input:{command}}.
 * Deny = stdout JSON {hookSpecificOutput:{hookEventName,permissionDecision:"deny",permissionDecisionReason}} + exit 0.
 * No hit = exit 0 silently. Never denies anything outside the catastrophic set above.
 *
 * ⭐ TWO ENTRY POINTS, ONE DECISION (P4-T-15a). `check(ctx)` is the whole policy and returns the verdict
 * as data; the standalone path below builds the context from stdin and the environment and prints it.
 * See hooks/README.md, "The `check(ctx)` contract".
 */
const fs = require('fs');
const path = require('path');
/*
 * ⛔ FAIL CLOSED, THROUGH THE BOOTSTRAP BOUNDARY (anti-drift item 27). This hook had no shared
 * dependency until it began reading the project's declared exceptions, and the direction that reader
 * fails in is the whole reason it is bound through `need()` rather than `require()`: a bare require of
 * an `_exceptions.js` that will not load throws, the hook exits nonzero, the host treats a nonzero
 * PreToolUse exit as a NON-BLOCKING error, and the catastrophic command runs. `boot.arm('deny')` turns
 * that into an explicit DENY at exit 0 instead. A reader that cannot be loaded has not established that
 * this command was excepted, and "not established" is never a lift.
 */
const boot = require('./_boot.js');
boot.arm('deny');
const cmdlib = boot.need('./_cmd.js');
const exceptionsLib = boot.need('./_exceptions.js');

const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const MAX_DEPTH = 4; // wrapper/substitution unwrap ceiling — guards against pathological nesting

/** The one rule id this hook decides, and the one it may ask `_exceptions.js` about. */
const RULE = 'shell-guard:catastrophe';

/**
 * The one sentence a lifted hit is reported on, spelled identically in every guard that reads this
 * grammar (`hooks/hooks.test.mjs` reads the four sources and asserts the literal is one literal).
 * It goes to BOTH channels on purpose: `systemMessage` is user-visible only and `additionalContext` is
 * what the model reads, and a lift that only one of them could see would be a silent lift for the other.
 */
const allowedBy = (e) => `🔓 allowed by exception ${e.id} (${e.rule}): ${e.reason}`;

/** The verdict a lift emits INSTEAD of the deny. */
const lifted = (e) => ({
  systemMessage: allowedBy(e),
  hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: allowedBy(e) },
});

/**
 * What a deny adds when a declaration was consulted and REFUSED.
 *
 * ⛔ ONLY `INVALID`, AND THAT IS DELIBERATE. `DEFAULTED` is the state every project has always been in,
 * and a sentence about exceptions on those denies would change the refusal every existing target
 * receives. `UNREADABLE` means the config could not be parsed at all, which `_posture.js` already
 * resolves to `strict` and reports on stderr — the DECISION for that project must stay byte-identical
 * to the decision a project with no config gets. `INVALID` is the one state where the founder wrote
 * something, it was refused whole, and a deny that did not say so would look exactly like a deny on a
 * declaration that simply did not match.
 */
const refusedNote = (resolved) => (resolved && resolved.source === 'INVALID'
  ? `\n⛔ ${resolved.detail}`
  : '');

// A bare root / home / drive-root argument: /, /*, ~, ~/, C:\, C:/, C:\* — but NOT /home, ~/proj, C:\dir.
const ROOT_TARGET = /(?:^|\s)(?:\/\*?|~\/?|[A-Za-z]:[\\/]?\*?)(?=\s|$)/;
const RECURSIVE = /(?:^|\s)-[a-z]*r/i;      // a short-flag cluster containing r/R (-r, -rf, -fr, -R…)
const isRecursive = (s) => RECURSIVE.test(s) || /--recursive\b/i.test(s);
const DD_OF_DISK = /\bof=\/dev\/(?:sd|nvme|disk|hd|vd|mmcblk)/i;
const SHELLS = '(?:bash|zsh|dash|ksh|csh|ash|sh)';
// Structural classes (operators live OUTSIDE quotes → tested against a quote-masked view of the command).
const REDIR_DISK = /[>]{1,2}\s*\/dev\/(?:sd|nvme|disk|hd|vd|mmcblk)/i;
const FORKBOMB = /([:\w]+)\s*\(\s*\)\s*\{[^{}]*\|\s*\1[^{}]*&[^{}]*\}\s*;\s*\1/;
const REMOTE_PIPE = new RegExp(`(?:^|[\\n;&|(])\\s*(?:sudo\\s+)?(?:curl|wget|fetch)\\b[^\\n|]*\\|\\s*(?:sudo\\s+)?${SHELLS}\\b`, 'i');
const B64_PIPE = new RegExp(`\\bbase64\\b[^\\n|]*(?:-d|--decode)\\b[^\\n|]*\\|\\s*(?:sudo\\s+)?${SHELLS}\\b`, 'i');

// Danger-class strings (each quotes the matched class back to Claude in the deny reason).
const CLS = {
  RM_ROOT: 'recursive force-remove of a root / home / drive-root path (rm -rf / | ~ | C:\\)',
  RM_NPR: 'recursive force-remove of the filesystem root (rm … --no-preserve-root)',
  CHMOD_ROOT: 'blanket recursive permission change on a root path (chmod -R … /)',
  MKFS: 'filesystem creation (mkfs …) — reformats a device',
  DD: 'raw write to a disk device (dd of=/dev/sd…)',
  REDIR: 'redirect into a disk device (> /dev/sd…)',
  FORK: 'fork bomb (self-replicating :(){ :|:& };: shape) — exhausts the process table',
  REMOTE: 'remote script piped straight into a shell (curl … | sh) — runs unreviewed remote code',
  B64: 'base64-decoded payload piped into a shell — obfuscated code execution',
};

// Replace the CONTENTS of quoted spans with spaces so quoted DATA can't trip a structural operator check,
// while operators outside quotes survive. (Used only for the structural pass.)
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
// Split on shell separators (; | & newline, incl. && ||) that are OUTSIDE quotes.
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
// Capture $( … ) and ` … ` substitutions that actually execute — i.e. anywhere EXCEPT inside single
// quotes (which are literal). Substitutions stay active inside double quotes, matching real shell semantics.
function extractSubstitutions(s) {
  const out = [];
  let single = false, dbl = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (single) { if (ch === "'") single = false; continue; } // literal span — nothing executes
    if (ch === "'") { single = true; continue; }
    if (ch === '"') { dbl = !dbl; continue; }                 // double quotes don't suppress substitution
    if (ch === '`') { const j = s.indexOf('`', i + 1); if (j > i) { out.push(s.slice(i + 1, j)); i = j; } continue; }
    if (ch === '$' && s[i + 1] === '(') {
      let depth = 1, j = i + 2;
      for (; j < s.length && depth; j++) { if (s[j] === '(') depth++; else if (s[j] === ')') depth--; }
      out.push(s.slice(i + 2, j - 1)); i = j - 1;
    }
  }
  return out;
}
function stripOuterQuotes(t) {
  t = t.trim();
  const q = t[0];
  if (q === '"' || q === "'" || q === '`') {
    if (t[t.length - 1] === q) return t.slice(1, -1);
    return t.replace(/['"`]/g, ' '); // unbalanced → dissolve strays
  }
  return t;
}
// Lead command word of a segment (basename), after stripping env-assignments and benign prefixes.
function leadWord(seg) {
  let t = seg.replace(/^[\s(){]+/, '');
  for (;;) {
    const b = t;
    t = t.replace(/^\w+=\S*\s+/, '');                                        // FOO=bar
    t = t.replace(/^(?:sudo|command|env|time|nice|nohup|exec|builtin)\s+/i, '');
    if (t === b) break;
  }
  const m = /^(\S+)/.exec(t);
  const word = m ? m[1] : '';
  return { word: word.toLowerCase().replace(/^.*[\\/]/, ''), args: t.slice(word.length) };
}

function rmDanger(args) {
  if (/--no-preserve-root\b/i.test(args)) return CLS.RM_NPR;
  if (!isRecursive(args)) return null;
  return ROOT_TARGET.test(args) ? CLS.RM_ROOT : null;
}
function chmodDanger(args) { return isRecursive(args) && ROOT_TARGET.test(args) ? CLS.CHMOD_ROOT : null; }

// Analyse one command string. depth bounds wrapper/substitution recursion. Returns {cls, viaWrapper} or null.
function classify(s, depth, viaWrapper) {
  if (!s || depth > MAX_DEPTH) return null;

  // Structural classes — tested on a quote-masked view so quoted data never trips them.
  const masked = maskQuoted(s);
  if (FORKBOMB.test(masked)) return { cls: CLS.FORK, viaWrapper };
  if (REMOTE_PIPE.test(masked)) return { cls: CLS.REMOTE, viaWrapper };
  if (B64_PIPE.test(masked)) return { cls: CLS.B64, viaWrapper };
  if (REDIR_DISK.test(masked)) return { cls: CLS.REDIR, viaWrapper };

  // Per-segment, command-aware detection.
  for (const seg of splitSegments(s)) {
    const { word, args } = leadWord(seg);

    // Execution wrappers → unwrap and re-analyse the inner command.
    if (new RegExp(`^${SHELLS}$`).test(word)) {
      const m = /(?:^|\s)-c\s+(.+)$/is.exec(args);
      if (m) { const r = classify(stripOuterQuotes(m[1]), depth + 1, true); if (r) return r; continue; }
    }
    if (word === 'eval') { const r = classify(stripOuterQuotes(args.replace(/^\s+/, '')), depth + 1, true); if (r) return r; continue; }
    if (word === 'xargs') { const after = args.replace(/^(?:\s+-\S+)*\s*/, ''); const r = classify(after, depth + 1, true); if (r) return r; continue; }

    // Destructive commands — quotes around args are just grouping, so strip them before target analysis.
    const unq = args.replace(/['"`]/g, ' ');
    let cls = null;
    if (word === 'rm') cls = rmDanger(unq);
    else if (word === 'chmod') cls = chmodDanger(unq);
    else if (word === 'dd') cls = DD_OF_DISK.test(unq) ? CLS.DD : null;
    else if (/^mkfs(?:\.[a-z0-9]+)?$/.test(word)) cls = CLS.MKFS;
    if (cls) return { cls, viaWrapper };
  }

  // Command substitutions anywhere (execute unless single-quoted) → recurse.
  for (const inner of extractSubstitutions(s)) {
    const r = classify(inner, depth + 1, true);
    if (r) return r;
  }
  return null;
}

/**
 * The context this check reads. `profile` is null: `shell-guard:catastrophe` is in the anti-drift
 * core's security column (item 25), fixed in every posture, so this hook has never consulted one.
 *
 * ⛔ `exceptions` IS A LAZY GETTER THAT MEMOISES, for the reason `push-guard`'s `profile` is one:
 * resolving here, at context-build time, would read `respawnpack.config.json` on every non-Bash call
 * this hook also answers, and would move the one read to a different point in the pass than the
 * decision takes it. The getter reads once, at the moment a hit actually needs an answer, and never
 * twice — so one invocation can never be judged against two readings of a file that can change between
 * them. An exception is asked about a SUBJECT, never a verdict, so there is no posture to reconcile.
 */
function context(input) {
  let declared;
  return {
    input: input || {},
    projectDir,
    workDir: (input && input.cwd) || projectDir,
    principal: null,
    git: null,
    profile: null,
    get exceptions() {
      if (declared === undefined) declared = exceptionsLib.resolve(projectDir);
      return declared;
    },
  };
}

/** The pure check. Returns this hook's PreToolUse output as data, or null. */
function check(ctx) {
  const input = ctx.input || {};
  if (input.tool_name !== 'Bash') return null;
  if (fs.existsSync(path.join(ctx.projectDir, '.respawnpack', 'shell-guard.off'))) return null; // disabled for this repo

  const cmd = (input.tool_input && input.tool_input.command) || '';
  if (!cmd) return null;

  const hit = classify(cmd, 0, false);
  if (!hit) return null;

  /*
   * ⛔ THE SUBJECT IS THE COMMAND THIS GUARD JUDGED, IN ONE SPELLING, AND THE FOUNDER PASTES BACK
   * EXACTLY WHAT THE DENY PRINTED. `cmdlib.dequote` is the pack's existing structural view of a command
   * line — the same normalisation `push-guard` and `secret-scan` classify on — so the fingerprint does
   * not move when a quoted argument is re-quoted. It also means two catastrophes that differ ONLY inside
   * a quoted span share one fingerprint, and an exception is therefore as wide as that view: stated
   * here, in hooks/README.md and in the changelog, rather than discovered.
   */
  const fingerprint = exceptionsLib.fingerprint(cmdlib.dequote(cmd));
  const resolved = ctx.exceptions;
  const lift = exceptionsLib.allowed(resolved, RULE, { command: fingerprint });
  if (lift) return lifted(lift);

  const reason =
    `🔒 shell-guard blocked this command — ${hit.cls}${hit.viaWrapper ? ' (reached through a shell wrapper / substitution)' : ''}. ` +
    `This class of command is categorically destructive with no legitimate autonomous use in RespawnPack's ` +
    `flows, so it is always denied. If you genuinely need it, disable shell-guard for this repo — create ` +
    `.respawnpack/shell-guard.off (or remove the hook from .claude/settings.json) — then run it yourself.\n` +
    `Command fingerprint: ${fingerprint}. To except THIS command and nothing else, add to ` +
    `respawnpack.config.json: {"id": "<a name>", "rule": "${RULE}", "match": {"command": "${fingerprint}"}, ` +
    `"reason": "<why you reviewed and accepted it>"}. Every other command stays denied.${refusedNote(resolved)}`;
  return {
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
  };
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
