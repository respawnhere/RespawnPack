/*
 * RespawnPack · kernel/lib/gate.js — the quality gate, as a computation rather than a message.
 *
 * ⛔ THE DEFECT THIS REPLACES. `templates/ci/quality-gate.yml` ran four steps — lint, typecheck, test,
 * build — each guarded by its own skip branch. On a repo with no Node lockfile every one printed
 * "skipping" and the job reported GREEN. A workflow named "quality gate" reported success having run
 * zero checks, on exactly the projects the installer already knew were Python, mixed, or monorepos.
 *
 * ⛔ AND WHY BETTER SKIP MESSAGES WOULD NOT HAVE FIXED IT. The failure was never the wording. It was
 * that nothing computed an OUTCOME: the job's exit status was the shell's, and a skipped step exits 0.
 * Prose in a log has no exit code. So the gate is now a program that returns a verdict, and the YAML
 * is a thin caller of it.
 *
 * FOUR OUTCOMES, and the difference between the last two is the whole point:
 *   PASS            at least one applicable, configured check ran and passed
 *   FAIL            a configured check ran and failed
 *   NOT_CONFIGURED  an applicable stack was detected but no meaningful check could run
 *   NOT_APPLICABLE  the project DECLARED it has no quality gate
 *
 * ⭐ NOT_APPLICABLE is only ever DECLARED, never inferred. "I looked and found nothing" is
 * NOT_CONFIGURED — the honest answer — and it is not green. Inferring not-applicable from an empty
 * search is precisely how a zero-check run becomes a passing gate, which is the bug. A project that
 * genuinely has no gate says so in respawnpack.config.json and takes responsibility for the claim.
 *
 * ⛔ AND WHY THOSE FOUR WORDS ARE NOW LABELS RATHER THAN A SECOND VOCABULARY (K-09). This file used to
 * carry its own `GATE` enum, its own `RANK` and its own `EXIT` table — a fifth place in the pack where
 * "what happened" was spelled and a second place where it was turned into an exit code. Two exit maps
 * for one meaning is how a caller ends up reading "could not run" as "failed": the tables agreed today
 * only because someone kept them agreeing. So the gate now emits kernel/lib/outcome.js `result()` rows
 * in the pack's ONE vocabulary, and the four words above survive as `label` — the richer diagnostic
 * word, which is what made them worth having. Nothing routes an exit code through a label.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { OUTCOME, result } = require('./outcome');

/*
 * THE ONE MAPPING TABLE, replacing `GATE`, `RANK` and `EXIT` together.
 *
 * Left: the gate's own diagnostic word, kept because "an applicable stack was detected but nothing
 * meaningful could run" and "the tool this check names is not installed" are different things to tell
 * an operator. Right: the shared outcome that decides the exit code, via outcome.js `exitCodeFor`.
 *
 * ⛔ BOTH NOT_CONFIGURED AND COULD_NOT_RUN ARE CANNOT_DETERMINE, NEVER FAIL. A gate that could not run
 * has not established that anything is broken — it has established nothing, which is its own answer
 * with its own exit code (2). Collapsing it into FAIL would say the project's checks disagree with the
 * project, which nobody measured; collapsing it into PASS is the defect this whole file exists to end.
 *
 * The severity ordering the old RANK held is now outcome.js's RANK, which ranks CANNOT_DETERMINE above
 * PASS and below FAIL — the same order, in the one place that owns it.
 */
const LABEL_OUTCOME = {
  PASS: OUTCOME.PASS,
  FAIL: OUTCOME.FAIL,
  NOT_APPLICABLE: OUTCOME.NOT_APPLICABLE,
  NOT_CONFIGURED: OUTCOME.CANNOT_DETERMINE,
  COULD_NOT_RUN: OUTCOME.CANNOT_DETERMINE,
};

/**
 * One planned check's verdict, in the shared row shape.
 *
 * `check` is the stable parameterised id (`gate:backend:test`), `subject` is what the row actually
 * looked at — the command line for a check that has one, the root it was planned in when nothing was
 * configured to run there — and `checked` counts the commands this row examined: 1 for a check that
 * ran, 0 for one that was never configured or could not start. The planning facts (`name`, `profile`,
 * `root`, `configured`, `bin`, `args`) ride along beside the contract fields, because they are what a
 * reader needs to fix the row and they are not derivable from it.
 */
function gateRow(label, check, detail, extra = {}) {
  const outcome = LABEL_OUTCOME[label];
  if (!outcome) throw new Error(`unknown gate label: ${label}`);
  return result(outcome, `gate:${check.root}:${check.name}`, detail, {
    checked: outcome === OUTCOME.PASS || outcome === OUTCOME.FAIL ? 1 : 0,
    domain: 'gate',
    subject: check.bin ? [check.bin, ...(check.args || [])].join(' ') : check.root,
    label,
    name: check.name,
    profile: check.profile,
    root: check.root,
    configured: check.configured,
    ...(check.bin ? { bin: check.bin, args: check.args || [] } : {}),
    ...extra,
  });
}

/**
 * The whole run's verdict. `outcome` is the only field an exit code is derived from; `label` is the
 * gate's own word for the same verdict and is what an operator reads.
 *
 * ⛔ COULD_NOT_RUN IS A ROW WORD AND NEVER A VERDICT. One check failing to start is reported on that
 * check's own row; the run it belongs to is NOT_CONFIGURED, because the question the gate was asked —
 * "is this project green?" — went unanswered. Refused here rather than trusted, so the distinction
 * cannot be lost by a later branch reaching for the nearer word.
 */
function verdict(label, why, rest) {
  if (label === 'COULD_NOT_RUN' || !LABEL_OUTCOME[label]) {
    throw new Error(`${label} is not a gate verdict — expected PASS | FAIL | NOT_CONFIGURED | NOT_APPLICABLE`);
  }
  return { outcome: LABEL_OUTCOME[label], label, why, ...rest };
}

const readJSON = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const readText = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
const has = (dir, ...rel) => fs.existsSync(path.join(dir, ...rel));
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
// Files only, never a directory that happens to match a glob-ish name (a directory called `Dockerfile.d`
// is not a Dockerfile) — every caller below is looking for evidence FILES.
const listDir = (dir, ...rel) => {
  try { return fs.readdirSync(path.join(dir, ...rel), { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name); }
  catch { return []; }
};

// --- stack detection ------------------------------------------------------------------------------

// Monorepo roots one level down, matching install.js's own detection so the gate and the installer
// cannot disagree about the shape of the project.
function candidateRoots(dir) {
  const roots = ['.'];
  const listChildren = (parent) => {
    try { return fs.readdirSync(path.join(dir, parent), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => `${parent}/${e.name}`); }
    catch { return []; }
  };
  for (const fixed of ['backend', 'frontend']) if (has(dir, fixed)) roots.push(fixed);
  for (const parent of ['apps', 'services', 'packages']) roots.push(...listChildren(parent));
  return roots;
}

/** Ansible's own evidence: `ansible.cfg`, or a playbook directory beside an inventory directory — the
 * shape `ansible-playbook` itself expects, distinct from ansible-lint's SEPARATE `.ansible-lint` config
 * the planner asks about below. Detection never asks whether ansible-lint exists; that is a configured
 * question, not a stack question. */
function ansibleStackEvidence(dir, root) {
  if (has(dir, root, 'ansible.cfg')) return 'ansible.cfg';
  if (!isDir(path.join(dir, root, 'inventory'))) return null;
  const playbook = listDir(dir, root, 'playbooks').find((n) => /\.ya?ml$/i.test(n));
  return playbook ? `playbooks/${playbook}` : null;
}

/** Every `*.sh` under `root`, however deep, except inside `node_modules` or `.git` — the two directories
 * large enough, and foreign enough to this project's own scripts, that a shell file inside either proves
 * nothing about it. Sorted and POSIX-separated so two runs on the same tree name the same files the same
 * way, and so the planner below can reuse this exact list rather than risk a second scan disagreeing
 * with the first about what was found. */
function findShellScripts(dir, root) {
  const out = [];
  const walk = (abs, rel) => {
    let entries;
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === '.git') continue;
        walk(path.join(abs, e.name), rel ? `${rel}/${e.name}` : e.name);
      } else if (e.isFile() && /\.sh$/i.test(e.name)) {
        out.push(rel ? `${rel}/${e.name}` : e.name);
      }
    }
  };
  walk(path.join(dir, root), '');
  return out.sort();
}

/**
 * Every stack this gate knows how to reason about, with the file that proves it — never inferred from an
 * empty search, only found from evidence already on disk.
 *
 * ⛔ Q-1's SIX ADDITIONS FOLLOW THE SAME RULE THE ORIGINAL FOUR SET. One evidence file (or, for shell, one
 * file PATTERN) proves the stack, checked at every candidate root exactly like `package.json` or
 * `go.mod` always were. Nothing here asks whether a TOOL is installed — that question belongs to
 * `planChecks`, per check, because a stack can be real (there are `*.tf` files) while its formatter is
 * not (`configured: false`), and detection must never be the check that answers that question. A root
 * can carry more than one profile at once (an ops-infra root is Terraform AND Ansible AND shell
 * together), which is the same "found, not asserted" logic applied honestly rather than picking one.
 */
function detectProfiles(dir) {
  const found = [];
  for (const root of candidateRoots(dir)) {
    const at = (f) => path.join(dir, root, f);
    if (fs.existsSync(at('package.json'))) found.push({ id: 'node', root, evidence: 'package.json' });
    for (const f of ['pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt', 'tox.ini']) {
      if (fs.existsSync(at(f))) { found.push({ id: 'python', root, evidence: f }); break; }
    }
    if (fs.existsSync(at('go.mod'))) found.push({ id: 'go', root, evidence: 'go.mod' });
    if (fs.existsSync(at('Cargo.toml'))) found.push({ id: 'rust', root, evidence: 'Cargo.toml' });

    const tf = listDir(dir, root).filter((n) => /\.tf$/i.test(n)).sort();
    if (tf.length) found.push({ id: 'terraform', root, evidence: tf[0] });

    const ansibleEvidence = ansibleStackEvidence(dir, root);
    if (ansibleEvidence) found.push({ id: 'ansible', root, evidence: ansibleEvidence });

    const shFiles = findShellScripts(dir, root);
    if (shFiles.length) found.push({ id: 'shell', root, evidence: shFiles[0], files: shFiles });

    const dockerfiles = listDir(dir, root).filter((n) => /^Dockerfile/i.test(n)).sort();
    if (dockerfiles.length) found.push({ id: 'docker', root, evidence: dockerfiles[0], files: dockerfiles });

    if (fs.existsSync(at('kustomization.yaml'))) found.push({ id: 'kubernetes', root, evidence: 'kustomization.yaml' });

    const mdlint = listDir(dir, root).filter((n) => /^\.markdownlint/i.test(n)).sort();
    if (mdlint.length) found.push({ id: 'docs', root, evidence: mdlint[0] });
  }
  return found;
}

// --- check planning -------------------------------------------------------------------------------

/**
 * Is `bin` resolvable on PATH? A narrower question than `resolveBin` below: this only decides whether a
 * CHECK is `configured`, and it must never spawn anything or trust whatever this machine happens to have
 * installed. `env` is threaded in from `planChecks`/`runGate` — defaulting to the real process
 * environment for production use — so a test can hand it a fully synthetic `{ PATH: <tmp dir> }` and get
 * a deterministic answer regardless of what is actually on the developer's or the CI runner's own PATH.
 */
function binOnPath(bin, env = process.env) {
  const PATH = env.PATH ?? env.Path ?? env.path ?? '';
  if (!PATH) return false;
  const exts = process.platform === 'win32'
    ? ['', ...(env.PATHEXT || process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)]
    : [''];
  for (const entry of PATH.split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      try { if (fs.statSync(path.join(entry, bin + ext)).isFile()) return true; } catch { /* keep looking */ }
    }
  }
  return false;
}

/** `node_modules/.bin/<name>`, resolved under `root` — never PATH, because an npm-ecosystem tool
 * (ESLint, Prettier, markdownlint-cli) is a per-project devDependency, not a system package, so a config
 * file for one proves intent but never proves it is installed. Returns the resolved path or null. */
function resolveLocalBin(dir, root, name) {
  const binDir = path.join(dir, root, 'node_modules', '.bin');
  const candidates = process.platform === 'win32' ? [name, `${name}.cmd`, `${name}.CMD`, `${name}.ps1`] : [name];
  for (const c of candidates) {
    const p = path.join(binDir, c);
    try { if (fs.statSync(p).isFile()) return p; } catch { /* keep looking */ }
  }
  return null;
}

function nodePackageManager(dir, root) {
  const at = (f) => path.join(dir, root, f);
  if (fs.existsSync(at('pnpm-lock.yaml'))) return { bin: 'pnpm', run: ['run'] };
  if (fs.existsSync(at('yarn.lock'))) return { bin: 'yarn', run: [] };
  return { bin: 'npm', run: ['run'] };
}

const ESLINT_CONFIGS = ['.eslintrc', '.eslintrc.json', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.yml', '.eslintrc.yaml', 'eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs'];
const PRETTIER_CONFIGS = ['.prettierrc', '.prettierrc.json', '.prettierrc.js', '.prettierrc.cjs', '.prettierrc.yml', '.prettierrc.yaml', '.prettierrc.toml', 'prettier.config.js', 'prettier.config.cjs'];

/**
 * The `lint` row for a Node project with NO `lint` script — Q-1's one Node-side addition. An ESLint or
 * Prettier config is common evidence the project lints, but it is never enough alone: a config file with
 * no locally installed tool is not a check anyone can run. So this needs BOTH, unlike the OR rule the new
 * infrastructure/shell/container checks use below — see `resolveLocalBin`'s comment for why an
 * npm-ecosystem tool earns a stricter answer than a system package does. Returns a configured row when
 * the config AND the local binary agree, a `configured: false` row naming the config found and the
 * binary missing when only the config is there, or `null` when there is no lint tooling evidence at all
 * — the caller's existing "no lint script" reason still applies to that case.
 */
function lintFromLocalTooling(dir, p) {
  const at = (f) => path.join(dir, p.root, f);
  const eslintConfig = ESLINT_CONFIGS.find((f) => fs.existsSync(at(f)));
  if (eslintConfig) {
    const bin = resolveLocalBin(dir, p.root, 'eslint');
    return bin
      ? { name: 'lint', profile: 'node', root: p.root, configured: true, bin, args: ['.'] }
      : { name: 'lint', profile: 'node', root: p.root, configured: false,
          why: `${eslintConfig} exists in ${p.root} but no local eslint binary at ${p.root}/node_modules/.bin/eslint` };
  }
  const pkg = readJSON(at('package.json')) || {};
  const prettierConfig = PRETTIER_CONFIGS.find((f) => fs.existsSync(at(f))) || (pkg.prettier ? 'package.json "prettier" key' : null);
  if (prettierConfig) {
    const bin = resolveLocalBin(dir, p.root, 'prettier');
    return bin
      ? { name: 'lint', profile: 'node', root: p.root, configured: true, bin, args: ['--check', '.'] }
      : { name: 'lint', profile: 'node', root: p.root, configured: false,
          why: `${prettierConfig} exists in ${p.root} but no local prettier binary at ${p.root}/node_modules/.bin/prettier` };
  }
  return null;
}

function planNode(dir, p) {
  const pkg = readJSON(path.join(dir, p.root, 'package.json')) || {};
  const scripts = pkg.scripts || {};
  const pm = nodePackageManager(dir, p.root);
  return ['lint', 'typecheck', 'test', 'build'].map((name) => {
    if (scripts[name]) {
      return { name, profile: 'node', root: p.root, configured: true, bin: pm.bin, args: [...pm.run, name] };
    }
    const fromTooling = name === 'lint' ? lintFromLocalTooling(dir, p) : null;
    return fromTooling || { name, profile: 'node', root: p.root, configured: false, why: `no "${name}" script in ${p.root}/package.json` };
  });
}

function planPython(dir, p) {
  const at = (f) => path.join(dir, p.root, f);
  const pyproject = readText(at('pyproject.toml')) || '';
  const setupCfg = readText(at('setup.cfg')) || '';
  const toxIni = readText(at('tox.ini')) || '';
  const declares = (re) => re.test(pyproject) || re.test(setupCfg) || re.test(toxIni);
  const checks = [];

  // Lint: whichever linter the project actually declares. A linter nobody configured is not a gate.
  if (declares(/\[tool\.ruff/) || fs.existsSync(at('ruff.toml')) || fs.existsSync(at('.ruff.toml'))) {
    checks.push({ name: 'lint', profile: 'python', root: p.root, configured: true, bin: 'ruff', args: ['check', '.'] });
  } else if (declares(/\[flake8\]/) || fs.existsSync(at('.flake8'))) {
    checks.push({ name: 'lint', profile: 'python', root: p.root, configured: true, bin: 'flake8', args: ['.'] });
  } else if (fs.existsSync(at('.pylintrc')) || declares(/\[tool\.pylint/)) {
    checks.push({ name: 'lint', profile: 'python', root: p.root, configured: true, bin: 'pylint', args: ['.'] });
  } else {
    checks.push({ name: 'lint', profile: 'python', root: p.root, configured: false, why: 'no ruff/flake8/pylint configuration found' });
  }

  const mypy = declares(/\[tool\.mypy/) || declares(/\[mypy\]/) || fs.existsSync(at('mypy.ini'));
  checks.push(mypy
    ? { name: 'typecheck', profile: 'python', root: p.root, configured: true, bin: 'mypy', args: ['.'] }
    : { name: 'typecheck', profile: 'python', root: p.root, configured: false, why: 'no mypy configuration found' });

  const pytest = declares(/\[tool\.pytest/) || declares(/\[pytest\]/) || fs.existsSync(at('pytest.ini')) || fs.existsSync(at('tests')) || fs.existsSync(at('test'));
  checks.push(pytest
    ? { name: 'test', profile: 'python', root: p.root, configured: true, bin: 'pytest', args: ['-q'] }
    : { name: 'test', profile: 'python', root: p.root, configured: false, why: 'no pytest configuration and no tests/ directory' });

  return checks;
}

// Go and Rust ship their gates in the toolchain: if the manifest is there, the checks exist. There is
// no "configured?" question to ask, which is why these are the easy cases and Node/Python are not.
const planGo = (dir, p) => [
  { name: 'lint', profile: 'go', root: p.root, configured: true, bin: 'go', args: ['vet', './...'] },
  { name: 'build', profile: 'go', root: p.root, configured: true, bin: 'go', args: ['build', './...'] },
  { name: 'test', profile: 'go', root: p.root, configured: true, bin: 'go', args: ['test', './...'] },
];
const planRust = (dir, p) => [
  { name: 'lint', profile: 'rust', root: p.root, configured: true, bin: 'cargo', args: ['clippy', '--all-targets'] },
  { name: 'build', profile: 'rust', root: p.root, configured: true, bin: 'cargo', args: ['build', '--all-targets'] },
  { name: 'test', profile: 'rust', root: p.root, configured: true, bin: 'cargo', args: ['test'] },
];

// Terraform ships fmt/validate in the toolchain, the way Go and Rust do: `*.tf` existing (the detection
// evidence itself) is the only "configured?" question that means anything, so both rows are always
// configured. tflint is a genuinely OPTIONAL extra linter, not a mandatory step every Terraform project
// is assumed to want — so unlike ansible-lint/shellcheck/hadolint below, it is not merely marked
// unconfigured when unused, it is not planned at all unless its own `.tflint.hcl` says the project has
// adopted it. Nothing prompts a project that never adopted tflint to install it.
function planTerraform(dir, p) {
  const checks = [
    { name: 'fmt', profile: 'terraform', root: p.root, configured: true, bin: 'terraform', args: ['fmt', '-check', '-recursive'] },
    { name: 'validate', profile: 'terraform', root: p.root, configured: true, bin: 'terraform', args: ['validate'] },
  ];
  if (has(dir, p.root, '.tflint.hcl')) {
    checks.push({ name: 'tflint', profile: 'terraform', root: p.root, configured: true, bin: 'tflint', args: [] });
  }
  return checks;
}

// ansible-lint's OWN config (`.ansible-lint`) is distinct from ansible.cfg, which only proves the Ansible
// stack itself (see ansibleStackEvidence above). Configured when that config exists OR the binary
// resolves on PATH — the general Q-1 rule for a system package, never trusting an empty search.
function planAnsible(dir, p, env) {
  const configured = has(dir, p.root, '.ansible-lint') || binOnPath('ansible-lint', env);
  return [configured
    ? { name: 'ansible-lint', profile: 'ansible', root: p.root, configured: true, bin: 'ansible-lint', args: ['.'] }
    : { name: 'ansible-lint', profile: 'ansible', root: p.root, configured: false,
        why: `no .ansible-lint in ${p.root} and no ansible-lint binary on PATH` }];
}

function planShell(dir, p, env) {
  const files = p.files || findShellScripts(dir, p.root);
  const configured = has(dir, p.root, '.shellcheckrc') || binOnPath('shellcheck', env);
  return [configured
    ? { name: 'shellcheck', profile: 'shell', root: p.root, configured: true, bin: 'shellcheck', args: files }
    : { name: 'shellcheck', profile: 'shell', root: p.root, configured: false,
        why: `no .shellcheckrc in ${p.root} and no shellcheck binary on PATH` }];
}

function planDocker(dir, p, env) {
  const files = p.files || listDir(dir, p.root).filter((n) => /^Dockerfile/i.test(n)).sort();
  const configured = has(dir, p.root, '.hadolint.yaml') || has(dir, p.root, '.hadolint.yml') || binOnPath('hadolint', env);
  return [configured
    ? { name: 'hadolint', profile: 'docker', root: p.root, configured: true, bin: 'hadolint', args: files }
    : { name: 'hadolint', profile: 'docker', root: p.root, configured: false,
        why: `no .hadolint.yaml in ${p.root} and no hadolint binary on PATH` }];
}

// kustomization.yaml is Kubernetes' own evidence AND its config in one file, the way go.mod is for Go —
// so this is always configured, and the only open question is which validator to run: kubeconform if it
// is on PATH, else kubectl's own built-in kustomize, which almost every Kubernetes toolchain already has.
function planKubernetes(dir, p, env) {
  return [binOnPath('kubeconform', env)
    ? { name: 'kubeconform', profile: 'kubernetes', root: p.root, configured: true, bin: 'kubeconform', args: ['-summary', 'kustomization.yaml'] }
    : { name: 'kustomize', profile: 'kubernetes', root: p.root, configured: true, bin: 'kubectl', args: ['kustomize', '.'] }];
}

// docs is markdownlint's OWN config file (see detectProfiles), so unlike ansible/shell/docker the config
// half of "configured" is a given the moment this planner even runs. It is markdownlint-cli's npm
// heritage that decides the rest: a per-project devDependency, resolved under node_modules like ESLint
// and Prettier above, never trusted from PATH alone.
function planDocs(dir, p) {
  const bin = resolveLocalBin(dir, p.root, 'markdownlint');
  return [bin
    ? { name: 'markdownlint', profile: 'docs', root: p.root, configured: true, bin, args: ['**/*.md'] }
    : { name: 'markdownlint', profile: 'docs', root: p.root, configured: false,
        why: `no local markdownlint binary at ${p.root}/node_modules/.bin/markdownlint` }];
}

const PLANNERS = {
  node: planNode, python: planPython, go: planGo, rust: planRust,
  terraform: planTerraform, ansible: planAnsible, shell: planShell,
  docker: planDocker, kubernetes: planKubernetes, docs: planDocs,
};

/**
 * Plan the checks for a project. Pure — no execution — so the planning half is testable without a
 * toolchain installed, and so a fixture can assert on WHY a check was considered unconfigured.
 *
 * `env` is the environment `binOnPath` reads to answer "is this tool on PATH" — see its comment. It
 * defaults to the real process environment so a real invocation behaves exactly as before Q-1; a test
 * hands it a synthetic PATH instead.
 */
function planChecks(dir, config = {}, env = process.env) {
  // An explicit check list overrides detection entirely: a project that knows its own build (a
  // Makefile, bazel, a shell script) should not have to look like npm to be taken seriously.
  if (Array.isArray(config.checks) && config.checks.length) {
    return config.checks.map((c) => ({
      name: c.name || 'custom', profile: 'declared', root: c.root || '.', configured: true,
      bin: c.command, args: c.args || [],
    }));
  }
  const profiles = detectProfiles(dir);
  return profiles.flatMap((p) => (PLANNERS[p.id] ? PLANNERS[p.id](dir, p, env) : []));
}

// --- execution ------------------------------------------------------------------------------------

/*
 * ⛔ WINDOWS: npm, pnpm, yarn, ruff, pytest and friends are `.cmd`/`.bat` shims, and Node cannot spawn
 * those directly (it raises EINVAL since the 2024 command-injection hardening). Spawning with
 * `shell: true` would fix it and reopen exactly that hole, because Node does not escape arguments in
 * shell mode. So the binary is resolved through PATH/PATHEXT ourselves, and a batch shim is invoked via
 * cmd.exe with arguments we quote — the approach cross-spawn takes, minus the dependency.
 *
 * This was caught by the one gate test that does NOT inject `exec`. The mocked tests all passed on
 * Windows while every real invocation would have reported "command not found" — which the gate would
 * have honestly called NOT_CONFIGURED, so the bug would have surfaced as a permanently un-passable gate
 * rather than a false green. Right failure direction, still a bug.
 */
function resolveBin(bin) {
  if (process.platform !== 'win32') return bin;
  if (path.isAbsolute(bin) || bin.includes('/') || bin.includes('\\')) return bin;
  const exts = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  // PATHEXT extensions FIRST, bare name last. Node ships an extensionless `npm` next to `npm.cmd` — a
  // bash script for Git Bash/WSL that Windows cannot execute. Preferring the bare name found that one
  // and reported "command not found", which the gate honestly turned into a permanently un-passable
  // NOT_CONFIGURED. Right failure direction, wrong answer.
  for (const entry of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const ext of [...exts, '']) {
      const candidate = path.join(entry, bin + ext);
      try { if (fs.statSync(candidate).isFile()) return candidate; } catch { /* keep looking */ }
    }
  }
  return bin; // unresolved — let spawn report ENOENT so the caller reports "command not found"
}

const winQuote = (a) => (/[\s"^&|<>()]/.test(a) ? `"${String(a).replace(/"/g, '\\"')}"` : a);

function defaultExec(dir, check) {
  const cwd = path.join(dir, check.root || '.');
  const common = { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: check.timeoutMs || 900000 };
  const resolved = resolveBin(check.bin);
  const isBatch = process.platform === 'win32' && /\.(cmd|bat)$/i.test(resolved);

  // The ENTIRE command is wrapped in one more pair of quotes. That is what `/s` means: cmd.exe takes
  // everything between the first and last quote verbatim. Without it, a resolved path like
  // `C:\Program Files\nodejs\npm.CMD` is split at the space and cmd reports that 'C:\Program' is not a
  // command — which the gate would then read as a genuine check failure rather than a spawn bug.
  const r = isBatch
    ? spawnSync(process.env.ComSpec || 'cmd.exe',
      ['/d', '/s', '/c', `"${winQuote(resolved)} ${check.args.map(winQuote).join(' ')}"`],
      { ...common, windowsVerbatimArguments: true })
    : spawnSync(resolved, check.args, { ...common, shell: false });

  if (r.error && r.error.code === 'ENOENT') return { ran: false, why: `command not found: ${check.bin}` };
  if (r.error) return { ran: false, why: `could not run ${check.bin}: ${r.error.message}` };
  return { ran: true, code: r.status, output: `${r.stdout || ''}${r.stderr || ''}`.trim().split(/\r?\n/).slice(-4).join(' | ').slice(0, 600) };
}

/*
 * ⛔ THE ONE ADR-003 ROW THIS FILE CARRIES, AND WHY IT ARRIVES ALREADY DECIDED.
 *
 * `kernel:R9` is "the gate looked for a build system and found none". ADR-003 reads `advise` under
 * `light` and `deny` under `standard` and `strict`, and the kernel audit's own R9 row names the relaxed target
 * exactly: NOT_APPLICABLE, exit 0, with a row saying so.
 *
 * The DECISION is not taken here. `kernel/respawnpack.js` resolves the project's posture once per verb
 * and asks `applicability.relaxes()` — the one predicate that knows which resolutions and which
 * verdicts relax — so what reaches this file is an answer, not a policy: `{profile, rule}` when the
 * declared posture answers the no-build-system branch, and `null` otherwise. A second reader of the
 * posture is the failure ADR-003 settled with a single reader in `hooks/_posture.js`, and a gate that
 * read the config for itself would be that failure with a different filename.
 *
 * ⛔ AND IT RELAXES TO NOT_APPLICABLE, NEVER TO PASS. The coverage rows relax to PASS with `checked: 1`
 * because the declaration they inspected is a real subject. This branch inspected ZERO commands
 * (`ran: 0`): a PASS here would be a gate reporting green having run nothing, which is the single
 * defect this whole file exists to end, and `outcome.js` `result()` refuses it outright anyway
 * (anti-drift item 1, `checked <= 0`). NOT_APPLICABLE is the honest word and it is exit 0.
 *
 * ⛔ AND IT IS STILL "ONLY EVER DECLARED, NEVER INFERRED" — this file's loudest rule, intact. What is
 * declared is the posture: a value in `respawnpack.config.json`, tracked, reviewable, carried by a
 * diff. Nothing is inferred from an empty search; the empty search is reported, in `why`, ahead of the
 * posture that answered it. This is the same argument P3-K-10 accepted for `kernel:R3`/`R4`, and it is
 * narrowed the same way: only where the absence needs no inference at all, i.e. zero detected build
 * profiles. A project whose stack WAS detected but configured nothing keeps NOT_CONFIGURED in every
 * posture, and so does every other branch of the ladder.
 */
const POSTURE_ROW = 'kernel:R9';

/**
 * Run the gate and return a verdict.
 *
 * `exec` is injectable so fixtures can prove the OUTCOME LOGIC without needing pytest, cargo and go
 * installed on the runner — the alternative is a gate whose own tests skip, which would be the defect
 * reproducing itself one level up. `env` is the same idea one step earlier: Q-1's infrastructure, shell,
 * container and Kubernetes checks ask "is this tool on PATH" while PLANNING, and a fixture must be able
 * to answer that without depending on what this machine happens to have installed — see `binOnPath`.
 *
 * @param {{config?:Object, exec?:Function, posture?:{profile:string, rule:string}|null, env?:Object}} [opts]
 *   `posture` is the caller's already-taken ADR-003 `kernel:R9` decision — see POSTURE_ROW above.
 */
function runGate(dir, { config = null, exec = defaultExec, posture = null, env = process.env } = {}) {
  const cfg = config || (readJSON(path.join(dir, 'respawnpack.config.json')) || {}).qualityGate || {};

  /*
   * ⛔ THE RULE THIS FILE STATES MOST LOUDLY WAS THE ONE IT ENFORCED LEAST.
   *
   * The header above says NOT_APPLICABLE "is only ever DECLARED" and that a project taking the opt-out
   * "takes responsibility for the claim." `state.removals` and `state.reconcile` hold their founders to
   * that: an opt-out with no reason is refused outright (removals.js readConfig, reconcile.js
   * runReconciliation), because an opt-out nobody has to justify is an opt-out nobody reviews. This one
   * accepted a bare `notApplicable: true`, returned NOT_APPLICABLE at exit 0, and left a parenthetical
   * scold in a field nothing reads. Three implementations of one contract, and the weakest was the one
   * whose own comment argued hardest for it.
   *
   * NOT_CONFIGURED, not FAIL: an unjustified opt-out is an incomplete declaration, not a broken gate —
   * the same verdict an applicable stack with no runnable check gets, and the same exit code (2).
   * kernel/kernel.test.mjs drives this shape through all three loaders and asserts they agree.
   */
  if (cfg.notApplicable === true) {
    if (!cfg.reason || !String(cfg.reason).trim()) {
      return verdict('NOT_CONFIGURED',
        'qualityGate.notApplicable is true with no reason — an opt-out nobody has to justify is an opt-out nobody reviews. '
          + 'Record why this project has no quality gate, or configure one.',
        { declared: true, profiles: [], checks: [], ran: 0 });
    }
    return verdict('NOT_APPLICABLE', `declared not applicable: ${cfg.reason}`,
      { declared: true, profiles: [], checks: [], ran: 0 });
  }

  const profiles = detectProfiles(dir);
  const planned = planChecks(dir, cfg, env);
  const results = [];

  for (const c of planned) {
    if (!c.configured) { results.push(gateRow('NOT_CONFIGURED', c, c.why)); continue; }
    const r = exec(dir, c);
    if (!r.ran) { results.push(gateRow('COULD_NOT_RUN', c, r.why)); continue; }
    results.push(gateRow(r.code === 0 ? 'PASS' : 'FAIL', c, r.output || `exit ${r.code}`, { exitCode: r.code, output: r.output }));
  }

  const passed = results.filter((r) => r.label === 'PASS');
  const failed = results.filter((r) => r.label === 'FAIL');
  const unrunnable = results.filter((r) => r.label === 'COULD_NOT_RUN');

  /*
   * ⛔ THE LADDER, AND WHY IT IS NOT A ROLLUP. outcome.js's `rollup` would give the same answer for
   * every branch that HAS rows, but the two branches below it — no build system found, and a stack
   * detected with nothing configured — have zero rows, and `rollup([])` is CANNOT_DETERMINE with no
   * word for WHY. The order is the mechanism: a real failure outranks an unanswered question, which
   * outranks a pass, and a declared opt-out never reaches here at all.
   */
  let label, why;
  let relaxation = null;
  if (failed.length) {
    label = 'FAIL';
    why = `${failed.length} configured check(s) failed: ${failed.map((f) => `${f.root}:${f.name}`).join(', ')}`;
  } else if (unrunnable.length) {
    // ⛔ Deliberately NOT a pass, even if other checks went green. A declared gate that could not
    // execute is an unanswered question, and answering it "fine" is the whole defect. This is ADR-003's
    // `kernel:R10`, which is FIXED in every posture — `hooks/_posture.js` has no key for it, so there is
    // nothing to consult here and no branch that could reach one.
    label = 'NOT_CONFIGURED';
    why = `${unrunnable.length} configured check(s) could not run: ${unrunnable.map((u) => `${u.root}:${u.name} (${u.detail})`).join('; ')}`;
  } else if (passed.length) {
    label = 'PASS';
    why = `${passed.length} check(s) ran and passed: ${passed.map((p) => `${p.root}:${p.name}`).join(', ')}`;
  } else if (!profiles.length) {
    const found = 'no recognized build system found. This is NOT_CONFIGURED, not NOT_APPLICABLE: finding nothing is not the same as a project declaring it needs no gate. ' +
      'Add checks, or declare {"qualityGate":{"notApplicable":true,"reason":"…"}} in respawnpack.config.json.';
    /*
     * The rule id is compared, not assumed. The caller takes the decision, but this branch is the only
     * thing `kernel:R9` means, and an option that silently accepted a decision taken about some other
     * row would be a relaxation aimed at one rule landing on another.
     */
    if (posture && posture.rule === POSTURE_ROW) {
      // ADR-003 kernel:R9 — see POSTURE_ROW above. The empty search is still reported, first.
      label = 'NOT_APPLICABLE';
      why = `${found} The declared \`${posture.profile}\` posture answers the quality gate for a project with no build system at all `
        + `(ADR-003 ${posture.rule}) — a declared decision in a tracked file, not an absence this gate inferred. `
        + 'Configure a check, or declare qualityGate.notApplicable with a reason, and this row answers for itself again.';
      relaxation = { postureRelaxed: posture.profile, postureRule: posture.rule };
    } else {
      label = 'NOT_CONFIGURED';
      why = found;
    }
  } else {
    label = 'NOT_CONFIGURED';
    why = `detected ${[...new Set(profiles.map((p) => p.id))].join(', ')} but no meaningful check is configured: ` +
      results.filter((r) => r.label === 'NOT_CONFIGURED').map((r) => `${r.root}:${r.name} (${r.detail})`).join('; ');
  }

  return verdict(label, why, { declared: false, profiles, checks: results, ran: passed.length + failed.length, ...(relaxation || {}) });
}

module.exports = { LABEL_OUTCOME, POSTURE_ROW, runGate, planChecks, detectProfiles, candidateRoots, defaultExec, resolveBin };
