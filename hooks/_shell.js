/*
 * RespawnPack · hooks/_shell.js — a shell-aware structural parser for guard decisions.
 *
 * NOT A HOOK (leading underscore — the counts fence excludes these).
 *
 * ⛔ WHY THIS REPLACES THE DEQUOTE-AND-SPLIT APPROACH. `_cmd.js` blanks the CONTENTS of quoted spans so
 * a mention cannot be mistaken for an invocation. That is right for "does this command invoke git
 * push?" and catastrophically wrong for "which index would this command mutate?", because the answer
 * lives in exactly the argument values it erases. Every one of these was ALLOWED by a guard built on
 * the dequoted view:
 *     git.exe -C <main> add -A                    → the binary was matched as the literal token `git`
 *     git -C "<main>" add -A                      → the quoted path became `""`
 *     cd <main> && git add -A                     → segments were analysed with no carried state
 *     export GIT_INDEX_FILE=<main> && git add -A  → overrides were only read inline on one segment
 * Safety cannot be computed from a representation that destroys the values execution depends on.
 *
 * ⛔ AND WHY QUOTE STATE DECIDES WHAT COUNTS AS SYNTAX. The first cut scanned the RAW program text for
 * `$(`, backticks and `>`. That is the same category error one level up: `git commit -m '$(date)'`
 * carries a literal dollar-paren inside single quotes, where the shell treats it as data — so the guard
 * declared the command unanalysable, skipped every ownership check, and returned an advisory that
 * arrived alongside authorization. Characters inside single quotes are data; inside double quotes,
 * `$(` and backticks are live and `>` is not.
 *
 * ⭐ FAIL-CLOSED BY CONSTRUCTION, AND HONEST ABOUT ITS CEILING. This parser models a deliberately small
 * shell: direct invocations, constant `-c` wrappers, `env`, and directory/environment state carried
 * across chained segments. Anything else — `eval`, subshells, command substitution, sourcing, a
 * non-constant program string — is reported as `unsupported`. Callers must then DENY any git index
 * mutation they can still see, because a warning issued at the same moment as an authorization is not
 * an enforcement. Git invoked from inside an arbitrary program (a package script, a Node or Python
 * process, a compiled binary) is NOT visible to this parser at all, and no amount of pattern work here
 * would change that; see the shared-checkout boundary in index-guard.js.
 *
 * ⛔ AND THE THIRD CATEGORY ERROR, CLOSED IN M.1c: A TOKEN'S TEXT IS NOT ITS VALUE. Everything below
 * used to compare the SPELLING of an argument against real paths, so every one of these read as a
 * narrowly-scoped operation on a file that does not exist and sailed past a foreign staged `A.txt`:
 *     export FILE=A.txt && git add -- "$FILE"   → the pathspec was the four characters `$FILE`
 *     git -C "$TARGET" add -- A.txt             → -C resolved to a directory named `$TARGET`
 *     git add -- {A,B}.txt                      → brace expansion is not a filename
 *     git add -- A.txt>/dev/null                → the redirection became part of the pathspec
 *     sh -c "exec git add -- A.txt"             → `exec` was read as the program
 *     command -- / nice -n 5 / sudo -n git …    → wrapper options were sliced off blindly, so the
 *                                                 REMAINING option became the program name
 *     sh -c "if true; then git add -- A.txt; fi" → `then` was read as the program
 *     cmd /c "git -C %TARGET% add -A"           → %VAR% and ^ are cmd syntax this parser never modelled
 * The rule that replaces them is small: a token whose value is decided at RUN TIME is marked `dynamic`,
 * and a caller may not treat a dynamic token as the literal thing it spells. A dynamic PATHSPEC on a
 * known index is conservatively SWEEPING; a dynamic TARGET INDEX is CANNOT_DETERMINE. Wrapper option
 * grammars are transcribed, not guessed, and an unrecognised option fails closed.
 */

const QUOTE = { NONE: 0, SINGLE: 1, DOUBLE: 2 };

// Separators that end one command and begin another. `&&`/`||`/`;`/newline continue in the same shell
// (state carries); `|` and `&` also stay in-process for our purposes.
const SEPARATORS = ['&&', '||', ';;', ';', '|', '\n'];

const MAX_WRAPPER_DEPTH = 4;

// The two constructs a substitution SPAN can be reported as. Named once so `parseProgram` can ask
// "was every unmodelled thing here a substitution?" without re-spelling the message text.
const SUBSTITUTION_CONSTRUCTS = new Set(['command substitution $(...)', 'command substitution with backticks']);

/**
 * ⛔ QUOTE-AWARE construct detection. Returns the distinct unmodelled constructs actually present as
 * SYNTAX. Single-quoted spans are skipped entirely; inside double quotes only substitution is live.
 *
 * ⭐ AND THE SAME WALK RECORDS WHERE THE SUBSTITUTIONS ARE. "There is a construct here" and "here is
 * what is inside it" are two answers, and computing them from two different readings of the text is how
 * a guard ends up descending into a span the shell treats as data. One state machine produces both:
 * `spans` carries every LIVE, OUTERMOST `$(…)` / backtick span with its inner text, so a caller can READ
 * a constant one instead of guessing about it. The construct list is unchanged — a span that is read is
 * still an unmodelled construct, because reading what RUNS inside it says nothing about what its OUTPUT
 * then becomes in the command around it.
 *
 * ⛔ Only OUTERMOST spans, and only balanced ones. A `$(` inside an open span deepens it rather than
 * starting a second, so `$(git $(echo reset) --hard)` yields one span whose inner text still carries the
 * nested `$` — which is exactly what makes it unreadable. An unterminated span is never recorded at all:
 * a slice that had no close is not evidence of anything.
 */
function scanConstructs(text) {
  const found = [];
  const spans = [];
  const add = (why) => { if (!found.includes(why)) found.push(why); };
  let q = QUOTE.NONE;
  /*
   * The one open outermost span, if any: which spelling opened it, where its inner text starts, how many
   * unclosed `(` stand between here and its close, and the QUOTE STATE it was opened in. That last field
   * is what makes `echo "$(git reset --hard)"` close at all — its `)` is read inside double quotes,
   * while the `)` in `$(echo ")")` is not the one that ends the span.
   */
  let open = null;
  const openSpan = (kind, innerStart) => { open = { kind, innerStart, depth: 0, q }; };
  const closeSpan = (i) => { spans.push({ kind: open.kind, inner: text.slice(open.innerStart, i) }); open = null; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q === QUOTE.SINGLE) { if (c === "'") q = QUOTE.NONE; continue; }
    if (q === QUOTE.DOUBLE) {
      if (c === '\\' && i + 1 < text.length && '"\\$`'.includes(text[i + 1])) { i += 1; continue; }
      if (c === '"') { q = QUOTE.NONE; continue; }
      if (c === '$' && text[i + 1] === '(') {
        add('command substitution $(...)');
        if (open && open.kind === '$(') open.depth += 1; else if (!open) openSpan('$(', i + 2);
        i += 1;
        continue;
      }
      if (c === '`') {
        add('command substitution with backticks');
        if (open && open.kind === '`' && open.q === q) closeSpan(i); else if (!open) openSpan('`', i + 1);
        continue;
      }
      if (c === ')' && open && open.kind === '$(' && open.q === q) { if (open.depth) open.depth -= 1; else closeSpan(i); }
      continue;
    }
    if (c === '\\') { i += 1; continue; }
    if (c === "'") { q = QUOTE.SINGLE; continue; }
    if (c === '"') { q = QUOTE.DOUBLE; continue; }
    if (c === '$' && text[i + 1] === '(') {
      add('command substitution $(...)');
      if (open && open.kind === '$(') open.depth += 1; else if (!open) openSpan('$(', i + 2);
      i += 1;
      continue;
    }
    if (c === '`') {
      add('command substitution with backticks');
      if (open && open.kind === '`' && open.q === q) closeSpan(i); else if (!open) openSpan('`', i + 1);
      continue;
    }
    if (c === '<' && text[i + 1] === '(') { add('process substitution'); continue; }
    if (c === '(') {
      if (i === 0 || /[\s;&|]/.test(text[i - 1])) add('subshell');
      if (open && open.kind === '$(' && open.q === q) open.depth += 1;
      continue;
    }
    if (c === ')' && open && open.kind === '$(' && open.q === q) { if (open.depth) open.depth -= 1; else closeSpan(i); }
  }
  return { found, spans };
}

/** The construct list on its own — the shape every caller but `parseProgram` wants. */
function scanUnsupported(text) { return scanConstructs(text).found; }

/*
 * ⛔ A TOKEN WHOSE VALUE IS DECIDED AT RUN TIME IS NOT THE STRING IT SPELLS.
 *
 * ⛔ AND THE INTRODUCER TEST IS A SET MEMBERSHIP, NOT AN ENUMERATION OF THE FORMS SOMEONE THOUGHT OF.
 * The first cut asked whether `$` was followed by `[A-Za-z_{(]`, which is the *named*-parameter case and
 * four other live expansions besides. An adversarial probe walked straight through every one of them
 * with a foreign `A.txt` staged and rewrote it:
 *     git add -- $1A.txt      positional parameter — `$1` expands to nothing, git receives `A.txt`
 *     git add -- $@A.txt      likewise $@ $* $# $? $! $- $$
 *     git add -- $'A.txt'     ANSI-C quoting — a THIRD quoting form, not a `$` followed by a letter
 *     git add -- ~+/A.txt     `~+` is $PWD; the tilde test only matched `~` or `~/`
 *     git add -- A\.txt       an unquoted backslash: POSIX drops it and git receives `A.txt`
 * The replacement is not five more patterns. ANY unquoted or double-quoted `$` introduces an expansion,
 * full stop — a filename containing a literal `$` loses nothing but a scoped classification it can
 * restate by quoting, while every unenumerated form now fails closed instead of open.
 *
 *   $ (any)           parameter, positional, special, arithmetic, ANSI-C and locale quoting alike
 *   `…`               command substitution — separately reported as unsupported, and dynamic either way
 *   {a,b}             brace expansion, unquoted only
 *   ~…                tilde expansion in ALL its forms (~, ~/, ~user, ~+, ~-, ~N)
 *   \x                an unquoted backslash before a non-special character: POSIX drops it, cmd keeps
 *                     it, and the two readings name different files. Ambiguous is not knowable.
 *   %NAME%            cmd's expansion. A POSIX shell would not expand it, but a `cmd /c` program string
 *                     is re-parsed here with POSIX rules, and marking it dynamic can only ever make a
 *                     decision MORE conservative.
 */
const BRACE_EXPANSION = /\{[^{}]*,[^{}]*\}/;
const CMD_EXPANSION = /%[A-Za-z_][A-Za-z0-9_]*%/;
const SHELL_ESCAPABLE = ' \t"\'$`\\\n';

/**
 * Lex one command line into ARGUMENT tokens and REDIRECTIONS, which are different things.
 *
 * ⛔ `git add -- A.txt>/dev/null` has ONE pathspec, not one called `A.txt>/dev/null`. Folding the
 * redirection into the preceding word produced a path that matches nothing, so the operation looked
 * narrowly scoped and the foreign-state intersection came back empty.
 *
 * Each token is {value, quoted, dynamic} — `value` is what execution would see for a LITERAL token,
 * `quoted` distinguishes a mention from an invocation, and `dynamic` says the value is not knowable
 * here at all.
 */
function lex(input) {
  const tokens = [];
  const redirections = [];
  let cur = '';
  let started = false;
  let wasQuoted = false;
  let dynamic = false;
  let ambiguousEscape = false;
  let rawStart = 0;
  let pendingRedirect = null;
  let q = QUOTE.NONE;

  const push = (end) => {
    if (started) {
      const raw = input.slice(rawStart, end);
      // `~` in EVERY form: ~ ~/ ~user ~+ ~- ~N. The old test matched only the first two.
      const dyn = dynamic || ambiguousEscape || BRACE_EXPANSION.test(raw) || /^~/.test(raw) || CMD_EXPANSION.test(raw);
      // Two different reasons a value is unknowable, and they deserve different sentences: an expansion
      // is resolved by the shell at run time, an unquoted backslash is read differently BY DIFFERENT
      // SHELLS. Telling someone their Windows path "is expanded at run time" is not useful advice.
      const why = dynamic || BRACE_EXPANSION.test(raw) || /^~/.test(raw) || CMD_EXPANSION.test(raw) ? 'expansion' : (ambiguousEscape ? 'escape' : null);
      if (pendingRedirect) redirections.push({ op: pendingRedirect, target: cur, dynamic: dyn, dynamicWhy: why });
      else tokens.push({ value: cur, quoted: wasQuoted, dynamic: dyn, dynamicWhy: why });
      pendingRedirect = null;
    }
    cur = ''; started = false; wasQuoted = false; dynamic = false; ambiguousEscape = false;
  };
  const begin = (i) => { if (!started) rawStart = i; };

  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (q === QUOTE.SINGLE) {
      if (c === "'") { q = QUOTE.NONE; continue; }
      cur += c; started = true; continue;
    }
    if (q === QUOTE.DOUBLE) {
      if (c === '"') { q = QUOTE.NONE; continue; }
      if (c === '\\' && i + 1 < input.length && '"\\$`'.includes(input[i + 1])) { cur += input[++i]; started = true; continue; }
      if (c === '$' || c === '`') dynamic = true;   // live inside double quotes, in every form
      cur += c; started = true; continue;
    }
    if (c === "'") { begin(i); q = QUOTE.SINGLE; started = true; wasQuoted = true; continue; }
    if (c === '"') { begin(i); q = QUOTE.DOUBLE; started = true; wasQuoted = true; continue; }
    /*
     * ⛔ A backslash escapes only a SHELL-SPECIAL character, and the OTHER case is AMBIGUOUS rather than
     * literal. Treating it as a universal escape ate the separators in Windows paths — `cd C:\Users\…`
     * became `C:Users…`, which resolved to no repository, so the guard silently skipped the command.
     * Treating it as always literal was the opposite error: POSIX drops the backslash, so `A\.txt`
     * reaches git as `A.txt` and swept a foreign staged entry the guard had decided it did not name.
     * Both readings are defensible and they name different files — which is the definition of a value
     * this parser cannot know. The Windows-friendly VALUE is kept (so paths still resolve for
     * diagnostics) and the token is marked dynamic, so no decision rests on the guess.
     */
    if (c === '\\' && i + 1 < input.length && SHELL_ESCAPABLE.includes(input[i + 1])) { begin(i); cur += input[++i]; started = true; continue; }
    // ⛔ `ambiguousEscape`, not `dynamic`. This branch set `dynamic = true`, which made `why` resolve to
    // 'expansion' every time — so `dynamicWhy === 'escape'` was unreachable and the one message written
    // for this case (index-guard's "unquoted backslash, which POSIX shells drop and cmd keeps — quote
    // the path") could never fire. `git -C C:\Users\…\t add -A` was denied with the right verdict and
    // the wrong diagnosis, and the actionable half of the advice was the half that never printed.
    // Both flags mark the token unknowable (see `dyn` in push); only the SENTENCE differs.
    if (c === '\\' && i + 1 < input.length) { begin(i); ambiguousEscape = true; cur += c; started = true; continue; }
    if (c === '>' || c === '<') {
      // A bare leading file-descriptor number belongs to the operator, not to the previous word: the
      // `2` in `2>&1` is not an argument, and pushing it produced a phantom command called `1`.
      if (started && !wasQuoted && /^\d+$/.test(cur)) { cur = ''; started = false; }
      else push(i);
      let op = c;
      while (i + 1 < input.length && (input[i + 1] === c || input[i + 1] === '&' || input[i + 1] === '|')) op += input[++i];
      pendingRedirect = op;
      continue;
    }
    if (/\s/.test(c)) { push(i); continue; }
    begin(i);
    if (c === '$' || c === '`') dynamic = true;    // any unquoted $ introduces an expansion
    cur += c; started = true;
  }
  push(input.length);
  return { tokens, redirections };
}

/** Argument tokens only. Redirections are syntax, not arguments — see `lex`. */
function tokenize(input) { return lex(input).tokens; }

/*
 * ⛔ `hasFileRedirection()` USED TO LIVE HERE AND IS DELETED. Its only caller was the shared-checkout
 * Bash allowance, which M.1c removed — and a redirection predicate with no caller would be one more
 * validator that looks like enforcement and enforces nothing. What the lexer still guarantees, and
 * what actually mattered, is that `git add -- A.txt>/dev/null` has ONE pathspec: redirections come
 * back from `lex()` as their own list and never contaminate an argument.
 */

/** Split a program into command segments, on real separators outside quotes. */
function splitSegments(input) {
  const segments = [];
  let cur = '';
  let q = QUOTE.NONE;

  const flush = () => { if (cur.trim()) segments.push(cur.trim()); cur = ''; };

  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (q !== QUOTE.NONE) {
      cur += c;
      if ((q === QUOTE.SINGLE && c === "'") || (q === QUOTE.DOUBLE && c === '"')) q = QUOTE.NONE;
      continue;
    }
    if (c === "'") { q = QUOTE.SINGLE; cur += c; continue; }
    if (c === '"') { q = QUOTE.DOUBLE; cur += c; continue; }
    if (c === '\\' && i + 1 < input.length) { cur += c + input[++i]; continue; }

    // ⛔ `>|` IS ONE REDIRECTION OPERATOR, NOT A PIPE. Splitting on that `|` cut `printf x >| FILE`
    // into `printf x >` (an empty target) and `FILE`, so the redirection carried no target and the
    // control-plane check had nothing to look at — `printf x >| .respawnpack/push.allowed` was allowed
    // from a subagent. Same shape as the `2>&1` guard below, same fix: a separator that follows a
    // redirection operator belongs to the operator.
    const sep = SEPARATORS.find((s) => input.startsWith(s, i));
    if (sep === '|' && /[<>]$/.test(cur)) { cur += c; continue; }
    if (sep) { flush(); i += sep.length - 1; continue; }
    // ⛔ A bare `&` backgrounds a command and ends a segment — UNLESS it follows a redirection
    // operator, where `2>&1` is one descriptor dup. Splitting there produced a phantom second command
    // called `1`, which then failed the read-only allowlist for a command that writes nothing.
    if (c === '&') { if (/[<>]$/.test(cur)) { cur += c; continue; } flush(); continue; }
    cur += c;
  }
  flush();
  return segments;
}

const GIT_ENV = new Set(['GIT_INDEX_FILE', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CONFIG', 'GIT_CONFIG_GLOBAL']);

/**
 * ⛔ Windows environment variables are case-INSENSITIVE, so `git_index_file=…` is the same override as
 * `GIT_INDEX_FILE=…` there and a case-sensitive comparison simply missed it. On POSIX the lowercase
 * spelling really is a different variable, and flagging it would be a false denial.
 */
function gitEnvKey(key) {
  if (GIT_ENV.has(key)) return key;
  if (process.platform === 'win32') {
    const upper = String(key).toUpperCase();
    if (GIT_ENV.has(upper)) return upper;
  }
  return null;
}

/** `git`, `git.exe`, `/usr/bin/git`, `"C:\Program Files\Git\cmd\git.exe"` — all the same program. */
function binName(token) {
  return String(token || '').replace(/^.*[/\\]/, '').replace(/\.(exe|cmd|bat|com)$/i, '').toLowerCase();
}

// git's own global options that consume the following token.
const GIT_GLOBAL_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env', '--attr-source']);
// Options that can redefine what git EXECUTES (core.pager, an alias, core.sshCommand, the exec path).
const GIT_CONFIG_OVERRIDE = new Set(['-c', '--config-env', '--exec-path']);
/*
 * ⛔ PROGRAMS THAT RUN ANOTHER PROGRAM, WITH THEIR OPTION GRAMMARS TRANSCRIBED.
 *
 * The previous version blindly dropped the wrapper's own token and kept going, which meant the FIRST
 * OPTION became the program name: `nice -n 5 git add -- A.txt` was read as running a program called
 * `-n`, `sudo -n git add …` as `-n`, and `command -- git add …` as `--`. In every case git vanished and
 * the mutation went unchecked.
 *
 * Each entry lists the wrapper's own flags (no value) and value-taking options. `positionals` is how
 * many of the wrapper's OWN non-option arguments precede the command (timeout's DURATION). An option
 * this table does not list makes the invocation UNSUPPORTED rather than silently mis-parsed — the
 * table is small and closed on purpose, and "I don't recognise this flag" must never resolve to
 * "skip it and hope the next token is the program".
 *
 * `env` is not here: it carries assignments and a --chdir of its own and needs real parsing (parseEnv).
 */
const WRAPPER_GRAMMAR = {
  sudo: {
    flags: new Set(['-n', '-b', '-E', '-H', '-i', '-k', '-K', '-l', '-P', '-S', '-s', '-v', '-A', '-B',
      '--non-interactive', '--background', '--preserve-env', '--set-home', '--login', '--remove-timestamp',
      '--reset-timestamp', '--list', '--preserve-groups', '--stdin', '--shell', '--validate', '--askpass', '--bell']),
    value: new Set(['-u', '-g', '-p', '-C', '-h', '-r', '-t', '-U', '-R',
      '--user', '--group', '--prompt', '--close-from', '--host', '--role', '--type', '--other-user', '--chroot']),
    chdir: new Set(['-D', '--chdir']),
    assignments: true,
  },
  doas: { flags: new Set(['-L', '-n', '-s']), value: new Set(['-a', '-u']), chdir: new Set(['-C']) },
  command: { flags: new Set(['-p', '-v', '-V']), value: new Set() },
  nohup: { flags: new Set(), value: new Set() },
  nice: { flags: new Set(), value: new Set(['-n', '--adjustment']), numericShort: true },
  ionice: { flags: new Set(['-t']), value: new Set(['-c', '-n', '-p', '--class', '--classdata', '--pid']) },
  stdbuf: { flags: new Set(), value: new Set(['-i', '-o', '-e', '--input', '--output', '--error']) },
  time: { flags: new Set(['-p', '-a', '-v', '--append', '--verbose', '--portability']), value: new Set(['-o', '-f', '--output', '--format']) },
  // ⛔ timeout's positional is a DURATION (a number with an optional s/m/h/d suffix), not "the next
  // token". Consuming any token ate  as the duration and made the whole command vanish from the model.
  timeout: { flags: new Set(['--foreground', '--preserve-status', '-f', '-p']), value: new Set(['-s', '-k', '--signal', '--kill-after']), positionals: 1, positionalShape: /^[0-9]+(.[0-9]+)?[smhd]?$/ },
  setsid: { flags: new Set(['-c', '-f', '-w', '--ctty', '--fork', '--wait']), value: new Set() },
  // A shell builtin that REPLACES the shell with the named program. `exec git add -- A.txt` is a
  // `git add`, and reading `exec` as the program is how it slipped through.
  exec: { flags: new Set(['-c', '-l']), value: new Set(['-a']) },
};
const WRAPPERS = new Set(Object.keys(WRAPPER_GRAMMAR));

/*
 * Programs that BUILD a command line rather than forwarding one. Their semantics are not modelled, so
 * they are reported unsupported — but the git invocation standing in their arguments is still handed to
 * the caller, which must then refuse it rather than merely warn. `echo` is deliberately NOT here: a
 * word that happens to be `git` in an echo is a mention, and this list stays closed for that reason.
 */
const COMMAND_BUILDERS = new Set(['xargs', 'find', 'parallel', 'watch', 'entr', 'flock', 'su', 'runuser']);

/*
 * ⛔ `find` IS THE ONE MEMBER THAT DOES NOT ALWAYS BUILD A COMMAND LINE, AND TREATING IT AS IF IT DID
 * COST REAL WORK. The the 2026-08-07 field run (§5) recorded `find . -type f` refused with "runs
 * another program through a wrapper… `find`, which builds its command line" — a read-only listing, no
 * `-exec`, nothing to hide, blocked, and the retry was a strictly worse tool (`ls -R`). index-guard's
 * own comment says what should have happened: "a non-git unmodelled command stays advisory, so ordinary
 * development is not blocked." The HIDDEN_PROGRAM refusal fired before that ever applied.
 *
 * ⭐ THE DISTINCTION IS STRUCTURAL, NOT A GUESS ABOUT INTENT. `find` runs a program only via an ACTION
 * PRIMARY, and POSIX + GNU + BSD spell those exactly. With none of them present, `find` executes
 * nothing — there is no hidden program, so "the guard could see no git" is not the thing a hidden
 * command looks like, it is the whole truth about the command.
 *
 * ⛔ WHAT DELIBERATELY DOES NOT CHANGE. Every OTHER builder stays refused: `xargs`, `parallel`, `watch`,
 * `entr`, `flock`, `su`, `runuser` all run a program by construction, and `xargs -I{} sh -c "git add -A"`
 * is the case that swept a human's staged work precisely because the git was invisible inside a quoted
 * token. `-delete`/`-fls`/`-fprint*` are listed alongside the exec family even though they spawn nothing:
 * they WRITE, and a guard that has already decided to be careful about this program should not start
 * splitting hairs about which of its side effects it minds. Long-form `--exec` is not real GNU find
 * syntax, but it is matched anyway — the cost of accepting a spelling that does not exist is zero, and
 * the cost of missing one that does is a swept index.
 */
const FIND_ACTION_PRIMARIES = new Set([
  '-exec', '-execdir', '-ok', '-okdir', '-delete', '-fprint', '-fprint0', '-fprintf', '-fls',
  '--exec', '--execdir', '--delete',
]);
const findBuildsCommand = (list) => list.slice(1).some((t) => FIND_ACTION_PRIMARIES.has(String(t.value)));

/*
 * Shell reserved words that INTRODUCE or CONTINUE a compound command without changing which program
 * this segment runs. `then git add -- A.txt` runs git; reading `then` as the program is how a guarded
 * mutation became invisible. Stripping them is not a claim that the parser models control flow: a
 * mutation that MIGHT run is treated as one that does, which is the only safe reading for a guard.
 */
const CONTROL_LEADERS = new Set(['if', 'then', 'elif', 'else', 'fi', 'while', 'until', 'do', 'done',
  'for', 'case', 'esac', 'select', 'function', '{', '}', '!']);

const POSIX_SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ash', 'ksh']);
const PS_SHELLS = new Set(['powershell', 'pwsh']);
const CMD_SHELLS = new Set(['cmd']);

/*
 * A program string is constant only when nothing in it would be expanded before execution — and WHICH
 * characters expand depends on the shell being asked to run it.
 *
 * ⛔ The single POSIX rule missed cmd entirely. `cmd /c "git -C %TARGET% add -A"` contains no `$` and
 * no backtick, so it was declared constant, re-parsed with POSIX rules, and `%TARGET%` was resolved as
 * a literal directory name that is not a repository — after which the guard skipped the command. The
 * same holds for cmd's caret escape (`git ^-C <path> add -A` reaches git as `-C`) and for delayed
 * expansion (`!VAR!`). This parser does not model cmd's escaping, so it says so instead of guessing.
 */
const DYNAMIC_CHARS = {
  posix: /[$`]/,
  cmd: /[$`%^!]/,
  powershell: /[$`]|@\(/,
};
const isConstantFor = (kind, s) => !DYNAMIC_CHARS[kind].test(String(s));
const isConstant = (s) => isConstantFor('posix', s);

/*
 * `env` options, transcribed rather than guessed. Anything not listed makes the invocation unmodelled:
 * an unrecognised option could consume the token we would otherwise read as the child command.
 */
const ENV_FLAG = new Set(['-i', '--ignore-environment', '-0', '--null', '-v', '--debug']);
const ENV_VALUE = new Set(['-u', '--unset', '-C', '--chdir']);

/**
 * Parse `env [options] [NAME=VALUE]... [command]`.
 * Returns {rest, dir, assignments} or null when the form is not modelled.
 */
function parseEnv(toks, dir, path) {
  let i = 1;
  let cwd = dir;
  let dirDynamic = false;
  for (; i < toks.length; i++) {
    const t = toks[i].value;
    if (t === '--') { i += 1; break; }
    if (!t.startsWith('-')) break;
    if (ENV_FLAG.has(t)) continue;
    if (t === '-S' || t === '--split-string' || /^--split-string=/.test(t)) return null; // re-splits its argument
    if (/^--chdir=/.test(t)) { if (toks[i].dynamic) dirDynamic = true; cwd = path.resolve(cwd, t.slice('--chdir='.length)); continue; }
    if (/^--unset=/.test(t)) continue;
    if (ENV_VALUE.has(t)) {
      const next = toks[i + 1];
      if (next === undefined) return null;
      if (t === '-C' || t === '--chdir') { if (next.dynamic) dirDynamic = true; cwd = path.resolve(cwd, next.value); }
      i += 1;
      continue;
    }
    return null; // an env option we do not model
  }
  const assignments = {};
  for (; i < toks.length; i++) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/.exec(toks[i].value);
    if (!m) break;
    assignments[m[1]] = m[2];
  }
  return { rest: toks.slice(i), dir: cwd, dirDynamic, assignments };
}

/**
 * If `toks` is a shell wrapper carrying a CONSTANT program string, return that string.
 * Returns {program} · {unsupported: why, kind} · null (not a wrapper of this kind).
 *
 * ⭐ `kind: HIDDEN_PROGRAM` marks the cases where the caller EXPLICITLY invoked a wrapper this parser
 * models and then made the program that wrapper runs undeterminable — a `-c` program string built at
 * run time, or a wrapper option whose grammar is not transcribed here, so the program token cannot even
 * be located. Both differ from "this is a script file whose contents I cannot see": the literal
 * alternative is one edit away, so a caller may refuse them and say exactly what to write instead.
 */
const HIDDEN_PROGRAM = 'hidden-program';

function wrappedProgram(bin, toks) {
  if (POSIX_SHELLS.has(bin)) {
    for (let i = 1; i < toks.length; i++) {
      const t = toks[i].value;
      if (/^-[a-zA-Z]*c$/.test(t)) {
        const next = toks[i + 1];
        if (!next) return { unsupported: `${bin} -c with no program string`, kind: HIDDEN_PROGRAM };
        if (next.dynamic || !isConstantFor('posix', next.value)) {
          return { unsupported: `${bin} -c with a program string that is expanded at run time`, kind: HIDDEN_PROGRAM };
        }
        return { program: next.value };
      }
      if (t.startsWith('-')) continue;
      return { unsupported: `${bin} running a script file whose contents are not visible here` };
    }
    return null; // an interactive shell with no program
  }
  if (CMD_SHELLS.has(bin)) {
    for (let i = 1; i < toks.length; i++) {
      const t = toks[i].value.toLowerCase();
      if (t === '/c' || t === '/k' || t === '-c') {
        const rest = toks.slice(i + 1);
        if (!rest.length) return { unsupported: 'cmd /c with no program string', kind: HIDDEN_PROGRAM };
        if (rest.some((x) => x.dynamic || !isConstantFor('cmd', x.value))) {
          return { unsupported: 'cmd /c with a program string carrying cmd expansion or escaping (%VAR%, ^, !VAR!), which this parser does not model', kind: HIDDEN_PROGRAM };
        }
        return { program: rest.length === 1 ? rest[0].value : rest.map((x) => x.value).join(' ') };
      }
      if (t.startsWith('/') || t.startsWith('-')) continue;
      return { unsupported: 'cmd running a batch file whose contents are not visible here' };
    }
    return null;
  }
  if (PS_SHELLS.has(bin)) {
    for (let i = 1; i < toks.length; i++) {
      const t = toks[i].value.toLowerCase();
      // ⛔ An encoded program string is deliberately NOT decoded. Decoding one encoding invites the next;
      // the honest answer is that this form is not modelled.
      if (t === '-e' || t === '-ec' || t.startsWith('-encodedcommand')) return { unsupported: 'powershell -EncodedCommand (an encoded program string is not modelled)', kind: HIDDEN_PROGRAM };
      if (t === '-command' || t === '-c') {
        const rest = toks.slice(i + 1);
        if (!rest.length) return { unsupported: 'powershell -Command with no program string', kind: HIDDEN_PROGRAM };
        if (rest.some((x) => x.dynamic || !isConstantFor('powershell', x.value))) {
          return { unsupported: 'powershell -Command with a program string that is expanded at run time', kind: HIDDEN_PROGRAM };
        }
        return { program: rest.length === 1 ? rest[0].value : rest.map((x) => x.value).join(' ') };
      }
      if (t === '-file' || t === '-f') return { unsupported: 'powershell -File (a script file whose contents are not visible here)' };
      if (t.startsWith('-')) continue;
      return { unsupported: 'powershell running a script whose contents are not visible here' };
    }
    return null;
  }
  return null;
}

/**
 * Strip one modelled wrapper's own options, returning the tokens of the program it runs.
 * Returns {rest} · {unsupported: why} · null when the head is not a modelled wrapper.
 */
function stripWrapper(toks) {
  const g = WRAPPER_GRAMMAR[binName(toks[0].value)];
  if (!g) return null;
  const name = binName(toks[0].value);
  let i = 1;
  let positionals = g.positionals || 0;
  let chdir = null;
  let chdirDynamic = false;
  for (; i < toks.length; i++) {
    const t = toks[i].value;
    if (t === '--') { i += 1; break; }
    if (!t.startsWith('-') || t === '-') {
      if (g.assignments && /^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) continue;
      if (positionals > 0 && (!g.positionalShape || g.positionalShape.test(t))) { positionals -= 1; continue; }
      break; // the program
    }
    const base = t.split('=')[0];
    if (g.flags.has(t) || g.flags.has(base)) continue;
    /*
     * ⛔ A WRAPPER'S DIRECTORY OPTION IS CONSUMED *AND APPLIED*. `sudo --chdir <main> git add -A`,
     * `sudo -D <main> …` and `doas -C <main> …` were parsed correctly — the option and its value were
     * skipped — and then the child command was analysed against the agent's ORIGINAL directory. A
     * worktree subagent aiming that at the orchestrator's checkout got the own-worktree exemption for a
     * command that runs somewhere else entirely. Skipping a token is not the same as understanding it.
     */
    if (g.chdir && g.chdir.has(base)) {
      const v = t.includes('=') ? { value: t.slice(base.length + 1), dynamic: toks[i].dynamic } : toks[i + 1];
      if (!v) return { unsupported: `\`${name} ${base}\` with no directory`, kind: HIDDEN_PROGRAM };
      chdir = v.value; chdirDynamic = Boolean(v.dynamic);
      if (!t.includes('=')) i += 1;
      continue;
    }
    if (g.value.has(base)) { if (!t.includes('=')) i += 1; continue; }
    if (g.numericShort && /^-\d+$/.test(t)) continue;
    // ⛔ FAIL CLOSED, and as HIDDEN_PROGRAM. Skipping an unknown option is how the option AFTER it
    // became the program name; reporting it as a mere "construct" would leave the mutation behind it
    // advisory on the main thread, which is the same authorization-with-a-warning this file exists
    // to stop. The caller explicitly asked for this wrapper, so dropping it is always available.
    return { unsupported: `an option this parser does not model for \`${name}\` (${t})`, kind: HIDDEN_PROGRAM };
  }
  if (positionals > 0) return { unsupported: `\`${name}\` with fewer arguments than its grammar requires`, kind: HIDDEN_PROGRAM };
  return { rest: toks.slice(i), chdir, chdirDynamic };
}

/** Resolve git's global options against the effective directory; return the recorded command. */
function gitCommand(toks, dir, env, gitEnvOverride, seg, path, dirDynamic) {
  let gitDir = dir;
  let sub = null;
  let unsafeOpt = null;
  let configOverride = null;
  const configKeys = [];
  let pathspecMode = null;
  let dynamicDir = Boolean(dirDynamic);
  let dynamicDirWhy = dirDynamic ? 'expansion' : null;
  let i = 1;
  for (; i < toks.length; i++) {
    const t = toks[i].value;
    if (t === '-C') {
      // `-C` is REPEATABLE and each value resolves against the directory established so far. An earlier
      // version incremented the cursor twice here, so it read the path correctly and then skipped past
      // the subcommand — leaving gitSub null, which let `git -C <main> add -A` read as non-mutating.
      const next = toks[i + 1];
      if (next === undefined) break;
      // ⛔ A `-C` whose value is expanded at run time names an index this parser cannot identify. It
      // used to resolve to a directory literally named `$TARGET`, which is not a repository — and a
      // command whose target is not a repository was then SKIPPED.
      if (next.dynamic) { dynamicDir = true; dynamicDirWhy = next.dynamicWhy || 'expansion'; }
      gitDir = path.resolve(gitDir, next.value);
      i += 1;
      continue;
    }
    if (/^--git-dir(=|$)/.test(t) || /^--work-tree(=|$)/.test(t)) { unsafeOpt = t.split('=')[0]; if (!t.includes('=')) i += 1; continue; }
    // ⛔ `--exec-path` REDEFINES WHICH BINARIES `git` RUNS, which is an index-resolution override in
    // every sense that matters. It was recorded as a mere `configOverride` that nothing read, so
    // `git --exec-path=/tmp/evil add -- B.txt` was allowed — a computed validator with no enforcement
    // behind it, the exact shape this file's own header warns against.
    if (/^--exec-path(=|$)/.test(t)) { unsafeOpt = '--exec-path'; if (!t.includes('=')) i += 1; continue; }
    /*
     * ⛔ THE PATHSPEC-MODE GLOBALS CHANGE WHAT A PATHSPEC MATCHES, WHICH IS THE WHOLE QUESTION.
     * `normalizePathspec` refuses `:(icase)` magic and globs — and `git --icase-pathspecs add -- a.txt`
     * spells the same thing as a GLOBAL OPTION, where it was skipped as an unrecognised flag. A
     * literal-looking `a.txt` then matched a foreign staged `A.txt` and overwrote it; the `rm --cached`
     * direction unstaged it. `--literal-pathspecs` is listed too: it is the safe direction, but the
     * point is that the pathspec-matching MODE is a fact about the command, not decoration.
     */
    if (/^--(icase|glob|noglob)-pathspecs$/.test(t)) { pathspecMode = t.slice(2); continue; }
    if (t === '--literal-pathspecs') { pathspecMode = 'literal-pathspecs'; continue; }
    // ⛔ `-c` is also spelled ATTACHED: `git -ccore.pager=<program> log` sets the same override and was
    // read as an unrecognised option. The KEY decides whether it redefines execution.
    if (GIT_CONFIG_OVERRIDE.has(t)) { configOverride = t; configKeys.push(String((toks[i + 1] && toks[i + 1].value) || '')); i += 1; continue; }
    if (/^-c./.test(t)) { configOverride = '-c'; configKeys.push(t.slice(2)); continue; }
    if (/^--config-env=/.test(t)) { configOverride = '--config-env'; configKeys.push(t.slice('--config-env='.length)); continue; }
    if (GIT_GLOBAL_VALUE.has(t)) { i += 1; continue; }
    if (t.startsWith('-')) continue;
    sub = t; break;
  }
  return {
    bin: 'git', gitSub: sub, tokens: toks, args: toks.slice(i + 1),
    dir: gitDir, dirDynamic: dynamicDir, dirDynamicWhy: dynamicDirWhy, pathspecMode, env, gitEnvOverride, unsafeOpt, configOverride, configKeys, segment: seg,
  };
}

/*
 * Config keys that redefine WHAT GIT EXECUTES rather than how it formats output. `-c user.name=x` is
 * ordinary; `-c core.hooksPath=/tmp/x` makes a commit run someone else's script. Listed rather than
 * pattern-matched, so the boundary is inspectable.
 */
const EXECUTION_CONFIG_KEYS = [
  'core.pager', 'core.editor', 'core.sshcommand', 'core.hookspath', 'core.fsmonitor', 'core.gitproxy',
  'sequence.editor', 'diff.external', 'gpg.program', 'ssh.variant', 'protocol.ext.allow',
  'uploadpack.packobjectshook', 'safe.directory', 'include.path', 'includeif',
  /*
   * ⛔ THIS LIST IS NOT CLOSED, AND SAYING SO IS THE POINT. A sixth gate named six more keys that
   * redefine execution and are absent: `credential.helper`, `core.askpass`, `init.templateDir`,
   * `filter.<x>.clean`, `merge.<x>.driver`, `trailer.<x>.command`. Three of those are PATTERNED
   * (`filter.*`, `merge.*`, `trailer.*`), so no fixed array can hold them — which is the reason this
   * is a NAMED-SUBSET check rather than a claim of completeness. The four named ones are added; the
   * patterned families are matched by prefix below. Anything not matched falls through to the same
   * fail-closed default every unknown construct gets, and the surfaces where this matters at all
   * (worktree Bash, the main thread) are declared out of scope in index-guard's header.
   */
  'credential.helper', 'core.askpass', 'init.templatedir',
];
// Patterned families: `filter.<driver>.clean/smudge/process`, `merge.<driver>.driver`,
// `trailer.<token>.command`. A fixed list cannot enumerate a user-chosen middle segment.
const EXECUTION_CONFIG_PATTERNS = [
  /^filter.[^.]+.(clean|smudge|process)$/,
  /^merge.[^.]+.driver$/,
  /^trailer.[^.]+.command$/,
  /^diff.[^.]+.(command|textconv)$/,
];
const redefinesExecution = (key) => {
  const k = String(key || '').toLowerCase().split('=')[0];
  return k.startsWith('alias.') || k.startsWith('includeif.')
    || EXECUTION_CONFIG_KEYS.includes(k)
    || EXECUTION_CONFIG_PATTERNS.some((re) => re.test(k));
};

/**
 * Analyse one command's tokens, following wrappers, `env` and constant `-c` program strings.
 * Pushes zero or more commands onto `out`; records the first unmodelled construct in `notes`.
 */
function analyse(toks, state, effEnv, out, notes, seg, path, depth) {
  /*
   * ⛔ THE STRONGER VERDICT WINS, and it is not always the first one found. `sh -c "$(cat script)"`
   * trips the command-substitution scan first; keeping only that message would file a REFUSABLE
   * dynamic wrapper under the advisory `construct` kind and let it through on the main thread.
   */
  const note = (why, kind) => {
    /*
     * ⛔ COUNTED, NOT JUST RECORDED. A second CONSTRUCT-kind note is deliberately dropped from the
     * message (the first one already says the command is unmodelled), which means the message alone
     * cannot answer "was anything else here unreadable?". `parseProgram` needs that answer before it
     * may claim a program was fully read, and inferring it from an unchanged string would say yes for
     * `echo $(date) && popd`.
     */
    notes.noted = (notes.noted || 0) + 1;
    if (!notes.unsupported) notes.unsupported = why;
    else if (kind === HIDDEN_PROGRAM && notes.unsupportedKind !== HIDDEN_PROGRAM) notes.unsupported = `${why}; ${notes.unsupported}`;
    if (kind === HIDDEN_PROGRAM) notes.unsupportedKind = HIDDEN_PROGRAM;
    else if (!notes.unsupportedKind) notes.unsupportedKind = 'construct';
  };
  if (depth > MAX_WRAPPER_DEPTH) { note('a wrapper nested deeper than the parser follows'); return; }

  let list = toks;
  let dir = state.dir;
  let env = effEnv;
  let dirDynamic = false;

  // Shell reserved words first: `then git add …` and `{ git add …` are git invocations.
  while (list.length && CONTROL_LEADERS.has(list[0].value)) list = list.slice(1);
  if (!list.length) return;

  // Wrappers, with their own option grammars. Repeated because `sudo -n nice -n 5 git …` is legal.
  for (let guard = 0; guard < 8 && list.length; guard++) {
    const stripped = stripWrapper(list);
    if (!stripped) break;
    if (stripped.unsupported) { note(stripped.unsupported, stripped.kind); return; }
    // A wrapper's own --chdir moves where the CHILD runs; skipping it silently was the defect.
    if (stripped.chdir !== null && stripped.chdir !== undefined) {
      if (stripped.chdirDynamic) dirDynamic = true;
      dir = path.resolve(dir, stripped.chdir);
    }
    list = stripped.rest;
    while (list.length && CONTROL_LEADERS.has(list[0].value)) list = list.slice(1);
  }
  if (!list.length) return;

  let bin = binName(list[0].value);

  if (bin === 'env') {
    const parsed = parseEnv(list, dir, path);
    if (!parsed) { note('an `env` invocation whose options the parser does not model'); return; }
    dir = parsed.dir;
    dirDynamic = dirDynamic || parsed.dirDynamic;
    env = { ...env, ...parsed.assignments };
    list = parsed.rest;
    if (!list.length) return; // `env` alone just prints the environment
    for (let guard = 0; guard < 8 && list.length; guard++) {
      const stripped = stripWrapper(list);
      if (!stripped) break;
      if (stripped.unsupported) { note(stripped.unsupported, stripped.kind); return; }
      if (stripped.chdir !== null && stripped.chdir !== undefined) {
        if (stripped.chdirDynamic) dirDynamic = true;
        dir = path.resolve(dir, stripped.chdir);
      }
      list = stripped.rest;
    }
    if (!list.length) return;
    bin = binName(list[0].value);
  }

  const wrapped = wrappedProgram(bin, list);
  if (wrapped) {
    if (wrapped.unsupported) { note(wrapped.unsupported, wrapped.kind); return; }
    // A constant program string is fully visible: analyse it in a CHILD shell (its `cd` does not
    // escape back out) and give the commands inside it the same treatment as any other.
    parseInto(wrapped.program, { dir, env: { ...env } }, out, notes, path, depth + 1);
    return;
  }

  /*
   * ⛔ A PROGRAM THAT BUILDS A COMMAND LINE IS UNMODELLED — BUT THE GIT IN ITS ARGUMENTS IS VISIBLE.
   * `xargs git add --`, `find . -exec git add -A \;` and `flock lock git commit` all reach git with
   * arguments this parser cannot enumerate. Reporting the construct AND surfacing the git invocation
   * lets the caller refuse it, instead of the mutation disappearing behind a name it does not know.
   */
  /*
   * ⛔ A COMMAND BUILDER HIDES ITS PROGRAM, SO IT IS HIDDEN_PROGRAM — NOT AN ADVISORY. The first cut
   * scanned the builder's tokens for one whose binName is `git` and filed the note under the advisory
   * `construct` kind. `xargs git add --` was therefore refused and `xargs -I{} sh -c "git add -A"` was
   * ALLOWED and swept the human's staged work: the git was inside a single QUOTED token, so the scan
   * saw nothing, and seeing nothing was rewarded. Same rule as `eval` and `sh -c "$CMD"` — a program
   * this parser cannot enumerate is refused, and the visible git (when there is one) is surfaced too
   * so the refusal can name it.
   */
  if (COMMAND_BUILDERS.has(bin)) {
    // `find` with no action primary runs no program at all — see FIND_ACTION_PRIMARIES. It is a
    // traversal, so it is not a builder, not HIDDEN_PROGRAM, and not this parser's business.
    if (bin === 'find' && !findBuildsCommand(list)) return;
    const at = list.findIndex((t, idx) => idx > 0 && binName(t.value) === 'git');
    note(`\`${bin}\`, which builds its command line rather than forwarding one`, HIDDEN_PROGRAM);
    if (at > 0) out.push(gitCommand(list.slice(at), dir, env, undefined, seg, path, dirDynamic));
    return;
  }

  // ⛔ `eval` stays UNMODELLED — but its constant argument is still read, so a git index mutation
  // hiding in there is visible to the caller and can be refused rather than merely warned about.
  if (bin === 'eval') {
    const arg = list.slice(1).map((t) => t.value).join(' ');
    const dynamic = list.slice(1).some((t) => t.dynamic) || !isConstant(arg);
    /*
     * ⛔ A CONSTANT `eval` IS ANALYSABLE; A DYNAMIC ONE HIDES EVERYTHING — and the first cut filed both
     * under the ADVISORY kind. So `eval "git add -A"` was correctly denied while
     * `export CMD="git add -A" && eval "$CMD"` was ALLOWED and swept the human's staged work, purely
     * because the string was one variable further away. `sh -c "$CMD"` was already refused; the same
     * hiding through `eval` was rewarded. Same rule for both: the caller chose the wrapper, so the
     * literal alternative is one edit away.
     */
    note('eval', dynamic ? HIDDEN_PROGRAM : 'construct');
    if (arg && !dynamic) parseInto(arg, { dir, env: { ...env } }, out, notes, path, depth + 1);
    return;
  }
  if (bin === 'source' || list[0].value === '.') { note('source/. (runs an unseen script in this shell)'); return; }
  if (bin === 'popd') { note('popd (unmodelled directory change)'); return; }

  if (bin === 'cd' || bin === 'pushd') {
    const target = list[1];
    if (!target || target.value.startsWith('-')) { note(`${bin} with no resolvable target`); return; }
    // ⛔ `cd "$DIR"` moves somewhere this parser cannot name. Resolving `$DIR` as a literal directory
    // would make every later command in the segment report a target index that is simply wrong.
    if (target.dynamic) { state.dirDynamic = true; note('a `cd` whose target is expanded at run time'); return; }
    state.dir = path.resolve(dir, target.value); // a real `cd` persists for everything after it
    return;
  }

  const overrideKey = Object.keys(env).map(gitEnvKey).find(Boolean);
  const gitEnvOverride = overrideKey || undefined;

  if (bin !== 'git') {
    out.push({ bin, tokens: list, args: list.slice(1), dir, env, gitEnvOverride, segment: seg });
    return;
  }
  out.push(gitCommand(list, dir, env, gitEnvOverride, seg, path, dirDynamic || state.dirDynamic));
}

/** Walk a program's segments, carrying `cd` and `export` state the way a shell does. */
function parseInto(text, state, out, notes, path, depth) {
  for (const seg of splitSegments(text)) {
    const lexed = lex(seg);
    /*
     * ⛔ REDIRECTIONS ARE COLLECTED AT EVERY DEPTH, not only from the outer command string. index-guard
     * lexed the top level to catch `echo x > <control file>` — and `sh -c "echo x > <control file>"`
     * sailed past, in a program string this parser already descends into. A wrapper the guard models is
     * not a place to stop looking.
     */
    for (const r of lexed.redirections) notes.redirections.push({ ...r, dir: state.dir });
    let toks = lexed.tokens;
    if (!toks.length) continue;

    // Leading VAR=value assignments: `export` makes them persist, a bare prefix applies to this
    // command only — but for override DETECTION both matter, so both are recorded.
    const localEnv = {};
    let isExport = false;
    if (binName(toks[0].value) === 'export' || toks[0].value === 'set') { isExport = true; toks = toks.slice(1); }
    while (toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[0].value)) {
      const [, k, v] = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/.exec(toks[0].value);
      if (isExport) state.env[k] = v; else localEnv[k] = v;
      toks = toks.slice(1);
    }
    if (!toks.length) continue; // a pure assignment/export segment

    // Exported variables live in `state.env` and persist; a bare `VAR=v cmd` prefix applies to this
    // command only. Both are overrides for detection purposes, so the command sees their union.
    analyse(toks, state, { ...state.env, ...localEnv }, out, notes, seg, path, depth);
  }
}

/*
 * ⛔ A SUBSTITUTION IS A PLACE THIS PARSER STOPPED LOOKING, NOT A PLACE WITH NOTHING IN IT — AND THE
 * PARSER WAS REWARDED FOR STOPPING, IN BOTH DIRECTIONS AT ONCE (finding I-8).
 *   X=$(git reset --hard)        the whole mutation sits inside the span, so the outer parse saw no git
 *                                at all — and index-guard's "unmodelled construct PLUS a visible
 *                                mutation" refusal had nothing to refuse, so the main thread got an
 *                                advisory delivered alongside the authorization
 *   echo $(git rev-parse HEAD)   a subagent was refused for the mere PRESENCE of the construct, before
 *                                anything inside it was looked at — a read that touches no index
 * ⭐ ONE RULE ANSWERS BOTH, AND IT IS NOT A SECOND VERB LIST. `eval` and constant `-c` program strings
 * are already re-parsed through `parseInto` when their text is CONSTANT; a substitution span whose inner
 * text is constant is the same case with different punctuation. So it is read the same way, its commands
 * join the outer ones, and the caller classifies the union with the classifier it already uses.
 *
 * ⛔ AND "READ" IS NOT "MODELLED", WHICH IS WHY `unsupported` STILL SAYS SO. Knowing what runs inside
 * `$(cat list.txt)` says nothing about what its OUTPUT becomes in `git add $(cat list.txt)` — those
 * pathspecs remain unknowable, and that command must stay refused for the outer mutation it names.
 * `substitutionsRead` therefore answers a narrower question than `unsupported`: was every unmodelled
 * thing in this program a substitution span, and was every one of those spans read? Only that answer
 * may relax a refusal that rests on "nothing here could be inspected".
 *
 * ⛔ A SPAN IS EXTRACTABLE ONLY IF IT IS CONSTANT AND ITS CONTENTS MODEL CLEANLY. A nested substitution,
 * an expansion in the program position (`$($GIT reset --hard)`) or any other non-constant fragment
 * leaves `isConstant` false; anything the inner parse itself could not model leaves a note. Either way
 * the span is discarded whole — its commands are NOT surfaced — so an opaque substitution keeps exactly
 * the verdict it has today rather than acquiring a new one from a half-read reading.
 */
function extractSubstitutions(spans, startDir, out, path) {
  let allRead = spans.length > 0;
  for (const span of spans) {
    const inner = String(span.inner);
    if (!inner.trim() || !isConstant(inner)) { allRead = false; continue; }
    // A child shell: its `cd` and its exports do not escape back out, exactly as for `eval` and `-c`.
    const innerNotes = { unsupported: null, unsupportedKind: null, redirections: [] };
    const innerCommands = [];
    parseInto(inner, { dir: startDir, env: {}, dirDynamic: false }, innerCommands, innerNotes, path, 1);
    if (innerNotes.unsupported || innerNotes.noted) { allRead = false; continue; }
    /*
     * The inner commands are recorded at the program's STARTING directory, because a substitution is
     * extracted before the outer walk carries any `cd` forward. That is safe for the one decision that
     * consumes it: a span exists only when the scan already reported the construct, so any MUTATION
     * found in here is refused on the strength of the subcommand alone, before any directory is
     * resolved. Inner redirections are deliberately dropped — they were never collected before this
     * change, and adding them would be a new refusal rather than the one this fix is for.
     */
    out.push(...innerCommands);
  }
  return allRead;
}

/**
 * Parse a whole shell program into commands with their EFFECTIVE execution context.
 *
 * Returns {unsupported, commands}. ⛔ `commands` is populated EVEN WHEN `unsupported` is set: an
 * unmodelled construct somewhere in a program is not a reason to lose sight of the git invocation
 * standing next to it. Callers decide what an unmodelled construct means for the commands they can see.
 *
 * `substitutionsRead` is true only when EVERY construct reported here was a substitution span and every
 * one of those spans was read — see `extractSubstitutions`. It never means "modelled".
 */
function parseProgram(cmd, startDir, path) {
  const text = String(cmd || '');
  const notes = { unsupported: null, unsupportedKind: null, redirections: [] };
  const { found, spans } = scanConstructs(text);
  if (found.length) { notes.unsupported = found.join('; '); notes.unsupportedKind = 'construct'; }
  const scanned = notes.unsupported;

  const commands = [];
  parseInto(text, { dir: startDir, env: {}, dirDynamic: false }, commands, notes, path, 0);
  const spansRead = extractSubstitutions(spans, startDir, commands, path);
  const substitutionsRead = spansRead
    && found.every((f) => SUBSTITUTION_CONSTRUCTS.has(f))
    && notes.unsupported === scanned && !notes.noted;
  return { unsupported: notes.unsupported, unsupportedKind: notes.unsupportedKind, substitutionsRead, redirections: notes.redirections, commands };
}

module.exports = {
  lex, tokenize, splitSegments, parseProgram, binName, stripWrapper,
  scanUnsupported, gitEnvKey, wrappedProgram, parseEnv, redefinesExecution,
  GIT_ENV, GIT_CONFIG_OVERRIDE, EXECUTION_CONFIG_KEYS, POSIX_SHELLS, PS_SHELLS, CMD_SHELLS,
  WRAPPER_GRAMMAR, COMMAND_BUILDERS, CONTROL_LEADERS, HIDDEN_PROGRAM,
};
