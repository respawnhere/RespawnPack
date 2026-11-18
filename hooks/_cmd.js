/*
 * RespawnPack · hooks/_cmd.js — shell-command classification shared by the git guards.
 *
 * NOT A HOOK (leading underscore — see the counts fence). It exists because push-guard.js and
 * secret-scan.js were each answering "is this command a git push?" with their own regex, and the
 * behavioral harness caught both directions of failure in the same run:
 *
 *   UNDER-DENY (a real push sails through):
 *     git -C /some/repo push origin main      ← `-C <path>` sits between `git` and `push`
 *     git --no-pager push origin main         ← so does any global option
 *   OVER-DENY (a harmless command is blocked):
 *     git commit -m "explain how git push works"
 *     grep -r "git push" docs/
 *     echo "remember to git push later"
 *
 * ⛔ Both classes come from one root cause, and it is the one DOGFOOD.md DF-007 spent seven failed
 * checks learning: `/\bgit\s+push\b/` asserts on the RENDERED SURFACE of a command string rather than
 * on its structure. A substring cannot tell an invocation from a mention, and it cannot see that
 * `git -C x push` is the same invocation as `git push`.
 *
 * So: split on real shell separators, blank the contents of quoted spans (a quoted mention is inert),
 * tokenize, skip git's global options, and read the actual subcommand.
 *
 * This is deliberately NOT a shell parser. It is a conservative classifier whose failure modes are
 * chosen: unknown syntax leaves the command unclassified, and each caller decides whether that means
 * fail-open or fail-closed. push-guard treats an unparseable-but-push-shaped command as a push.
 */

// git's own global options, the ones that may appear BEFORE the subcommand. Sourced from git(1).
// Split by arity because `-C <path>` swallows the next token while `--no-pager` does not — mis-handling
// that is exactly how `git -C /repo push` slipped past.
const GIT_GLOBAL_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env']);
const GIT_GLOBAL_FLAGS = new Set([
  '-p', '--paginate', '-P', '--no-pager', '--no-replace-objects', '--bare', '--literal-pathspecs',
  '--glob-pathspecs', '--noglob-pathspecs', '--icase-pathspecs', '--no-optional-locks', '--html-path',
  '--man-path', '--info-path', '--no-lazy-fetch', '--attr-source',
]);

// Command prefixes that wrap another command; the real invocation is what follows.
const WRAPPERS = new Set(['sudo', 'doas', 'command', 'nohup', 'time', 'nice', 'stdbuf', 'xargs', 'env']);

/** Blank the CONTENTS of quoted spans, preserving the quotes so tokenization still sees a token. */
function dequote(cmd) {
  return String(cmd).replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');
}

/**
 * Split a command line into independently-executed segments on `;`, `&&`, `||`, `|`, `&` and newlines.
 * Runs on the dequoted view so a separator inside a string literal does not split anything.
 */
function segments(cmd) {
  return dequote(cmd)
    .split(/(?:\|\||&&|[;\n|&])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function tokenize(segment) {
  return segment.split(/\s+/).filter(Boolean);
}

/**
 * Given one segment, return the git subcommand it invokes, or null.
 * Handles wrappers, leading VAR=value assignments, absolute/quoted git paths, and git global options.
 */
function gitSubcommand(segment) {
  let toks = tokenize(segment);

  // Peel wrappers and environment assignments: `sudo git push`, `FOO=bar git push`, `env X=1 git push`.
  for (let guard = 0; guard < 8 && toks.length; guard++) {
    const t0 = toks[0];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t0)) { toks = toks.slice(1); continue; }
    const base = t0.replace(/^.*[/\\]/, '').replace(/\.exe$/i, '').replace(/^["']|["']$/g, '');
    if (WRAPPERS.has(base)) { toks = toks.slice(1); continue; }
    break;
  }
  if (!toks.length) return null;

  const bin = toks[0].replace(/^.*[/\\]/, '').replace(/\.exe$/i, '').replace(/^["']|["']$/g, '');
  if (bin !== 'git') return null;

  for (let i = 1; i < toks.length; i++) {
    const t = toks[i];
    if (GIT_GLOBAL_WITH_VALUE.has(t)) { i++; continue; }         // consumes its value
    if (t.startsWith('--') && t.includes('=')) {                  // --git-dir=/x form
      if (GIT_GLOBAL_WITH_VALUE.has(t.slice(0, t.indexOf('=')))) continue;
      continue;                                                   // unknown --opt=value before a subcommand
    }
    if (GIT_GLOBAL_FLAGS.has(t)) continue;
    if (t.startsWith('-')) continue;                              // unknown global flag — keep scanning
    return t;                                                     // first non-option token is the subcommand
  }
  return null;
}

/** Every git subcommand invoked anywhere in the command line. */
function gitSubcommands(cmd) {
  return segments(cmd).map(gitSubcommand).filter(Boolean);
}

const invokesGit = (cmd, sub) => gitSubcommands(cmd).includes(sub);

module.exports = { dequote, segments, tokenize, gitSubcommand, gitSubcommands, invokesGit };
