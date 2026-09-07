/*
 * RespawnPack · kernel/lib/readiness.js — the production-readiness checklist, FOUND rather than asserted.
 *
 * ⛔ THE DEFECT THIS REPLACES. `/ship` Step 1 is prose: "confirm the change is releasable ... the
 * project gates green". Prose in a skill has no exit code and no inventory, so the questions a release
 * actually turns on — is there a CI workflow at all, is there a test command, does CI scan for secrets,
 * is CODEOWNERS filled in or still the installer's placeholder, does the Terraform state live off the
 * machine that applies it, are there plaintext credentials in a variable file — were asked by whoever
 * happened to remember them. A checklist nobody can run is a checklist that is green by default, which
 * is the same shape `kernel/lib/gate.js` exists to end one layer down.
 *
 * ⛔ AND WHY IT IS DETECTION RATHER THAN A DECLARATION THE FOUNDER FILLS IN. Four archetypes install
 * this pack — a documentation repository, an ops-infrastructure repository, a greenfield application
 * and a mature product — and the readiness question is a different question in each: a remote state
 * backend is meaningless in a docs tree, a link check is meaningless in a Terraform tree, and a
 * checklist that asked every question everywhere would train its reader to skip it. So each item
 * carries `applies(ctx)`, decided from the evidence actually in the tree, and AN ITEM THAT DOES NOT
 * APPLY IS NOT A ROW. The rows that remain are the ones this project could act on.
 *
 * FOUR OUTCOMES, in the pack's ONE vocabulary (kernel/lib/outcome.js), never a fifth:
 *   PASS              the item found its evidence, and `detail` names the evidence
 *   FAIL              the item looked and the evidence is not there; `remedy` says what to do
 *   CANNOT_DETERMINE  a file the item needed could not be read. NOT a pass (anti-drift item 13)
 *   NOT_APPLICABLE    the founder excepted this item by name, or the declared posture's tier does not
 *                     ask it here — both DECLARED in a tracked file, never inferred
 *
 * ⭐ ZERO APPLICABLE ITEMS IS CANNOT_DETERMINE, NEVER PASS (anti-drift item 1). A directory this module
 * recognises nothing in has not been found ready; it has been found unrecognisable, and those are
 * different facts with different exit codes. `readiness:applicable` is the row that says so.
 *
 * ⭐ THE POSTURE SCALES THE LIST; IT NEVER CHANGES WHAT A WORD MEANS (anti-drift item 3). ADR-003's
 * `kernel:readiness` row reads `{light: advise, standard: advise, strict: deny}`. Under `deny` the full
 * list runs and a FAIL fails the verb. Under `advise` the same rows are built, printed and kept — a
 * FAIL is reported with `postureRelaxed` and the run rolls up to PASS, exactly the way
 * `kernel/lib/applicability.js`'s mechanism (a) relaxes a coverage row, with the reason it would have
 * failed still FIRST in `detail`. Nothing is hidden by a relaxation; only the rollup moves.
 *
 * ⛔ AND THE TIER IS NOT A SILENT SKIP EITHER (anti-drift item 12). `light` asks the essential tier;
 * `standard` and `strict` ask the full list. A full-tier item under `light` still gets a ROW — a
 * NOT_APPLICABLE one naming the profile and the ADR row that scoped it out, built by
 * `applicability.js`'s mechanism (b) shape: an AUTHORED reason, and an absence that needs no inference
 * at all because the tier is a property of the table below rather than of an empty search. A reader of
 * a `light` report sees every item the strict report would have shown, and is told which ones this
 * project's own declaration is not asking for. Deleting the row instead would have been the silent
 * skip this pack refuses everywhere else.
 *
 * ⛔ AN EXCEPTION IS THE ONE WAY PAST AN ITEM, AND IT IS CLASS A'S GRAMMAR, NOT A SECOND OPT-OUT.
 * `{rule: "readiness", match: {item: "<id>"}, reason: "..."}` in `respawnpack.config.json`, read by
 * `hooks/_exceptions.js` — the founder-owned tracked file `index-guard`'s CONTROL_PLANE already keeps a
 * subagent out of. The lift is REPORTED, under the entry's own id and reason, in every posture
 * including `strict`. There is deliberately no `readiness.skip` key, no marker file and no `--skip`
 * flag: a second opt-out grammar is a second thing to review, and the one that gets reviewed is the one
 * the diff carries.
 *
 * ⛔ THE POSTURE ARRIVES ALREADY DECIDED, exactly as `gate.js`'s `kernel:R9` does. `kernel/respawnpack.js`
 * resolves the project's posture ONCE per verb and asks `applicability.relaxes()` — the one predicate
 * that knows which resolutions (DECLARED only) and which verdicts relax — so what reaches this file is
 * an answer and not a policy. A second reader of the posture is the failure ADR-003 settled with a
 * single reader in `hooks/_posture.js`, and a checklist that read the config for itself would be that
 * failure with a different filename.
 */
const fs = require('fs');
const path = require('path');
const { OUTCOME, result, rollup } = require('./outcome');

/*
 * ⛔ THE ONE ADR-003 ROW THIS FILE CARRIES. Named here and asked for by `kernel/respawnpack.js`, so the
 * id is spelled once rather than beside every call. It is NOT a `kernel:R<n>` row: the numbered rows are
 * the reconciled specification's own, and inventing an `R29` would put a row in ADR-003's accepted table
 * that the table does not carry. The amendment under "The rule table" names this id instead.
 */
const POSTURE_ROW = 'kernel:readiness';

/**
 * Which tier each profile asks for. `light` asks the essentials; everything else asks the full list,
 * which is also what an undeclared, unreadable or invalid posture gets — the migration guarantee every
 * other posture consumer applies (`hooks/_posture.js`: absent means strict).
 */
const TIER_BY_PROFILE = { light: 'essential', standard: 'full', strict: 'full' };

/** The two tiers, in order of increasing demand. */
const TIERS = ['essential', 'full'];

/*
 * ⛔ RESTATED FROM hooks/secret-scan.js's HIGH-SEVERITY SET, AND FENCED AGAINST IT FROM SOURCE.
 *
 * `no-plaintext-creds` asks the same question the push-time guard asks, of files the guard never sees:
 * a `*.tfvars` or an Ansible inventory that is committed but never appears in an added diff line after
 * the day it landed. Two answers to "what is a credential" is the two-lists failure this pack keeps
 * finding, so this is not a second opinion — `hooks/secret-scan.js` exports `check` and `context` and
 * NOT its pattern table, so there is nothing to require, and `kernel/kernel.test.mjs` therefore reads
 * the hook's source and asserts these are exactly its HIGH rows. A hook-side pattern added without one
 * here fails that fence rather than leaving this checklist quietly narrower than the guard.
 *
 * MEDIUM rows are deliberately not carried: they are advisory in the guard, and an advisory pattern
 * failing a strict verb would make the checklist noisier than the thing it is modelled on.
 */
const CREDENTIAL_PATTERNS = [
  { re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----/, name: 'private key' },
  { re: /\bsk_live_[0-9a-zA-Z]{16,}/, name: 'Stripe live secret key' },
  { re: /\bAKIA[0-9A-Z]{16}\b/, name: 'AWS access key id' },
  { re: /\baws_secret_access_key\b\s*[:=]/i, name: 'AWS secret access key' },
  { re: /\bgh[pousr]_[0-9A-Za-z]{30,}\b/, name: 'GitHub token' },
  { re: /\bxox[baprs]-[0-9A-Za-z-]{10,}/, name: 'Slack token' },
  { re: /\bAIza[0-9A-Za-z_\-]{30,}\b/, name: 'Google API key' },
];

// --- the tree, read once ---------------------------------------------------------------------------

/*
 * Directories that are never a project's own content. Walking `node_modules` would find a lockfile, a
 * README and a LICENSE belonging to somebody else's package and report this project ready on the
 * strength of a dependency's paperwork.
 */
const SKIP_DIRS = new Set([
  '.git', 'node_modules', '.claude', '.terraform', '.venv', 'venv', '__pycache__',
  'dist', 'build', 'out', 'target', 'coverage', 'vendor', '.next', '.nuxt', '.svelte-kit',
]);
const MAX_DEPTH = 4;
const MAX_FILES = 8000;

/** Every file under `dir`, POSIX-relative and sorted, bounded in depth and count. */
function listFiles(dir) {
  const files = [];
  const walk = (rel, depth) => {
    if (files.length >= MAX_FILES) return;
    let entries;
    try { entries = fs.readdirSync(rel ? path.join(dir, rel) : dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || depth + 1 > MAX_DEPTH) continue;
        walk(child, depth + 1);
      } else if (e.isFile()) {
        if (files.length >= MAX_FILES) return;
        files.push(child);
      }
    }
  };
  walk('', 0);
  return files.sort();
}

/*
 * ⛔ TWO HELPERS, AND THE SPLIT IS THE POINT RATHER THAN A STYLE CHOICE. `readText` answers "could this
 * file be read at all", which is what separates a CANNOT_DETERMINE row from a FAIL one; `readJSON`
 * answers "and does it parse". A single combined one-liner returns null for absent, unreadable and
 * malformed alike, and a checklist that cannot tell those apart reports "no test command" for a
 * package.json nobody could open. The raw JSON read is classified in kernel/schema.test.mjs's
 * RAW_READS beside gate.js's, on the same ground: package.json and respawnpack.config.json are
 * founder-authored configuration, never pack-published and never replaced by rename.
 */
const readText = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
const readJSON = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };

const baseOf = (rel) => rel.slice(rel.lastIndexOf('/') + 1);
const extOf = (rel) => { const b = baseOf(rel); const i = b.lastIndexOf('.'); return i > 0 ? b.slice(i).toLowerCase() : ''; };

const WORKFLOW_DIR = '.github/workflows/';
const isWorkflow = (rel) => rel.startsWith(WORKFLOW_DIR) && (extOf(rel) === '.yml' || extOf(rel) === '.yaml');
const isInventory = (rel) => /^(?:inventory|inventories|inventory\/[^/]+|group_vars|host_vars)\//.test(rel)
  && ['.yml', '.yaml', '.ini'].includes(extOf(rel));
const isTfvars = (rel) => /\.tfvars(?:\.json)?$/.test(rel);

/**
 * Everything the items reason about, computed once.
 *
 * ⛔ THE SHAPES ARE DETECTED FROM EVIDENCE FILES THIS MODULE NAMES ITSELF, NOT IMPORTED FROM
 * `gate.js`'s planners. The two answer different questions — the gate asks "what can I RUN here", this
 * asks "what KIND of repository is this" — and a docs tree has no runnable gate while still having a
 * readiness answer. Sharing one table would have made every future stack the gate learns silently
 * change which readiness items a project is asked, which is a behaviour change nobody declared.
 */
function detect(dir) {
  const files = listFiles(dir);
  const set = new Set(files);
  const at = (rel) => path.join(dir, rel.split('/').join(path.sep));
  const any = (pred) => files.filter(pred);

  const tf = any((f) => extOf(f) === '.tf');
  const shells = any((f) => extOf(f) === '.sh' || extOf(f) === '.bash');
  const inventories = any(isInventory);
  const playbooks = any((f) => /^playbooks\//.test(f) && ['.yml', '.yaml'].includes(extOf(f)));
  const dockerfiles = any((f) => /^Dockerfile/i.test(baseOf(f)) || /^(?:docker-)?compose\.ya?ml$/i.test(baseOf(f)));
  const workflows = any(isWorkflow);
  const markdown = any((f) => extOf(f) === '.md');
  const nodeManifests = files.filter((f) => f === 'package.json' || /^[^/]+\/package\.json$/.test(f));

  const shapes = {};
  if (nodeManifests.length) shapes.node = nodeManifests[0];
  if (tf.length) shapes.terraform = tf[0];
  if (set.has('ansible.cfg') || inventories.length || playbooks.length) {
    shapes.ansible = set.has('ansible.cfg') ? 'ansible.cfg' : (inventories[0] || playbooks[0]);
  }
  if (shells.length) shapes.shell = shells[0];
  if (dockerfiles.length) shapes.docker = dockerfiles[0];
  /*
   * ⛔ A DOCUMENTATION REPOSITORY IS A MARKDOWN-ONLY TREE, AND THE EXCLUSION IS WHAT MAKES IT USEFUL.
   * Every archetype has markdown in it; only one of them IS markdown. Without the exclusion the mature
   * product would be asked for a markdownlint config it has no reason to carry, and an item nobody has
   * a reason to satisfy is the item that teaches a reader to skip the list.
   */
  const codeShaped = Boolean(shapes.node || shapes.terraform || shapes.ansible);
  const docPages = markdown.filter((f) => f.startsWith('docs/'));
  if (!codeShaped && (docPages.length || markdown.length >= 2)) shapes.docs = docPages[0] || markdown[0];

  const pkgRel = nodeManifests[0] || null;
  const pkg = pkgRel ? readJSON(at(pkgRel)) : null;
  const config = set.has('respawnpack.config.json') ? readJSON(at('respawnpack.config.json')) : null;

  return {
    dir,
    at,
    files,
    has: (rel) => set.has(rel),
    read: (rel) => readText(at(rel)),
    shapes,
    evidence: shapes,
    recognised: Object.keys(shapes).length > 0,
    workflows,
    inventories,
    tfvars: any(isTfvars),
    terraformFiles: tf,
    markdown,
    pkgRel,
    pkg,
    /* The manifest is on disk (the shape was detected from it) but did not parse — a real third state. */
    pkgUnparseable: Boolean(pkgRel) && pkg === null,
    config,
  };
}

// --- small shared answers ---------------------------------------------------------------------------

const firstPresent = (ctx, candidates) => candidates.find((c) => ctx.has(c)) || null;
const pass = (detail, checked, subject, extra = {}) => ({ outcome: OUTCOME.PASS, detail, checked, subject, ...extra });
const fail = (detail, checked, subject, extra = {}) => ({ outcome: OUTCOME.FAIL, detail, checked, subject, ...extra });
const undetermined = (detail, subject) => ({ outcome: OUTCOME.CANNOT_DETERMINE, detail, checked: 0, subject });

/** A workflow whose text this item needs, or the reason it could not be read. */
function readWorkflows(ctx) {
  const texts = [];
  for (const rel of ctx.workflows) {
    const text = ctx.read(rel);
    if (text === null) return { unreadable: rel };
    texts.push({ rel, text });
  }
  return { texts };
}

// --- the item table -----------------------------------------------------------------------------

/*
 * ⛔ ONE TABLE, AND EVERY ROW CARRIES ITS OWN REMEDY. A checklist that reports a gap without saying what
 * closes it is a checklist whose reader has to go and find out, and the reader who has to go and find
 * out is the reader who stops running it. `remedy` is printed on every FAIL and on every row a posture
 * or an exception lifted, so the answer travels with the finding in all three cases.
 *
 * `tier`: `essential` is asked in every posture that asks anything; `full` adds the rest under
 * `standard` and `strict`. The split is the one the audit's Class E names: five essentials a repository
 * of any shape needs, and the archetype-specific rest.
 */
const ITEMS = [
  {
    id: 'readme',
    tier: 'essential',
    applies: (ctx) => ctx.recognised,
    remedy: 'Add a README.md at the repository root saying what this is and how to run it.',
    check: (ctx) => {
      const found = firstPresent(ctx, ['README.md', 'README.markdown', 'README.rst', 'README.txt', 'README', 'readme.md']);
      return found
        ? pass(`a root README is present: ${found}`, 1, found)
        : fail('no README at the repository root — a reader arriving at this tree is told nothing about it', 1, 'README.md');
    },
  },
  {
    id: 'license',
    tier: 'full',
    applies: (ctx) => ctx.recognised,
    remedy: 'Add a LICENSE file (or a `license` field in package.json) so the terms of use are stated rather than assumed.',
    check: (ctx) => {
      const found = firstPresent(ctx, ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENCE', 'LICENCE.md', 'COPYING']);
      if (found) return pass(`a license file is present: ${found}`, 1, found);
      if (ctx.pkg && typeof ctx.pkg.license === 'string' && ctx.pkg.license.trim()) {
        return pass(`no LICENSE file, but ${ctx.pkgRel} declares license "${ctx.pkg.license}"`, 1, ctx.pkgRel);
      }
      return fail('no LICENSE file and no declared license — the terms this code may be used under are unstated', 1, 'LICENSE');
    },
  },
  {
    id: 'ci-workflow',
    tier: 'essential',
    applies: (ctx) => ctx.recognised,
    remedy: `Add a workflow under ${WORKFLOW_DIR} so the checks run on every push rather than only when somebody remembers.`,
    check: (ctx) => (ctx.workflows.length
      ? pass(`${ctx.workflows.length} CI workflow(s): ${ctx.workflows.join(', ')}`, ctx.workflows.length, WORKFLOW_DIR)
      : fail(`no workflow under ${WORKFLOW_DIR} — nothing runs on a push that nobody is watching`, 1, WORKFLOW_DIR)),
  },
  {
    id: 'test-command',
    tier: 'essential',
    applies: (ctx) => ctx.recognised,
    remedy: 'Declare a test command: a `test` script in package.json, a tests/ directory, or a `qualityGate.checks` entry named test in respawnpack.config.json.',
    check: (ctx) => {
      const declared = (ctx.config && ctx.config.qualityGate && Array.isArray(ctx.config.qualityGate.checks) ? ctx.config.qualityGate.checks : [])
        .find((c) => c && String(c.name || '').toLowerCase() === 'test');
      if (declared) return pass('respawnpack.config.json declares a qualityGate check named `test`', 1, 'respawnpack.config.json');
      if (ctx.pkg && ctx.pkg.scripts && typeof ctx.pkg.scripts.test === 'string' && ctx.pkg.scripts.test.trim()) {
        return pass(`${ctx.pkgRel} declares a \`test\` script: ${ctx.pkg.scripts.test}`, 1, ctx.pkgRel);
      }
      /*
       * ⛔ A MANIFEST THAT WOULD NOT PARSE IS NOT A PROJECT WITHOUT TESTS. The shape was detected from
       * the file being there, so "it is there and I could not read it" is the honest answer and it is
       * CANNOT_DETERMINE, not the FAIL below (anti-drift item 13).
       */
      if (ctx.pkgUnparseable) return undetermined(`${ctx.pkgRel} is present and could not be parsed, so no \`test\` script could be read`, ctx.pkgRel);
      const dir = ['tests', 'test', 'spec', '__tests__'].find((d) => ctx.files.some((f) => f.startsWith(`${d}/`)));
      return dir
        ? pass(`a ${dir}/ directory is present`, 1, `${dir}/`)
        : fail('no test command found: no `test` script, no tests/ directory, and no declared qualityGate check named test', 1, ctx.pkgRel || 'respawnpack.config.json');
    },
  },
  {
    id: 'secret-scan-ci',
    tier: 'full',
    applies: (ctx) => ctx.recognised,
    remedy: 'Install templates/ci/security.yml as .github/workflows/respawnpack-security.yml, or add a gitleaks step — the push-time hook sees only the current diff, never history.',
    check: (ctx) => {
      const installed = ctx.workflows.find((f) => baseOf(f) === 'respawnpack-security.yml');
      if (installed) return pass(`the pack's security workflow is installed: ${installed}`, 1, installed);
      const { texts, unreadable } = readWorkflows(ctx);
      if (unreadable) return undetermined(`${unreadable} could not be read, so whether CI scans for secrets is unestablished`, unreadable);
      const naming = texts.filter((t) => /gitleaks|trufflehog|detect-secrets/i.test(t.text));
      return naming.length
        ? pass(`${naming.length} workflow(s) run a history-wide secret scan: ${naming.map((t) => t.rel).join(', ')}`, texts.length, naming[0].rel)
        : fail(`no workflow scans for secrets (${texts.length} examined) — the push-time hook sees only the current diff, never the history a key was committed into`,
          Math.max(texts.length, 1), WORKFLOW_DIR);
    },
  },
  {
    id: 'codeowners-filled',
    tier: 'full',
    applies: (ctx) => ctx.recognised,
    remedy: 'Fill .github/CODEOWNERS with a real owner (`* @team-or-person`) — a placeholder owner routes review to nobody.',
    check: (ctx) => {
      const rel = firstPresent(ctx, ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS']);
      if (!rel) return fail('no CODEOWNERS file — nothing routes a review to a named owner', 1, '.github/CODEOWNERS');
      const text = ctx.read(rel);
      if (text === null) return undetermined(`${rel} is present and could not be read, so whether it names an owner is unestablished`, rel);
      const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
      /*
       * A CODEOWNERS line is `<pattern> <owner>...`. An owner is an `@handle` (user or team) or an
       * email address, so the first token is skipped and the rest are examined: a pattern that happens
       * to contain an `@` is not an owner, and a file of patterns with no owners routes review nowhere.
       */
      const ownersOf = (l) => l.split(/\s+/).slice(1).filter((t) => /^@[\w./-]+$/.test(t) || /^[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}$/.test(t));
      const owned = lines.filter((l) => ownersOf(l).length);
      const placeholder = owned.filter((l) => ownersOf(l).every((t) => /^@?(?:your|example|org|team|owner|todo|placeholder)/i.test(t.replace(/^@/, ''))));
      const real = owned.filter((l) => !placeholder.includes(l));
      if (real.length) return pass(`${rel} carries ${real.length} owner line(s), first: ${real[0]}`, lines.length || 1, rel);
      return fail(`${rel} names no real owner (${lines.length} rule line(s), ${placeholder.length} placeholder) — a placeholder owner routes review to nobody`,
        Math.max(lines.length, 1), rel);
    },
  },
  {
    id: 'lockfile',
    tier: 'essential',
    applies: (ctx) => Boolean(ctx.shapes.node),
    remedy: 'Commit the lockfile your package manager produces (package-lock.json, pnpm-lock.yaml or yarn.lock) so an install is reproducible.',
    check: (ctx) => {
      const found = firstPresent(ctx, ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'npm-shrinkwrap.json', 'bun.lockb']);
      return found
        ? pass(`a lockfile is committed: ${found}`, 1, found)
        : fail('no lockfile beside package.json — two installs of this project can resolve to different dependency trees', 1, 'package-lock.json');
    },
  },
  {
    id: 'env-ignored',
    tier: 'full',
    applies: (ctx) => ctx.recognised,
    remedy: 'Add a `.env` line to .gitignore — an environment file committed once stays in the history after it is deleted.',
    check: (ctx) => {
      if (!ctx.has('.gitignore')) return fail('no .gitignore, so nothing keeps a .env file out of a commit', 1, '.gitignore');
      const text = ctx.read('.gitignore');
      if (text === null) return undetermined('.gitignore is present and could not be read, so whether it covers .env is unestablished', '.gitignore');
      const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
      /*
       * ⛔ THE RULE MUST COVER `.env` ITSELF, NOT MERELY SOMETHING BESIDE IT. `.env.local` is a
       * perfectly good gitignore line that leaves `.env` tracked, and accepting it would be this item
       * reporting agreement having checked the wrong file. A leading `!` is a NEGATION and is excluded
       * outright: it un-ignores the very path this item is asking about.
       */
      const covers = (l) => {
        if (l.startsWith('!')) return false;
        const rule = l.replace(/^\/+/, '').replace(/^\*\*\//, '').replace(/\/+$/, '');
        return rule === '.env' || rule === '.env*' || rule === '*.env';
      };
      const covering = lines.find(covers);
      return covering
        ? pass(`.gitignore covers environment files: \`${covering}\``, lines.length, '.gitignore')
        : fail(`.gitignore has ${lines.length} rule(s) and none covers \`.env\` — an environment file committed once stays in the history`, Math.max(lines.length, 1), '.gitignore');
    },
  },
  {
    id: 'remote-state-backend',
    tier: 'full',
    applies: (ctx) => Boolean(ctx.shapes.terraform),
    remedy: 'Declare a remote backend (a `backend "s3" {}` block, or `cloud {}`) so the state does not live only on the machine that applied it.',
    check: (ctx) => {
      let read = 0;
      let unreadable = null;
      for (const rel of ctx.terraformFiles) {
        const text = ctx.read(rel);
        if (text === null) { unreadable = rel; break; }
        read += 1;
        if (/\bbackend\s+"[^"]+"\s*\{/.test(text) || /^\s*cloud\s*\{/m.test(text)) {
          return pass(`${rel} declares a remote state backend`, read, rel);
        }
      }
      if (unreadable) return undetermined(`${unreadable} could not be read, so whether a remote backend is declared is unestablished`, unreadable);
      return fail(`no \`backend "…" {}\` block in ${read} Terraform file(s) — the state lives only on the machine that ran apply`, Math.max(read, 1), ctx.shapes.terraform);
    },
  },
  {
    id: 'no-plaintext-creds',
    tier: 'full',
    /*
     * ⛔ APPLIES ONLY WHERE THERE IS SOMETHING TO INSPECT. A Terraform tree with no variable file and no
     * inventory has no subject for this item, and a PASS over zero files is the zero-work green
     * `outcome.js` refuses outright. No candidate file, no row.
     */
    applies: (ctx) => (Boolean(ctx.shapes.terraform) || Boolean(ctx.shapes.ansible)) && (ctx.tfvars.length + ctx.inventories.length) > 0,
    remedy: 'Move the credential out of the variable file into your secret store and reference it by name; rotate it, because a committed key stays in the history.',
    check: (ctx) => {
      const candidates = [...ctx.tfvars, ...ctx.inventories];
      const hits = [];
      let read = 0;
      for (const rel of candidates) {
        const text = ctx.read(rel);
        if (text === null) return undetermined(`${rel} could not be read, so whether it carries a plaintext credential is unestablished`, rel);
        read += 1;
        for (const p of CREDENTIAL_PATTERNS) if (p.re.test(text)) hits.push(`${rel} (${p.name})`);
      }
      return hits.length
        ? fail(`plaintext credential(s) in ${hits.length} of ${read} variable/inventory file(s): ${hits.join(', ')}`, read, hits[0].split(' ')[0])
        : pass(`${read} variable/inventory file(s) examined, none carries a high-severity credential`, read, candidates[0]);
    },
  },
  {
    id: 'vaulted-inventory',
    tier: 'full',
    applies: (ctx) => Boolean(ctx.shapes.ansible) && ctx.inventories.length > 0,
    remedy: 'Encrypt the value with `ansible-vault encrypt_string` and store it as `!vault |`, or move it into a vaulted vars file.',
    check: (ctx) => {
      const bare = [];
      let read = 0;
      for (const rel of ctx.inventories) {
        const text = ctx.read(rel);
        if (text === null) return undetermined(`${rel} could not be read, so whether its secrets are vaulted is unestablished`, rel);
        read += 1;
        for (const line of text.split(/\r?\n/)) {
          if (!/\b(?:ansible_(?:become_)?password|ansible_ssh_pass|ansible_become_pass|password)\s*[:=]/i.test(line)) continue;
          if (/!vault|\{\{|ansible-vault|\$ANSIBLE_VAULT/.test(line)) continue;
          bare.push(`${rel}: ${line.trim().slice(0, 80)}`);
        }
      }
      return bare.length
        ? fail(`${bare.length} inventory password key(s) are not vaulted: ${bare.join('; ')}`, read, ctx.inventories[0])
        : pass(`${read} inventory file(s) examined, every password key is vaulted or absent`, read, ctx.inventories[0]);
    },
  },
  {
    id: 'health-route',
    tier: 'full',
    applies: (ctx) => Boolean(ctx.shapes.node),
    remedy: 'Add a health endpoint (a `/health` route, or a src/health.js the deploy check can call) so a deploy can be verified rather than assumed.',
    check: (ctx) => {
      const CODE = ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx'];
      const byName = ctx.files.find((f) => CODE.includes(extOf(f)) && /health/i.test(baseOf(f)));
      if (byName) return pass(`a health module is present: ${byName}`, 1, byName);
      const specs = ctx.files.filter((f) => /^openapi\.(?:ya?ml|json)$/i.test(baseOf(f)) || /^swagger\.(?:ya?ml|json)$/i.test(baseOf(f)));
      for (const rel of specs) {
        const text = ctx.read(rel);
        if (text === null) return undetermined(`${rel} could not be read, so whether a health route is declared is unestablished`, rel);
        if (/\/health(?:z|check)?\b/.test(text)) return pass(`${rel} declares a health route`, 1, rel);
      }
      return fail('no health module and no declared /health route — a deploy can be reported succeeded without anything having answered', 1, ctx.shapes.node);
    },
  },
  {
    id: 'migrations-dir',
    tier: 'full',
    /*
     * A schema is what makes this question meaningful: a Node service with no persistent store has
     * nothing to migrate, and asking it for a migrations directory would be an item nobody can satisfy.
     */
    applies: (ctx) => Boolean(ctx.shapes.node) && Boolean(schemaEvidence(ctx)),
    remedy: 'Put the schema changes in a migrations/ directory, applied before the code that needs them (skills/ship Step 3).',
    check: (ctx) => {
      const dir = ['migrations', 'db/migrations', 'prisma/migrations', 'drizzle', 'sql/migrations']
        .find((d) => ctx.files.some((f) => f.startsWith(`${d}/`)));
      const schema = schemaEvidence(ctx);
      return dir
        ? pass(`${schema} declares a schema and ${dir}/ carries its migrations`, 1, `${dir}/`)
        : fail(`${schema} declares a schema and there is no migrations/ directory — a schema change would ship as a hand-run statement nobody recorded`, 1, schema);
    },
  },
  {
    id: 'error-tracking',
    tier: 'full',
    applies: (ctx) => Boolean(ctx.shapes.node),
    /*
     * ⛔ ABSENT IS A FAIL WITH THE REMEDY, NEVER A GUESS. "Maybe they log to something this list does
     * not know" is exactly the reasoning that turns a checklist into decoration: the item cannot see it,
     * so it says it cannot see it and says what would satisfy it. A project that reports errors some
     * other way excepts the item by name, with a reason, in the one grammar that carries one.
     */
    remedy: 'Wire an error reporter (Sentry, Bugsnag, Rollbar, OpenTelemetry) — or except this item by name with the reason your service reports errors another way.',
    check: (ctx) => {
      const NAMES = /(sentry|bugsnag|rollbar|honeybadger|airbrake|opentelemetry|@opentelemetry|datadog|dd-trace)/i;
      const deps = ctx.pkg ? Object.keys({ ...(ctx.pkg.dependencies || {}), ...(ctx.pkg.devDependencies || {}) }) : [];
      const dep = deps.find((d) => NAMES.test(d));
      if (dep) return pass(`${ctx.pkgRel} depends on ${dep}`, 1, ctx.pkgRel);
      const file = ctx.files.find((f) => NAMES.test(f));
      if (file) return pass(`an error-reporting module is present: ${file}`, 1, file);
      if (ctx.pkgUnparseable) return undetermined(`${ctx.pkgRel} is present and could not be parsed, so its dependencies could not be read`, ctx.pkgRel);
      return fail(`no error reporter in ${deps.length} declared dependenc(ies) and none in the tree — a production failure is visible only to whoever is reading the logs`,
        1, ctx.pkgRel || 'package.json');
    },
  },
  {
    id: 'link-check',
    tier: 'full',
    applies: (ctx) => Boolean(ctx.shapes.docs),
    remedy: 'Add a markdownlint config (.markdownlint.json) or a link checker (lychee, markdown-link-check) so a broken cross-reference is caught before a reader finds it.',
    check: (ctx) => {
      const cfg = firstPresent(ctx, [
        '.markdownlint.json', '.markdownlint.jsonc', '.markdownlint.yaml', '.markdownlint.yml', '.markdownlintrc',
        '.markdownlint-cli2.jsonc', '.mlc_config.json', 'lychee.toml', '.lycheeignore',
      ]);
      if (cfg) return pass(`a documentation linter is configured: ${cfg}`, 1, cfg);
      const { texts, unreadable } = readWorkflows(ctx);
      if (unreadable) return undetermined(`${unreadable} could not be read, so whether links are checked in CI is unestablished`, unreadable);
      const wf = texts.find((t) => /lychee|markdown-link-check|markdownlint/i.test(t.text));
      if (wf) return pass(`${wf.rel} checks documentation links`, Math.max(texts.length, 1), wf.rel);
      return fail(`no markdownlint or link-check configuration, and none of ${texts.length} workflow(s) runs one — a broken cross-reference is found by a reader`,
        Math.max(ctx.markdown.length, 1), '.markdownlint.json');
    },
  },
  {
    id: 'index-page',
    tier: 'essential',
    applies: (ctx) => Boolean(ctx.shapes.docs),
    remedy: 'Add docs/index.md (or docs/README.md) listing the pages, so a reader has one place to start.',
    check: (ctx) => {
      const found = firstPresent(ctx, ['docs/index.md', 'docs/README.md', 'docs/readme.md', 'docs/index.markdown']);
      return found
        ? pass(`the documentation has an entry point: ${found}`, 1, found)
        : fail(`no docs/index.md or docs/README.md across ${ctx.markdown.length} markdown page(s) — a reader has no place to start`, Math.max(ctx.markdown.length, 1), 'docs/index.md');
    },
  },
];

/** The declaration that makes `migrations-dir` a meaningful question, or null. */
function schemaEvidence(ctx) {
  const direct = ctx.files.find((f) => /^prisma\/schema\.prisma$/.test(f) || /^(?:drizzle|knexfile)\.(?:js|ts|mjs|cjs)$/.test(f)
    || /^(?:db|database|sql)\/schema\.sql$/.test(f) || /^schema\.(?:sql|prisma)$/.test(f));
  if (direct) return direct;
  const deps = ctx.pkg ? Object.keys({ ...(ctx.pkg.dependencies || {}), ...(ctx.pkg.devDependencies || {}) }) : [];
  const dep = deps.find((d) => /^(?:prisma|@prisma\/client|knex|sequelize|typeorm|drizzle-orm|mikro-orm)$/i.test(d));
  return dep ? `${ctx.pkgRel} (${dep})` : null;
}

// --- the run -----------------------------------------------------------------------------------

const RELAXING_VERDICTS = new Set(['advise', 'off']);

/** The one row for a tree this module recognises nothing in. */
function unrecognised(dir) {
  return result(OUTCOME.CANNOT_DETERMINE, 'readiness:applicable',
    'no readiness item applies here: nothing in this tree was recognised as a Node, Terraform, Ansible, shell, container or documentation project. '
    + 'This is CANNOT_DETERMINE and not a pass — a checklist that asked zero questions has established nothing about whether this is releasable.',
    { checked: 0, domain: 'gate', subject: path.basename(dir) || dir, item: 'applicable' });
}

/**
 * Run the readiness checklist and return a verdict.
 *
 * @param {string} dir the project root
 * @param {{posture?:{profile:string, rule:string, verdict:string}|null, exception?:Function}} [opts]
 *   `posture` is the caller's already-taken ADR-003 `kernel:readiness` decision — `{profile, rule,
 *   verdict}` when the DECLARED posture relaxes this row, and null (meaning `deny`) otherwise. See the
 *   header: the decision is taken once per verb in kernel/respawnpack.js, never re-read here.
 *   `exception(itemId)` answers with the declared exception entry that lifts that item, or null. The
 *   kernel builds it from `hooks/_exceptions.js` `allowed(resolved, 'readiness', {item})`, so this
 *   module never becomes a second reader of the one exception grammar.
 * @returns {{outcome:string, why:string, checks:Array<Object>, tier:string, profile:string|null}}
 */
function runReadiness(dir, { posture = null, exception = null } = {}) {
  const ctx = detect(dir);
  const relaxing = Boolean(posture) && posture.rule === POSTURE_ROW && RELAXING_VERDICTS.has(posture.verdict);
  const profile = relaxing ? posture.profile : null;
  const tier = relaxing ? (TIER_BY_PROFILE[profile] || 'full') : 'full';
  const ask = (item) => tier === 'full' || item.tier === 'essential';

  const applicable = ITEMS.filter((i) => i.applies(ctx));
  if (!applicable.length) {
    const row = unrecognised(dir);
    return {
      outcome: row.outcome, why: row.detail, checks: [row], tier, profile,
      detected: {}, applicable: 0, relaxed: [], wouldFail: [], excepted: [], notAsked: [],
    };
  }

  const checks = [];
  const relaxed = [];
  const wouldFail = [];
  const excepted = [];
  const notAsked = [];

  for (const item of applicable) {
    const check = `readiness:${item.id}`;
    const meta = { domain: 'gate', item: item.id, tier: item.tier, remedy: item.remedy };

    /*
     * ⛔ THE EXCEPTION IS ASKED FIRST, AND IT IS ASKED IN EVERY POSTURE. A founder's reviewed judgement
     * about one item outranks the tier and outranks `strict`, because the lift is narrower than either:
     * it names one subject, carries a reason, lives in a tracked file, and is REPORTED here under its
     * own id. That is the whole difference between this grammar and an override.
     */
    const lift = typeof exception === 'function' ? exception(item.id) : null;
    if (lift) {
      excepted.push(item.id);
      checks.push(result(OUTCOME.NOT_APPLICABLE, check,
        `allowed by exception ${lift.id}: ${lift.reason}. ${item.remedy}`,
        { checked: 0, subject: 'respawnpack.config.json', exception: lift.id, ...meta }));
      continue;
    }

    if (!ask(item)) {
      /*
       * ADR-003 mechanism (b): the row is NOT_APPLICABLE by DECLARATION — the founder's posture, in a
       * tracked file — with an AUTHORED reason naming it, and the absence needs no inference at all
       * because the tier is a property of the table above. The row still exists (anti-drift item 12).
       */
      notAsked.push(item.id);
      checks.push(result(OUTCOME.NOT_APPLICABLE, check,
        `not asked under the declared \`${profile}\` posture, which runs the essential tier only (ADR-003 ${POSTURE_ROW}). `
        + `Declare \`standard\` or \`strict\` and this item is checked. ${item.remedy}`,
        { checked: 0, subject: 'respawnpack.config.json', postureRelaxed: profile, postureRule: POSTURE_ROW, ...meta }));
      continue;
    }

    const r = item.check(ctx);
    if (r.outcome === OUTCOME.FAIL) {
      wouldFail.push(item.id);
      if (relaxing) {
        /*
         * ADR-003 mechanism (a), the shape `applicability.relaxedCheck()` uses: the reason it would
         * have failed stays FIRST in `detail`, `checked: 1` counts the declaration that was inspected
         * — the posture, a value in a tracked reviewable file — and only the OUTCOME moved.
         */
        relaxed.push(item.id);
        checks.push(result(OUTCOME.PASS, check,
          `${r.detail}. ${item.remedy} Reported rather than refused: the declared \`${profile}\` posture relaxes this row to an advisory (ADR-003 ${POSTURE_ROW}).`,
          { checked: 1, subject: r.subject, postureRelaxed: profile, postureRule: POSTURE_ROW, ...meta }));
        continue;
      }
      checks.push(result(OUTCOME.FAIL, check, `${r.detail}. ${item.remedy}`, { checked: r.checked, subject: r.subject, ...meta }));
      continue;
    }
    /*
     * ⛔ CANNOT_DETERMINE IS NEVER RELAXED, IN ANY POSTURE (anti-drift item 13). A posture answers for a
     * question nobody asked; it does not answer for a file nobody could read. Relaxing this one would be
     * the gate reporting green on a check that could not run, which is the defect the whole four-outcome
     * contract exists to end.
     */
    checks.push(result(r.outcome, check, r.outcome === OUTCOME.PASS ? r.detail : `${r.detail}. ${item.remedy}`,
      { checked: r.checked, subject: r.subject, ...meta }));
  }

  /*
   * ⛔ AND A RUN WHERE NOTHING WAS ACTUALLY EXAMINED IS CANNOT_DETERMINE, NOT NOT_APPLICABLE. Every
   * applicable item excepted or scoped out of the tier leaves a report full of rows and zero findings;
   * `rollup` would call that NOT_APPLICABLE at exit 0, which reads as "checked and fine". Anti-drift
   * item 1's rule is about the shape, not only about the word PASS: zero work establishes nothing.
   */
  const examined = checks.reduce((n, c) => n + (Number.isFinite(c.checked) ? c.checked : 0), 0);
  const outcome = examined > 0 ? rollup(checks) : OUTCOME.CANNOT_DETERMINE;

  const failing = checks.filter((c) => c.outcome === OUTCOME.FAIL).length;
  const unrunnable = checks.filter((c) => c.outcome === OUTCOME.CANNOT_DETERMINE).length;
  const detectedWords = Object.entries(ctx.shapes).map(([k, v]) => `${k} (${v})`).join(', ');
  let why;
  /*
   * ⛔ THE LADDER IS `gate.js`'s, IN THE SAME ORDER AND FOR THE SAME REASON. A real failure outranks an
   * unanswered question, which outranks a pass — the ordering `outcome.js`'s RANK already applies to the
   * OUTCOME, restated here so the sentence a reader quotes cannot lead with a different finding than the
   * verdict beside it did.
   */
  if (!examined) {
    why = `${checks.length} applicable item(s), and every one of them was lifted by an exception or is outside the \`${profile}\` tier — `
      + 'nothing was examined, so this run establishes nothing. That is CANNOT_DETERMINE, not a pass.';
  } else if (failing) {
    why = `${failing} of ${checks.length} readiness item(s) failed under \`${profile || 'strict'}\`: ${checks.filter((c) => c.outcome === OUTCOME.FAIL).map((c) => c.item).join(', ')}.`
      + `${unrunnable ? ` A further ${unrunnable} could not be checked at all.` : ''} Detected: ${detectedWords}.`;
  } else if (unrunnable) {
    why = `${unrunnable} item(s) could not be checked (a file they needed could not be read): `
      + `${checks.filter((c) => c.outcome === OUTCOME.CANNOT_DETERMINE).map((c) => c.item).join(', ')}. A check that could not run is never a pass.`;
  } else if (relaxed.length) {
    why = `${checks.length} readiness item(s) reported, ${relaxed.length} of which would FAIL under \`strict\`: ${relaxed.join(', ')}. `
      + `The declared \`${profile}\` posture relaxes ${POSTURE_ROW} to an advisory, so this run is PASS with every row above still visible. Detected: ${detectedWords}.`;
  } else {
    why = `${checks.length} readiness item(s) checked and ${excepted.length + notAsked.length} not applicable; none failed under \`${profile || 'strict'}\`. Detected: ${detectedWords}.`;
  }

  return {
    outcome, why, checks, tier, profile,
    detected: { ...ctx.shapes },
    applicable: applicable.length,
    relaxed, wouldFail, excepted, notAsked,
  };
}

module.exports = { POSTURE_ROW, TIERS, TIER_BY_PROFILE, CREDENTIAL_PATTERNS, ITEMS, detect, runReadiness };
