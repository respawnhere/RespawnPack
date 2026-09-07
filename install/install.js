#!/usr/bin/env node
/*
 * RespawnPack installer — drops the framework into a target repo.
 *   node install/install.js [targetDir]   (default: cwd)
 *     --force      overwrites existing FRAMEWORK files, but SKIPS protected files
 *                  (canonical docs + config the user hand-fills — see PROTECTED below)
 *     --force-all  overwrites everything, including protected files (prints a warning first)
 *     --dry-run    prints the full summary (create/skip/protect/gitignore/monorepo detection)
 *                  but writes nothing: no file, no dir, no settings.json merge, no .gitignore edit
 *     --migrate-removals-scope  explicitly authorizes widening an exact legacy docs-only removals block
 *                  to the current root-wide default. Without it, the installer previews the migration.
 *     --with-memory  the ONE capability flag (ADR-002). Installs the optional memory ENGINE:
 *                  copies it into .claude/respawnpack/memory/engine, npm-installs it there, and
 *                  registers `respawn-memory` in the target's .mcp.json against an absolute Node
 *                  path. WITHOUT it, memory still works — memory/graph + grep is the zero-setup
 *                  default, not a degraded fallback. This remains the only flag that changes what
 *                  the pack can DO.
 *                  ⛔ It was missing from this banner while two READMEs documented it — the pack's
 *                  single opt-in capability, absent from the installer's own help text. The other
 *                  flags change installer behavior or authorize a named migration.
 * Idempotent: existing files are SKIPPED (never clobbered) unless --force/--force-all.
 * settings.json hooks + permissions.allow are MERGED, never overwritten — and the hook half of that
 * merge now remembers what it placed (.respawnpack/install-receipt.json §7-PRE/§7d), so a hook entry
 * the founder DELETED is left deleted instead of being re-added as though it were new.
 * No third-party dependencies (fs/path/child_process only — child_process is a Node builtin, used
 * only to shell out to `git check-ignore` for the .gitignore self-heal below — plus this pack's own
 * install/_sources.js, the ONE shared list of source trees/files this installer and upgrade.js's
 * preflight both read unguarded; see that module's header for why it is one list, not two).
 * Requires Node + git on the target; git's absence only disables the self-heal (skipped silently),
 * it doesn't fail the install.
 *
 * PREFLIGHT: before any file is placed, the pack source is checked against install/_sources.js —
 * every listed source tree enumerable and non-empty, every listed file readable. A torn checkout
 * (shallow clone, sparse checkout, bad merge) aborts here, cleanly, before the first file is
 * written — not mid-placement with a half-installed target. upgrade.js runs the identical check,
 * from the same list, before its own phase 1 deletes anything.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { SOURCE_TREES, SOURCE_FILES, KERNEL_FILES, CORE_FILES, ADAPTER_FILES } = require('./_sources.js');
// P3-T-11: the settings merge composes the registration set for the target's declared posture. Both of
// these live in the PACK source, never in the target, and neither is placed by this installer.
const manifest = require('./_settings-manifest.js');
const posture = require('../hooks/_posture.js');

const SRC = path.resolve(__dirname, '..');
/*
 * ⛔ AN UNKNOWN FLAG IS AN ERROR, NOT A TARGET DIRECTORY. `uninstall.js` and `upgrade.js` both guard
 * this; `install.js` did not, so `node install/install.js --dry-runn` resolved the target to a
 * directory literally named `--dry-runn` and installed 163 files into it. A typo in a destructive-ish
 * command must fail loudly, and the flag it names is exactly the one whose protection was intended.
 */
const KNOWN_FLAGS = new Set(['--force', '--force-all', '--dry-run', '--with-memory', '--migrate-removals-scope']);
const argv = process.argv.slice(2).filter((a) => !KNOWN_FLAGS.has(a));
const unknownFlags = argv.filter((a) => a.startsWith('-'));
if (unknownFlags.length) {
  console.error(`Unknown flag(s): ${unknownFlags.join(' ')} — supported: ${[...KNOWN_FLAGS].join(' ')}`);
  process.exit(2);
}
const FORCE_ALL = process.argv.includes('--force-all');
const FORCE = process.argv.includes('--force') || FORCE_ALL; // --force-all implies --force's "overwrite framework files" behavior
const DRY_RUN = process.argv.includes('--dry-run');
// Founder-owned config is migrated only with explicit authorization; structural equality is evidence,
// not provenance. upgrade.js forwards this opt-in when its owner supplied it.
const MIGRATE_REMOVALS_SCOPE = process.argv.includes('--migrate-removals-scope');
// More than one positional means the shell split an unquoted spaced path ("install.js C:\My Projects\app"
// would silently target C:\My) or a stray argument — refuse before ANY action, naming every value seen.
if (argv.length > 1) {
  console.error(`Too many positional arguments — expected at most one (the target dir), got: ${argv.map((a) => `"${a}"`).join(' ')}. If the path has spaces, quote it.`);
  process.exit(1);
}
const TARGET = path.resolve(argv[0] || process.cwd());
const today = new Date().toISOString().slice(0, 10);
const project = path.basename(TARGET);

// Self-target refusal must hold on case-insensitive filesystems too (the win32/darwin defaults), where
// "C:\Pack" and "C:\PACK" are the same directory but distinct strings: canonicalize through the FS
// (realpath resolves case + symlinks; fall back to the resolved path when it can't, e.g. a target dir
// that doesn't exist yet), then case-fold on the platforms whose default FS ignores case.
const canonicalDir = (p) => {
  let r; try { r = fs.realpathSync.native(p); } catch { r = path.resolve(p); }
  return process.platform === 'win32' || process.platform === 'darwin' ? r.toLowerCase() : r;
};
const inside = (root, candidate) => {
  const rel = path.relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
};
const posixPath = (p) => String(p).replace(/\\/g, '/');
const portableAbsolute = (p) => path.isAbsolute(p) || /^[A-Za-z]:[\\/]/.test(p) || /^[\\/]/.test(p);
function containedResolution(projectDir, candidate) {
  const projectRoot = path.resolve(projectDir);
  const abs = path.resolve(candidate);
  if (!inside(projectRoot, abs)) return { ok: false, kind: 'lexical' };
  const prospectiveReal = (value) => {
    let probe = value;
    for (;;) {
      try { fs.lstatSync(probe); break; }
      catch (e) {
        if (!e || e.code !== 'ENOENT') return { error: e };
        const parent = path.dirname(probe);
        if (parent === probe) return { error: e };
        probe = parent;
      }
    }
    try {
      const realProbe = fs.realpathSync.native(probe);
      return { exists: probe === value, path: path.resolve(realProbe, path.relative(probe, value)) };
    } catch (e) { return { error: e }; }
  };
  const projectResolved = prospectiveReal(projectRoot);
  const candidateResolved = prospectiveReal(abs);
  if (projectResolved.error || candidateResolved.error) {
    return { ok: false, kind: 'unresolved', error: projectResolved.error || candidateResolved.error };
  }
  if (!inside(projectResolved.path, candidateResolved.path)) return { ok: false, kind: 'symlink' };
  return { ok: true, exists: candidateResolved.exists, realPath: candidateResolved.path };
}
if (canonicalDir(TARGET) === canonicalDir(SRC)) { console.error('Refusing to install RespawnPack into itself.'); process.exit(1); }

/*
 * Preflight — nothing is placed until this passes. install/_sources.js is the ONE shared list of
 * every source tree and individually-read file this installer reads unguarded; upgrade.js's own
 * preflight requires the same module and runs the identical check before its phase 1 deletes
 * anything (docs/derived/state/pairs.json P-002 — this used to be two independently hand-written
 * lists, and it drifted exactly that way: upgrade.js's copy omitted kernel/ and core/ for as long
 * as it existed). A torn checkout must fail here, cleanly, before the first file is written — not
 * mid-placement with a half-installed target and a raw ENOENT stack trace.
 */
const sourceProblems = [];
for (const rel of SOURCE_TREES) {
  let entries = null;
  try { entries = fs.readdirSync(path.join(SRC, rel)); } catch { sourceProblems.push(`${rel}/ is missing or unreadable`); continue; }
  if (!entries.length) sourceProblems.push(`${rel}/ is empty`);
}
for (const rel of SOURCE_FILES) {
  try { fs.readFileSync(path.join(SRC, rel)); } catch { sourceProblems.push(`${rel} is missing or unreadable`); }
}
if (sourceProblems.length) {
  console.error(`Preflight failed — the pack source at ${SRC} is not sane; NOTHING was written to the target:`);
  for (const p of sourceProblems) console.error(`  - ${p}`);
  console.error('Fix the pack checkout (git status, or re-clone) and re-run.');
  process.exit(1);
}

// Protected: canonical docs + config the user hand-fills after install. Plain --force never touches
// these (they'd clobber real project content); --force-all does, after printing an explicit warning.
const PROTECTED = new Set([
  'docs/PRODUCT.md', 'docs/FEATURES-PAGES.md', 'docs/DECISIONS.md', 'docs/DESIGN.md', 'docs/ARCHITECTURE-ROADMAP.md',
  'compliance.config.md',
  'docs/compliance/README.md', 'docs/compliance/REGISTER.md', 'docs/compliance/RoPA.md', 'docs/compliance/breach-runbook.md', 'docs/compliance/dpa-baa-checklist.md',
  'respawnpack.config.json',
]);
if (FORCE_ALL) {
  console.warn(`⚠️  --force-all: ${DRY_RUN ? 'would overwrite' : 'will overwrite'} protected file(s) if present: ${[...PROTECTED].join(', ')}`);
}

const created = [], skipped = [], protectedKept = [];
// Every dest path the installer manages this run, regardless of created/skipped/protected outcome. The
// .gitignore self-heal (below) checks all of these, not just the ones actually written this run, so it also
// catches paths that already existed from a prior install but are newly caught by an edited target .gitignore.
const placedPaths = new Set();
const read = (p) => fs.readFileSync(p, 'utf8');
const exists = (rel) => fs.existsSync(path.join(TARGET, rel));
// Both DRY_RUN-aware so every call site downstream is automatically a no-op in --dry-run, instead of having
// to remember to gate each individual fs.mkdirSync/fs.writeFileSync call by hand.
const assertSafeDestination = (p) => {
  const resolved = containedResolution(TARGET, p);
  if (resolved.ok) return;
  const why = resolved.kind === 'symlink'
    ? 'resolves outside the target through a symlink'
    : resolved.kind === 'lexical'
      ? 'resolves outside the target'
      : `could not be resolved (${(resolved.error && (resolved.error.code || resolved.error.message)) || 'unknown error'})`;
  throw new Error(`Refusing installer destination ${posixPath(path.relative(TARGET, p) || '.')}: ${why}`);
};
// The same authority check runs in preview and real modes. A dry run that says a write is safe when the
// real run refuses (or writes through a symlink) is not a preview of the operation it authorizes.
const ensureDir = (p) => { assertSafeDestination(p); if (!DRY_RUN) fs.mkdirSync(p, { recursive: true }); };
const writeFile = (p, content) => { assertSafeDestination(p); if (!DRY_RUN) fs.writeFileSync(p, content); };

function transformSpine(txt) {
  return txt
    .replace(/^<!-- RESPAWNPACK SPINE TEMPLATE.*-->\r?\n/, '') // strip template marker
    .replace(/<PROJECT>/g, project)
    .replace(/<date>/g, today);
}
function place(srcRel, destRel, spine = false) {
  const relNorm = destRel.replace(/\\/g, '/');
  placedPaths.add(relNorm);
  const d = path.join(TARGET, destRel);
  const isProtected = PROTECTED.has(relNorm);
  if (fs.existsSync(d)) {
    if (isProtected && !FORCE_ALL) { protectedKept.push(destRel); return; } // protected: only --force-all overwrites
    if (!isProtected && !FORCE) { skipped.push(destRel); return; } // framework file: plain --force overwrites
  }
  ensureDir(path.dirname(d));
  let txt = read(path.join(SRC, srcRel));
  if (spine) txt = transformSpine(txt);
  writeFile(d, txt);
  created.push(destRel);
}

// 1. Spine → docs/
place('spine/README.md', 'docs/README.md', true);
for (const f of ['PRODUCT', 'FEATURES-PAGES', 'DECISIONS', 'DESIGN', 'ARCHITECTURE-ROADMAP']) place(`spine/${f}.md`, `docs/${f}.md`, true);
for (const f of ['CHANGELOG', 'GAPS', 'CONTINUITY']) place(`spine/derived/${f}.md`, `docs/derived/${f}.md`, true);
place('spine/reference/README.md', 'docs/reference/README.md', true);
place('spine/reference/coding-standards.md', 'docs/reference/coding-standards.md');
place('spine/reference/writing-standards.md', 'docs/reference/writing-standards.md'); // prose sibling of coding-standards; /wordsmith + /build apply it
place('spine/reference/performance-standards.md', 'docs/reference/performance-standards.md'); // scale sibling; /loadout scale-models, /review perf lens, /ship gates hot paths
place('spine/reference/behavior-standards.md', 'docs/reference/behavior-standards.md'); // conduct baseline; a digest is injected into CLAUDE.md below
place('spine/reference/design-standards.md', 'docs/reference/design-standards.md'); // fifth standard, visual/interaction sibling; wired into /loadout, /build, /review (design-reviewer lens), and /ship
// design-standards splits into an index (above) + one detail file per §-group, so the small-context design-reviewer lens loads only the section a diff touches
for (const d of ['01-interaction-craft', '02-visual-system', '03-psychology-of-use', '04-accessibility', '05-validation']) place(`spine/reference/design-standards/${d}.md`, `docs/reference/design-standards/${d}.md`);
place('spine/reference/compliance-requirements.md', 'docs/reference/compliance-requirements.md');
place('spine/reference/skill-authoring-standards.md', 'docs/reference/skill-authoring-standards.md'); // sixth standard: how skills themselves are written and pruned (listing budget, guidance forms); /skill-guard audits overlays against it
place('spine/reference/testing-standards.md', 'docs/reference/testing-standards.md'); // seventh standard: /build writes tests to it, /review checks coverage, /playtest proves bugs dead (Wave 6, 4-repo convergence)
place('spine/reference/orchestration-patterns.md', 'docs/reference/orchestration-patterns.md'); // subagent discipline: dispatch briefs, file-handoff, model tiers, fix isolation; /build//review//debug reference it
place('spine/reference/observability-basics.md', 'docs/reference/observability-basics.md'); // instrumentation-design floor: structured logs + symptom alerts; /build instruments at build time, not after the first incident
place('spine/reference/living-skills.md', 'docs/reference/living-skills.md'); // frozen-base + living-overlay skill doctrine
// The capability register and the per-family prompting practice (P4-M-1): a target reads its OWN copy
// under docs/reference/models/ first (the task runner and the offload path fall back to the pack's copy
// only when this one is absent), so the register a project routes by is the one it can edit and commit.
for (const f of ['capability-register.json', 'capability-register.md', 'prompting-anthropic.md', 'prompting-openai.md', 'prompting-minimax.md', 'prompting-general.md']) place(`spine/reference/models/${f}`, `docs/reference/models/${f}`);
place('spine/_archive/README.md', 'docs/_archive/README.md', true);

// 1b. Compliance adherence: living artifacts /comply maintains (spine → docs/compliance/; the scope declaration → repo root)
// compliance.config.md is placed UNCONDITIONALLY — it is the form a target fills in to declare a
// scope, so its own placement cannot depend on a scope it has not yet been given the chance to
// state. Protected (PROTECTED, above), so a founder's own triage always survives a re-run.
place('spine/compliance/compliance.config.md', 'compliance.config.md', true);

/*
 * ⛔ library/ AND docs/compliance/ USED TO LAND IN EVERY TARGET REGARDLESS OF COMPLIANCE SCOPE.
 * 471 KB / 24 files of vendored regulation texts (library/) plus 19.8 KB / 5 files of living
 * compliance pages (docs/compliance/) — 21.9% of everything a fresh install placed — shipped to
 * projects that never declared handling any regulated data at all.
 *
 * ⭐ GATED ON THE SCOPE compliance.config.md DECLARES, NEVER ON POSTURE (decision 2.7,
 * the rework task list). `/comply` already reads this same file at Step 0 to triage which regimes
 * apply (skills/comply/SKILL.md) — this reads the identical file rather than inventing a second
 * declaration mechanism, and never consults `posture`.
 *
 * Read from the target when compliance.config.md already existed (protected — a founder's own
 * triage), or from the just-placed template otherwise; `exists()` after the place() call above is
 * accurate in --dry-run too, since writeFile() is a DRY_RUN-aware no-op there and place() never
 * marks a path as existing that it did not actually write.
 */
function parseComplianceScope(text) {
  if (!text || !text.trim()) return { ok: false, reason: 'compliance.config.md is empty' };
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s*4\.\s*Applicable frameworks\b/.test(l));
  if (start === -1) return { ok: false, reason: 'no "## 4. Applicable frameworks" heading — cannot locate the scope declaration' };
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) { if (/^##\s/.test(lines[i])) { end = i; break; } }
  const section = lines.slice(start + 1, end).join('\n');
  const bulletText = (label) => {
    const m = section.match(new RegExp(`^-\\s*\\*\\*${label}[^*]*\\*\\*:?\\s*(.*)$`, 'mi'));
    return m ? m[1] : null;
  };
  const defaultScope = bulletText('Default scope');
  const conditionalScope = bulletText('Conditional/sector');
  const outOfScope = bulletText('Explicitly out of scope');
  if (defaultScope === null && conditionalScope === null && outOfScope === null) {
    return { ok: false, reason: 'section 4 has none of the "Default scope" / "Conditional/sector" / "Explicitly out of scope" bullets — the file does not match the pack\'s compliance.config.md structure' };
  }
  // Blank, an untouched "<e.g. ...>" placeholder, or a literal "none"/"n/a" all mean the same thing:
  // nothing has been declared into this bullet yet.
  const isUnfilled = (s) => { const t = (s || '').trim(); return !t || /^<.*>$/.test(t) || /^(none|n\/a|not applicable|nothing)\.?$/i.test(t); };
  return { ok: true, hasScope: !isUnfilled(defaultScope) || !isUnfilled(conditionalScope) };
}
const complianceConfigRel = 'compliance.config.md';
const complianceConfigText = exists(complianceConfigRel)
  ? read(path.join(TARGET, complianceConfigRel))
  : transformSpine(read(path.join(SRC, 'spine', 'compliance', 'compliance.config.md')));
const complianceScope = parseComplianceScope(complianceConfigText);
// Three outcomes, never "place everything to be safe": ok:false (unparseable — place NOTHING from
// either tree; the CANNOT_DETERMINE shape), ok:true+hasScope:false (untouched template — a project
// that has not triaged yet), ok:true+hasScope:true (a real scope is declared).
const placeComplianceMaterial = complianceScope.ok && complianceScope.hasScope;

for (const f of ['README', 'REGISTER', 'RoPA', 'breach-runbook', 'dpa-baa-checklist']) {
  if (placeComplianceMaterial) place(`spine/compliance/${f}.md`, `docs/compliance/${f}.md`, true);
}

// 2. Skills (roles + knowledge + ops) → .claude/skills/<name>/SKILL.md
const skillDirs = [
  'skills/respawn', 'skills/loadout', 'skills/build', 'skills/review', 'skills/playtest', 'skills/walkthrough', 'skills/ship', 'skills/debug', 'skills/secure', 'skills/comply', 'skills/savepoint', 'skills/wordsmith',
  'memory/knowledge', 'ops/deploy-verify', 'ops/db-ops', 'ops/secrets-audit', 'ops/infra-status',
  'skills/skill-guard', // operates the living-skill mechanism (/skill-drift + /skill-reset)
  'skills/checkup', // periodic codebase-health scan (module depth); command-only via disable-model-invocation, zero listing cost
  'skills/onboard', // brownfield adoption: evidence-cited spine drafts + per-section confirmation; command-only, /respawn recommends it on un-spined repos
  'skills/task', // fresh-session-per-task delegate role the task-runner queue spawns; a thin skin over contract delegate
  'skills/aar', // the after-action role: runs the `aar` verb for a window and proposes the human NOTE; command-only, zero listing cost
];
for (const sd of skillDirs) place(`${sd}/SKILL.md`, `.claude/skills/${path.basename(sd)}/SKILL.md`);

// 2b. Detect stack — hoisted here (was section "6", below the skill-placement loop) because 2e's MCP-skill
// gate needs opsTargets computed before it runs. Pure relocation: the detection logic itself is unchanged,
// only its position moved earlier in the file.
/*
 * ⛔ AN UNDETECTED ROUTE SOURCE IS `null`, NOT A STRING THAT LOOKS LIKE AN ANSWER.
 *
 * This used to seed the literal `"<set ROUTE_SOURCE>"`, and `codeTruth` got the same treatment
 * unconditionally. Both are read by /savepoint's drift steps, which enumerate them against
 * FEATURES-PAGES.md. Handed a template, the routes↔matrix step globs zero routes, finds zero orphans in
 * both directions, and reports no drift — a check agreeing with everything, wearing a config key. It is
 * also the defect the seed fifteen lines below `state.reconcile` was written to avoid: declare nothing
 * rather than declare something false. So an undetected value writes NO KEY, and an absent key is
 * UNDECIDED — reported by `doctor` as onboarding-incomplete and resolved by /respawn, never inferred
 * into either a value or a not-applicable. See kernel/lib/applicability.js.
 */
let routeSource = null;
if (exists('src/app') || exists('app')) routeSource = (exists('src/app') ? 'src/app' : 'app') + '/**/page.{tsx,jsx,ts,js}';
else if (exists('src/pages') || exists('pages')) routeSource = (exists('src/pages') ? 'src/pages' : 'pages') + '/**/*.{tsx,jsx}';
else if (exists('src/routes')) routeSource = 'src/routes/**';
const opsTargets = {};
try { if (fs.readdirSync(TARGET).some((f) => /^fly.*\.toml$/.test(f))) opsTargets.host = 'fly'; } catch { /* ignore */ }
if (exists('wrangler.toml') || exists('wrangler.jsonc') || exists('wrangler.json')) opsTargets.edge = 'cloudflare';
if (exists('vercel.json')) opsTargets.host = opsTargets.host || 'vercel';
let pkg = {}; try { pkg = JSON.parse(read(path.join(TARGET, 'package.json'))); } catch { /* ignore */ }
const deps = Object.assign({}, pkg.dependencies, pkg.devDependencies);
if (deps['@supabase/supabase-js'] || exists('supabase')) opsTargets.db = 'supabase';
if (deps['prisma'] || deps['@prisma/client']) opsTargets.orm = 'prisma';

// 2c. Root-level container/PaaS hosting hints (H5) — additive only, never overrides a more specific host.
if (!opsTargets.host && (exists('docker-compose.yml') || exists('docker-compose.yaml'))) opsTargets.host = 'docker';
if (!opsTargets.host && exists('render.yaml')) opsTargets.host = 'render';
if (!opsTargets.host && exists('Procfile')) opsTargets.host = 'procfile';

// 2d. Monorepo one-level-down probe (H5, dogfood finding) — the root-only checks above find nothing on a
// backend/+frontend/ (or apps/*, services/*, packages/*) layout: routeSource stays the placeholder and
// opsTargets stays {}. Probe exactly one level into these conventional subdirs for the same markers, bounded
// (no arbitrary recursion): fixed names `backend`/`frontend`, plus every immediate child of `apps`/`services`/
// `packages` if those parent dirs exist. A subdir only ever FILLS a gap (routeSource still the placeholder, or
// a specific opsTargets key still unset) — it never overrides a root-level finding.
// The `app`/`src/app` check here additionally requires a page or layout file directly inside, unlike the root
// check above — a bare `backend/app/` is exactly as likely to be a Python package (FastAPI's own `app/`
// convention, as in one dogfood target) as a Next.js app-router dir, so directory existence alone is too
// weak a signal one level down.
function probeSubdirMarkers(dirAbs) {
  const has = (rel) => fs.existsSync(path.join(dirAbs, rel));
  const hasPageOrLayout = (base) => ['tsx', 'jsx', 'ts', 'js'].some((ext) => has(`${base}/page.${ext}`) || has(`${base}/layout.${ext}`));
  const hits = [];
  let foundRoute = null;
  if (has('src/app') && hasPageOrLayout('src/app')) { foundRoute = 'src/app/**/page.{tsx,jsx,ts,js}'; hits.push('routeSource (src/app router)'); }
  else if (has('app') && hasPageOrLayout('app')) { foundRoute = 'app/**/page.{tsx,jsx,ts,js}'; hits.push('routeSource (app router)'); }
  else if (has('src/pages')) { foundRoute = 'src/pages/**/*.{tsx,jsx}'; hits.push('routeSource (src/pages router)'); }
  else if (has('pages')) { foundRoute = 'pages/**/*.{tsx,jsx}'; hits.push('routeSource (pages router)'); }
  else if (has('src/routes')) { foundRoute = 'src/routes/**'; hits.push('routeSource (src/routes)'); }

  const found = { routeSource: foundRoute };
  try { if (fs.readdirSync(dirAbs).some((f) => /^fly.*\.toml$/.test(f))) { found.host = 'fly'; hits.push('opsTargets.host=fly'); } } catch { /* ignore */ }
  if (has('wrangler.toml') || has('wrangler.jsonc') || has('wrangler.json')) { found.edge = 'cloudflare'; hits.push('opsTargets.edge=cloudflare'); }
  if (!found.host && has('vercel.json')) { found.host = 'vercel'; hits.push('opsTargets.host=vercel'); }
  let subPkg = {}; try { subPkg = JSON.parse(fs.readFileSync(path.join(dirAbs, 'package.json'), 'utf8')); } catch { /* ignore */ }
  const subDeps = Object.assign({}, subPkg.dependencies, subPkg.devDependencies);
  if (subDeps['@supabase/supabase-js'] || has('supabase')) { found.db = 'supabase'; hits.push('opsTargets.db=supabase'); }
  if (subDeps['prisma'] || subDeps['@prisma/client']) { found.orm = 'prisma'; hits.push('opsTargets.orm=prisma'); }
  if (has('requirements.txt') || has('pyproject.toml')) { found.runtime = 'python'; hits.push('opsTargets.runtime=python'); }
  if (!found.host && (has('docker-compose.yml') || has('docker-compose.yaml'))) { found.host = 'docker'; hits.push('opsTargets.host=docker'); }
  if (!found.host && has('render.yaml')) { found.host = 'render'; hits.push('opsTargets.host=render'); }
  if (!found.host && has('Procfile')) { found.host = 'procfile'; hits.push('opsTargets.host=procfile'); }
  return { found, hits };
}
function listChildDirs(parentRel) {
  try { return fs.readdirSync(path.join(TARGET, parentRel), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => `${parentRel}/${e.name}`); }
  catch { return []; }
}
const probeDirs = ['backend', 'frontend'].filter(exists).concat(listChildDirs('apps'), listChildDirs('services'), listChildDirs('packages'));
const detectionNotes = [];
for (const rel of probeDirs) {
  const { found, hits } = probeSubdirMarkers(path.join(TARGET, rel));
  if (!hits.length) continue;
  if (!routeSource && found.routeSource) routeSource = `${rel}/${found.routeSource}`;
  for (const key of ['host', 'edge', 'db', 'orm', 'runtime']) if (found[key] && !opsTargets[key]) opsTargets[key] = found[key];
  detectionNotes.push(`${rel}/: ${hits.join(', ')}`);
}

// 2e. MCP server skills (living: frozen SKILL.base.md + a generated living SKILL.md copy) → .claude/skills/mcp-<server>/
// Reference-first: Cloudflare + Vercel use the vendors' own skills (catalog/ATTRIBUTION) — not authored here.
// T2 conditional placement: fly/supabase/security-audit only ship when the target's detected stack actually
// matches — a target that will never use them gets zero files (not just a hidden listing entry), never even
// paying the frozen-base disk cost. runtime/context7/github/graphify stay unconditional (graphify's own
// listing-cost fix is router-mediation via mcp-runtime, not installer-gating — see docs/reference/living-skills.md).
const hasPackageJson = exists('package.json') || probeDirs.some((rel) => fs.existsSync(path.join(TARGET, rel, 'package.json')));
const MCP_GATE = {
  fly: () => opsTargets.host === 'fly',
  supabase: () => opsTargets.db === 'supabase',
  'security-audit': () => hasPackageJson,
};
for (const m of ['fly', 'runtime', 'security-audit', 'supabase', 'context7', 'github', 'graphify']) {
  if (MCP_GATE[m] && !MCP_GATE[m]()) continue; // stack doesn't match: skip entirely; a later re-run after the marker appears places it fresh (place()'s existence-check only skips already-placed files)
  place(`ops/mcp/${m}/SKILL.base.md`, `.claude/skills/mcp-${m}/SKILL.base.md`);
  const liveRel = `.claude/skills/mcp-${m}/SKILL.md`;
  placedPaths.add(liveRel);
  if (!exists(liveRel) || FORCE) { const d = path.join(TARGET, liveRel); ensureDir(path.dirname(d)); writeFile(d, read(path.join(SRC, `ops/mcp/${m}/SKILL.base.md`))); created.push(liveRel); }
}

// 2f. Agents (defensive) → .claude/agents/<file> — same skip/--force semantics as everything else.
// agents/ is being authored in parallel with this installer and may not exist yet in SRC; guard with
// existsSync so an incomplete pack checkout is a no-op here, not a crash.
//
// T-13: CORE vs EXTRAS. 32 agent files split into a CORE set (placed always — the 6 review lenses, the
// 11 engineering/infra advisors, the 2 write-scoped onboarding mappers, and 3 general product/research
// roles whose judgment the loop leans on directly: product-manager, feedback-synthesizer, researcher)
// and an opt-in EXTRAS pack (the 10 commercial-function advisors named below — a different product most
// solo-founder/small-team repos never call). Agents are inert files — no code path admits agents/ at all
// (agents/README.md "Attribution and status") — so this is a placement-SCOPE decision, not a new product
// capability. ADR-002 (a development record) reserves --with-memory as
// the pack's ONLY capability flag and rules out a second one ("What is deliberately NOT done"), fenced by
// counts-fence.test.mjs pinning KNOWN_FLAGS exactly — so EXTRAS is declared, not flagged: it reads the
// SAME surface optional axis 2 already writes, respawnpack.config.json's `extras` array ("accepted
// adoption-interview extras" below — /respawn can record "agents" there the same way it records the
// design-capability opt-in), rather than adding a KNOWN_FLAGS entry. An existing config the installer
// cannot parse is never read as consent: place the core set only, and the summary below says so — the
// same fail-safe direction as an unparseable settings.json/.mcp.json elsewhere in this installer.
const AGENT_EXTRAS = new Set([
  'content-marketer', 'sales-outbound', 'seo-specialist', 'social-media-strategist',
  'email-lifecycle-marketer', 'finance-tracker', 'proposal-writer', 'customer-support',
  'trend-researcher', 'growth-strategist',
]);
let agentsExtrasDeclared = false;
let agentsDeclarationUnreadable = false;
// The project type §4d composes CLAUDE.md's managed block from, read from the SAME parse as the extras
// declaration above rather than opening the founder's config a second time. `undefined` is "no
// declaration" and is the only value that reproduces today's block; see §4d for what each state does.
let declaredProjectType;
if (exists('respawnpack.config.json')) {
  try {
    const declaredCfg = JSON.parse(read(path.join(TARGET, 'respawnpack.config.json')));
    agentsExtrasDeclared = Boolean(declaredCfg && Array.isArray(declaredCfg.extras) && declaredCfg.extras.includes('agents'));
    if (declaredCfg && Object.prototype.hasOwnProperty.call(declaredCfg, 'projectType')) declaredProjectType = declaredCfg.projectType;
  } catch { agentsDeclarationUnreadable = true; }
}
const agentsDir = path.join(SRC, 'agents');
const agentStems = fs.existsSync(agentsDir)
  ? fs.readdirSync(agentsDir).filter((f) => f.endsWith('.md') && f !== 'README.md').map((f) => f.replace(/\.md$/, ''))
  : [];
for (const stem of agentStems) {
  if (!agentsExtrasDeclared && AGENT_EXTRAS.has(stem)) continue; // opt-in pack, not placed by default
  place(`agents/${stem}.md`, `.claude/agents/${stem}.md`);
}

/*
 * ⛔ 2e-bis · THE TARGET'S DECLARED POSTURE, RESOLVED ONCE, HERE — because §2f now needs it (P3-K-14).
 *
 * This used to sit beside the settings merge at §7-PRE-A, which was the only thing that consulted it.
 * It is a pure read of the founder's own `respawnpack.config.json` (through `hooks/_posture.js`, the ONE
 * reader) and nothing between here and §8 writes that file, so hoisting it changes no answer — it just
 * makes the same one resolution available to both surfaces a profile now composes: the kernel files
 * below and the hook registrations at §7. Resolving twice would let one install answer from two reads of
 * a file that can change between them.
 */
const targetPosture = posture.resolve(TARGET);

/*
 * ⛔ 2e-ter · AND THE OWNERSHIP RECORD IS READ HERE FOR THE SAME REASON. §2f-bis retires a kernel file
 * this installer placed under a previous profile, and a retirement it cannot PROVE is one it must not
 * make — the discipline §7a-bis already applies to a settings entry. One read, two consumers; the
 * three-way reading of what this record means still lives at §7-PRE, where the hook half uses it.
 */
const receiptPath = path.join(TARGET, '.respawnpack', 'install-receipt.json');
let priorReceipt = null;
try { priorReceipt = JSON.parse(read(receiptPath)); } catch { priorReceipt = null; } // absent, torn or unparseable — all "no memory"

// 2f. State kernel → .claude/respawnpack/ — the executable behind /savepoint's verification. It is NOT
// a skill: skills are prose procedures a model reads, and the whole point of this layer is that the
// load-bearing checks stop being prose. See kernel/README.md.
// `lib/modhealth.js` is load-bearing for `doctor`: it is what separates "the file is there" from "the
// module loads", and state.js/removals.js/respawnpack.js all require it before they touch the shared
// manifest. Omitting it from this list would break every kernel verb on MODULE_NOT_FOUND.
// ⛔ THE LIST LIVES IN install/_sources.js, NOT HERE. It was typed out in three places — this loop,
// uninstall.js's KERNEL_FILES, and nothing at all in upgrade.js's preflight — and the gap in the third
// was a reproduced destruction path: a source missing one of these files passed preflight, phase 1
// stripped the target, phase 2 died on ENOENT, and the install went from 12 kernel libs to 3.
/*
 * ⛔ AND THE PROFILE NOW DECIDES WHICH OF THEM THIS TARGET GETS (P3-K-14). `install/_settings-manifest.js`
 * projects the same ADR-003 table onto this list that it projects onto the hook registrations: a file is
 * withheld only where the row governing it reads `n.a.` for the declared profile, which today is
 * `lib/reconcile.js` under `light` and nothing else. THE SOURCE LIST IS UNTOUCHED — `KERNEL_FILES` is
 * still what the preflight demands of the PACK, so a torn source is still caught before phase 1 strips
 * anything; what narrows is only what this target receives.
 *
 * ⛔ THE KERNEL TOLERATES THE GAP BEFORE THE INSTALLER MAKES ONE. `kernel/lib/state.js` and
 * `kernel/lib/applicability.js` probe `reconcile.js` through `modhealth` instead of requiring it, so an
 * absent subsystem is a NOT_APPLICABLE row under the profile that declined it and a BROKEN row under one
 * that did not — never the MODULE_NOT_FOUND stack that a hard require would have raised out of the
 * compiler every verb loads (anti-drift item 17).
 */
const kernelPlacement = manifest.composeKernelFiles(KERNEL_FILES, targetPosture.profile);
for (const rel of kernelPlacement.files) {
  place(rel, path.join('.claude', 'respawnpack', ...rel.replace(/^kernel\//, '').split('/')));
}

/*
 * 2f-bis. RETIREMENT — the only place this installer DELETES a kernel file, and every condition on it is
 * there to keep that deletion provable rather than merely intended. The sibling of §7a-bis, and the same
 * three conjunctions, because a profile flip must be as reversible for the kernel as it is for the hooks:
 *
 *   • the file is one THIS PROFILE OMITTED — the manifest's own omission list, never "absent from the
 *     composed set" in general, so a kernel file from an older pack version that today's KERNEL_FILES no
 *     longer names is left completely alone. That legacy shape is the uninstaller's business.
 *   • IT IS PROVABLY OURS. There is memory at all (a parseable receipt: a pre-receipt target retires
 *     nothing), AND the bytes on disk are the bytes this pack would have placed. Content identity is the
 *     stronger half and is the reason a founder who hand-edited the file keeps it: a deletion this
 *     installer cannot prove is a deletion it does not make, exactly as at §7a-bis.
 *   • it is RECORDED, in `kernelRetired`, so the flip back is visible and so a founder reading the
 *     receipt can see that the pack removed it rather than that it went missing. Placement restores it
 *     the moment a profile composes it again, and it leaves the list on that run.
 */
const kernelRetiredNow = [];   // removed by THIS run because the composed set no longer names them
const kernelKeptEdited = [];   // omitted by the profile, present, and NOT byte-identical to our source
const kernelPlacedRel = new Set(kernelPlacement.files.map((rel) => `.claude/respawnpack/${rel.replace(/^kernel\//, '')}`));
if (priorReceipt) {
  for (const { file, row } of kernelPlacement.omitted) {
    const rel = `.claude/respawnpack/${file.replace(/^kernel\//, '')}`;
    const abs = path.join(TARGET, ...rel.split('/'));
    if (!fs.existsSync(abs)) continue;
    let ours = false;
    try { ours = read(abs).replace(/\r\n/g, '\n') === read(path.join(SRC, file)).replace(/\r\n/g, '\n'); } catch { ours = false; }
    if (!ours) { kernelKeptEdited.push(rel); continue; }
    if (!DRY_RUN) fs.unlinkSync(abs);
    kernelRetiredNow.push({ rel, row });
  }
}

/*
 * 2g. The host-neutral rollover core → .claude/core/.
 *
 * ⛔ IT WAS NEVER PLACED AT ALL, AND EVERY INSTALL PAID FOR IT. The the 2026-08-07 field run (§1)
 * recorded `savepoint --verify` exiting 2 on every run of an eight-hour session. Two of its seven
 * checks — `state-writeback` and `memory-capture` — reported "core/ (the host-neutral rollover core)
 * could not be loaded". They were right, and it was not a broken module: this list did not exist, so
 * `.claude/core/` was never written, so `require('../core/index.js')` was ENOENT in EVERY install the
 * pack has ever produced. Both consumers soft-require it and degrade to a named CANNOT_DETERMINE
 * (kernel/respawnpack.js's `core` is `null`; hooks/context-monitor.js's local try/catch does the same),
 * which is the correct posture for a module that MIGHT be absent — and is precisely why nobody noticed
 * that it was ALWAYS absent. A degradation that never resolves is indistinguishable from a design.
 *
 * ⭐ WHY ONE DIRECTORY SERVES BOTH CONSUMERS. `hooks/` and `kernel/` each reach it as `../core/`, and
 * once installed they are siblings under `.claude/`, so both resolve to the same `.claude/core/`:
 *     pack:      kernel/respawnpack.js        → ../core/index.js   ·  hooks/context-monitor.js → ../core/index.js
 *     installed: .claude/respawnpack/…        → .claude/core/…     ·  .claude/hooks/…          → .claude/core/…
 * The same relative-path coincidence `_manifest.js` documents for the kernel/hooks pair, one level up.
 *
 * ⛔ THE LIST IS EXHAUSTIVE BECAUSE core/ IS SELF-CONTAINED. Nothing under core/ requires from hooks/ or
 * kernel/ (core/index.js states that arrow explicitly), so these files plus node builtins are the whole
 * dependency closure — no probing, no optional members. A file added under core/ and not added here
 * loads in the pack repo and fails only once installed, which is the exact shape of the defect above;
 * install.test.mjs therefore asserts the placed core LOADS, not merely that the files exist.
 * The two *.schema.json files are documentation of the record shapes, not runtime inputs, and are
 * deliberately not placed — no core module reads them.
 */
// Same single declaration as the kernel list above — see install/_sources.js.
for (const rel of CORE_FILES) {
  place(rel, path.join('.claude', 'core', ...rel.replace(/^core\//, '').split('/')));
}

// 3. Hooks → .claude/hooks/
// The nine `_`-prefixed files are NOT hooks — they are the shared modules the hooks `require`:
// `_contracts.js`, `_boot.js`, `_runtime.js`, `_cmd.js`, `_manifest.js`, `_artifact.js`, `_shell.js`,
// `_git-effect.js`, `_index-lease.js`. ⛔ THREE ROLES, AND THEY ARE NOT THE SAME ROLE. `_boot.js` alone
// is the IRREDUCIBLE HOOK BOOTSTRAP: every hook with shared dependencies enters through it, so a module
// that cannot load OR that violates its contract degrades the hook to its conservative posture instead
// of quietly selecting a permissive branch — and nothing catches a defect in `_boot.js` itself, because
// it IS the catcher. `_contracts.js` is a PROTECTED, LOAD-BEARING CONTRACT SOURCE: the ONE typed
// declaration both the hooks and `doctor` validate against (the kernel reads it cross-tree; the hooks
// cannot read the kernel), load-bearing because without it nothing can be checked, but PROTECTED
// because `_boot.need()` catches its failure. This comment used to call the pair "the irreducible
// bootstrap boundary" and that was measurably false — see hooks/_contracts.js. The remaining seven are
// PROTECTED DEPENDENCIES. All nine are installed FIRST, can never be omitted, are placed in the same
// step and carry the same uninstall inventory entry. (The counts fence excludes `_`-prefixed
// files, so shipping them does not inflate the documented "fifteen governance hooks"; a separate
// inventory fence proves this list, the uninstaller's and the docs' manual copy command agree with the
// modules the hooks actually require.)
// `_manifest.js` is additionally required by the state kernel at ../../hooks/_manifest.js — the one
// relative path that resolves identically in this repo and in an installed target.
// ⛔ `_posture.js` IS A TENTH `_`-PREFIXED FILE AND IT IS NOT ONE OF THE NINE ABOVE. It is now required
// by index-guard.js, so the require-graph fence in counts-fence.test.mjs does see it — but the reason it
// was placed here BEFORE that happened still holds for its successor: `kernel/respawnpack.js` reaches it
// across `../hooks/_posture.js` for doctor's posture row, so a target that got the new kernel without
// this file would be a target whose kernel probes a reader that was never placed.
// ⛔ `_exceptions.js` IS THE ELEVENTH, AND IT WAS IN EXACTLY THAT STATE FOR ONE TASK (P1-E-1a): no hook
// required it until the guards that consume the exception grammar landed (E-1b to E-1d), so the
// require-graph fence saw nothing, and only `kernel/respawnpack.js` reached it across
// `../hooks/_exceptions.js` for doctor's `exceptions` row. It ships with the kernel that reads it, in the
// same step, and leaves by the same door in uninstall.js's HOOK_FILES; counts-fence.test.mjs pins that
// pairing directly for every module the kernel reaches, so the placement cannot be added in one place
// and forgotten in the other.
for (const h of ['_contracts.js', '_boot.js', '_runtime.js', '_cmd.js', '_manifest.js', '_artifact.js', '_index-lease.js', '_posture.js', '_exceptions.js', '_shell.js', '_git-effect.js', 'lockdown.js', 'secret-scan.js', 'stop-savepoint.js', 'push-guard.js', 'spawn-guard.js', 'precompact-ledger-nudge.js', 'worktree-guard.js', 'index-guard.js', 'injection-scan.js', 'context-monitor.js', 'session-routing-nudge.js', 'websearch-freshness.js', 'shell-guard.js', 'mcp-reaper.js', 'docker-session-tag.js', 'pre-push']) place(`hooks/${h}`, `.claude/hooks/${h}`);

/*
 * 3-bis. `hooks/dispatch.js` IS PLACED ONLY WHERE THE PROFILE WIRES IT (P4-T-15b), AND THAT IS NOT
 * TIDINESS.
 *
 * ⛔ A HOOK FILE ON DISK AND ABSENT FROM settings.json IS A DOCTOR ROW, NOT A SPARE PART. Measured
 * on a real install before this gate existed: `doctor` reported `hook:dispatch.js  SILENTLY INACTIVE -
 * on disk and valid but NOT wired in .claude/settings.json - it will never run`, and the whole report
 * went from PASS/exit 0 to CANNOT_DETERMINE/exit 2. That row is CORRECT and it is one of the more useful
 * things doctor says, so the fix is to stop placing a file the profile has no wiring for, not to teach
 * doctor an exception. `strict` keeps the multi-hook wiring (anti-drift item 35), so `strict` has no use
 * for the dispatcher and does not receive it.
 *
 * ⭐ THE SIBLING OF 2f-bis, AND THE SAME THREE CONJUNCTIONS. A profile that stops wiring the
 * dispatcher deletes the file only when there is memory at all (a parseable receipt) and the bytes on
 * disk are the bytes this pack would have placed. A founder who edited it keeps it and is told. The
 * receipt's `settingsWiring` is the record: a target whose receipt says `per-hook` is a target with no
 * dispatcher, and the next install at a dispatching profile places it again.
 */
const dispatchRel = path.join('.claude', 'hooks', 'dispatch.js');
const dispatchAbs = path.join(TARGET, dispatchRel);
let dispatchAction = null;
if (manifest.usesDispatcher(targetPosture.profile)) {
  place('hooks/dispatch.js', dispatchRel);
} else if (priorReceipt && fs.existsSync(dispatchAbs)) {
  let ours = false;
  try { ours = read(dispatchAbs).replace(/\r\n/g, '\n') === read(path.join(SRC, 'hooks', 'dispatch.js')).replace(/\r\n/g, '\n'); } catch { ours = false; }
  if (ours) { if (!DRY_RUN) fs.unlinkSync(dispatchAbs); dispatchAction = 'retired'; }
  else dispatchAction = 'kept (edited)';
}

/*
 * 3b. Host adapters → .claude/adapters/<host>/. The v0.3 multi-host rollover core ships adapters per
 * host; the installer's job here is the piece Phase 8 item 6 named as not-yet-wired. The first wave
 * was the ONE adapter with no new registration surface: the Claude Code interactive profile's
 * declaration + activation-canary modules. Its HOOKS are already placed in §3 above and wired into
 * settings.json; those two files add nothing that runs on its own — they make that installation's
 * ACTIVATION checkable (doctor's host-adapters row calls them) instead of trusting file-presence as
 * evidence, which core/policy/capabilities.js exists to forbid.
 *
 * P5-CT-4 (the rework task list, decision 2.7) adds the next two, beside it, still by default: sdk-supervisor
 * (the managed-profile process surface — cli.js/stream.js/measure.js/supervisor.js/canary.js/
 * capabilities.js) and statusline (statusline.js, the opt-in context-usage tee). Codex/Pi stay
 * hand-installed and opt-in-later because they widen scope (feature flags, trust prompts); neither
 * new adapter here does. task-runner/ is deliberately NOT placed — out of scope for this wave by the
 * same decision (adapters/claude-code/README.md says so explicitly rather than leaving it implied).
 *
 * ⛔ PLACED IS NOT ACTIVATED, AND STATUSLINE IS WHERE THAT MATTERS MOST. sdk-supervisor earns nothing
 * beyond doctor's INSTALLED/LOADS row from being placed — its own canary.js is the only thing that can
 * promote it, and doctor never runs that unattended (real tokens, real wall time). statusline is
 * stronger than unearned: `.claude/settings.json`'s `statusLine` key is a SINGLE slot, and this
 * installer never writes or overwrites it — see §7 below. A founder who wants the tee wires it by
 * hand (adapters/claude-code/statusline/README.md); doctor's row reports which of "placed" and
 * "wired" is true without conflating them.
 *
 * ⛔ THE DEPTH UNDER adapters/claude-code/ IS LOAD-BEARING, NOT COSMETIC. Every one of these files
 * reaches core/ as `path.join(__dirname, '..', '..', '..', 'core', ...)` — three parents up from
 * <adapter-name>/<file>.js. Placing sdk-supervisor and statusline at the SAME depth as interactive
 * (.claude/adapters/claude-code/<name>/<file>.js) is what makes that relative path resolve to
 * .claude/core/ once installed, exactly as it does in this pack checkout — no adapter source change
 * needed, only placing it where its own already-written relative path expects to find itself.
 *
 * ⛔ THESE ARE READ UNGUARDED (place → read), so they belong in install/_sources.js SOURCE_TREES —
 * a torn checkout missing one of these dirs must fail upgrade.js's preflight before phase 1 strips
 * anything, not crash phase 2 after. Tree-level granularity like skills/, not per-file like
 * kernel/core: a missing adapter file is an unproven capability, never a bricked kernel. The per-FILE
 * list below is install/_sources.js's ADAPTER_FILES — ONE declaration this loop, uninstall.js's
 * receipt-contained removal, and doctor's LOADS checks all read, mirroring how KERNEL_FILES/CORE_FILES
 * already avoid a second hand-typed copy (see that module's own header for the failure this ends).
 *
 * ⛔ AND THE LOADS DISCIPLINE MIRRORS §2g's CORE BUG, DELIBERATELY. §2g's comment records that
 * .claude/core/ was once never placed at all, and both consumers soft-degraded to CANNOT_DETERMINE
 * silently enough that nobody noticed for as long as it shipped. A placed-but-unloadable adapter is
 * the identical failure shape one directory over, so install.test.mjs asserts the installed
 * sdk-supervisor LOADS through its installed path — not merely that its files exist — the same way
 * §2g's own test does for core/.
 */
for (const rel of ADAPTER_FILES) place(rel, path.join('.claude', ...rel.split('/')));

/*
 * 3c. The placement receipt — THE record of what this install laid under .claude/adapters/, so
 * uninstall.js replays exactly this set rather than a second hand-kept list that agrees today and
 * drifts tomorrow. This is the dpkg/rpm/Homebrew INSTALL_RECEIPT model install/_sources.js already
 * cites in its header, applied where the plan (P-002) recommended it first: adapter placement, whose
 * opt-in `--with-*` variability is exactly what a static inventory handles worst. It is DERIVED from
 * placedPaths — the set place() actually populated — so it cannot disagree with what was placed, and
 * install/uninstall.test.mjs's round-trip sweep is the fence proving uninstall consumes it completely
 * (an adapter file the receipt misses survives the uninstall and fails that exact-set comparison).
 * It records placements only; upgrade.js's preflight remains the guard that the SOURCE can restore
 * them (P-001), so the two invariants stay separate. The receipt lives under .respawnpack/ (session
 * state an upgrade preserves) and never lists itself.
 *
 * ⛔ AND IT NOW CARRIES A SECOND KIND OF PLACEMENT, WHICH IS WHY THE WRITE MOVED DOWN TO §7d. The
 * settings.json merge in §7 is the OTHER thing this installer places into a file it does not own, and
 * until this version it placed with no memory at all (BUG-6): the merge is add-only, so a founder who
 * deleted our `index-guard` entry got it back on the next run. The receipt is the vehicle the plan
 * (P-002) named for exactly this class, so the hook tuples join the adapter paths in ONE record and
 * the write happens once, after both are known. The list is computed here; the file is written below.
 */
const adapterReceipt = [...placedPaths].filter((p) => p.startsWith('.claude/adapters/')).sort();

// 4. Workflows → .claude/workflows/
for (const w of fs.readdirSync(path.join(SRC, 'workflows')).filter((f) => f.endsWith('.workflow.js'))) place(`workflows/${w}`, `.claude/workflows/${w}`);

// 4b. CI templates → .github/workflows/ (security CI: gitleaks secret scan + dependency-CVE audit, on push + weekly)
place('templates/ci/security.yml', '.github/workflows/respawnpack-security.yml');
// Calls `respawnpack gate` exactly once and takes its exit code as the job's verdict: PASS / FAIL /
// NOT_CONFIGURED / NOT_APPLICABLE. It used to run four steps that each SKIPPED when the target lacked
// the script, so a non-Node repo reported green having checked nothing — a skipped shell step exits 0.
place('templates/ci/quality-gate.yml', '.github/workflows/respawnpack-quality.yml');
place('templates/CODEOWNERS', '.github/CODEOWNERS'); // sensitive-path review gates (fill in owners)

// 4c. Reference-first skill catalog + credit ledger → target root (credited, never copies third-party skills)
// catalog/README.md is now the single further-reading page (by-domain/ retired); nothing else to place here.
place('ATTRIBUTION.md', 'ATTRIBUTION.md');
// The license of the pack's OWN files, placed inside .claude/ next to the code it describes.
// ⛔ WHY NOT A `LICENSE` AT THE TARGET ROOT, WHICH IS THE OBVIOUS PLACE. Two reasons, and the second
// is the one that actually matters: a root LICENSE would collide with the founder's own, and it
// would read as a claim that THEIR project is AGPL. It is not. What the pack installs is ~114 of its
// own files under .claude/, plus a docs/ spine that is empty structure the founder writes into —
// their content, their license. Scoping the notice to the directory holding the pack's code is what
// keeps those two apart. .claude/ is also the right directory for a second reason: the installer
// adds `.respawnpack/` to the target's .gitignore, so a notice placed there would be untracked and
// would vanish from exactly the published repository that needed to carry it.
place('templates/LICENSE.respawnpack', '.claude/LICENSE.respawnpack');
place('catalog/README.md', 'catalog/README.md');

/*
 * library/ — vendored compliance requirement texts (471 KB / 24 files). Gated on the SAME
 * compliance-scope decision as docs/compliance/ in §1b above (placeComplianceMaterial), never on
 * posture. GUARDED (existsSync), the same pattern §2f's agents/ and §5c's --with-memory engine copy
 * already use — and for the same reason it is deliberately ABSENT from install/_sources.js's
 * SOURCE_TREES: "a preflight must never be stricter than the installer it fronts" (that module's own
 * agents/ precedent). A torn/missing library/compliance/ in SRC degrades to a warning instead of
 * crashing an install that has already placed everything else.
 */
if (placeComplianceMaterial) {
  const libraryComplianceDir = path.join(SRC, 'library', 'compliance');
  if (!fs.existsSync(libraryComplianceDir)) {
    console.warn('⚠️  compliance scope is declared, but library/compliance/ is not present in this pack checkout — nothing was installed from it. Fix the pack checkout and re-run.');
  } else {
    place('library/README.md', 'library/README.md');
    place('library/compliance/README.md', 'library/compliance/README.md');
    place('library/compliance/references/SOURCES.md', 'library/compliance/references/SOURCES.md');
    for (const f of fs.readdirSync(path.join(SRC, 'library', 'compliance', 'requirements'))) place(`library/compliance/requirements/${f}`, `library/compliance/requirements/${f}`); // per-requirement compliance checklists (PDFs stay in the pack)
  }
}

// 4d. Behavioral baseline → CLAUDE.md (create, append, or refresh the managed marker block; never touches text outside the markers)
// Both markers are line-anchored and the opener is pinned to its versioned form ("BEHAVIOR v"), so a prose
// mention of the marker can't become a match start; the replacer-fn form keeps any "$" in the template literal.
// VERSION-AWARE refresh: the opener records the pack version that wrote the block (the template's
// <PACK_VERSION> slot). A complete block whose recorded version differs from this pack's VERSION is
// replaced in place on a PLAIN install — that is how upgrade.js moves the behavioral baseline forward
// (its phase 1 keeps CLAUDE.md, so a --force-only refresh here would never fire through an upgrade).
// Same-version blocks stay skipped (idempotent); --force still refreshes regardless of version; an
// unparseable version token reads as stale. Text outside the markers is byte-preserved in every case.
const PACK_VERSION = read(path.join(SRC, 'VERSION')).trim();

/*
 * ⛔ 4d-i. THE DIGEST SECTIONS A DECLARED PROJECT TYPE CARRIES (P6-5-7,
 * the posture-by-project-type design note, a development record).
 *
 * templates/CLAUDE.md wraps each of its six digest sections in a line-anchored
 * `<!-- RESPAWNPACK:SECTION <id> fixed|conditional -->` … `<!-- /RESPAWNPACK:SECTION -->` pair. The
 * marker LINES are removed in every composition, so what a target receives never contains them, and
 * a target that declares no project type receives the template with nothing but those lines removed —
 * which is byte-for-byte today's block (anti-drift item 35's sibling claim for CLAUDE.md, asserted
 * against a pinned capture in install/install.test.mjs).
 *
 * ⭐ A VARIANT ONLY EVER SUBTRACTS, AND ONLY WHAT PROVABLY CANNOT APPLY. Five of the six sections are
 * marked `fixed` — the boot contract, the interaction/contract vocabulary, the behavioural baseline,
 * the SAFETY-CHECK baseline and the licensing notice — and DROPS below cannot name one: composing a
 * type whose drop list reaches a fixed section throws rather than writing a thinner block, so "a
 * variant never drops a safety-check rule" is a property of the code and not a promise in a document.
 * Today exactly one section is `conditional`: the performance line, which a repository with no request
 * path and no growth surface cannot apply. `greenfield-app` and `mature-product` therefore drop
 * nothing and compose the full digest, which is the honest answer for them rather than a gap.
 *
 * ⛔ AND A TYPE THIS INSTALLER DOES NOT KNOW IS REFUSED, NOT GUESSED. An unrecognised `projectType`
 * writes NOTHING for the block (a fresh target gets no CLAUDE.md, an existing one keeps its bytes) and
 * says so in one line — the same direction as the unparseable settings.json and the unreadable extras
 * declaration elsewhere here: the installer never infers what a founder meant. An unparseable config
 * is a THIRD state and is not a refusal: nothing was declared that anyone could read, so the block is
 * composed exactly as it is for a target that declared nothing.
 */
const PROJECT_TYPE_DROPS = {
  'docs-only': ['performance'],       // no request path, no growth surface, no code at all
  'ops-infra': ['performance'],       // config and manifests: no request path and nothing users read from
  'greenfield-app': [],               // every section is live from day one; nothing is provably moot yet
  'mature-product': [],               // real traffic and real users: every section applies
};
const SECTION_OPEN_RE = /^<!-- RESPAWNPACK:SECTION (\S+) (fixed|conditional) -->\r?\n?$/;
const SECTION_CLOSE_RE = /^<!-- \/RESPAWNPACK:SECTION -->\r?\n?$/;
function composeClaudeBlock(text, drops) {
  const seen = new Set();
  const out = [];
  let dropping = false;
  for (const line of text.split(/(?<=\n)/)) { // keeps each line's own terminator, so nothing is re-encoded
    const open = SECTION_OPEN_RE.exec(line);
    if (open) {
      const [, id, kind] = open;
      seen.add(id);
      if (kind === 'fixed' && drops.includes(id)) throw new Error(`CLAUDE.md section "${id}" is fixed and cannot be dropped by a project type`);
      dropping = drops.includes(id);
      continue;
    }
    if (SECTION_CLOSE_RE.test(line)) { dropping = false; continue; }
    if (!dropping) out.push(line);
  }
  const unknown = drops.filter((id) => !seen.has(id));
  if (unknown.length) throw new Error(`CLAUDE.md has no section(s) named ${unknown.join(', ')} — a drop list that names nothing removes nothing`);
  return out.join('');
}

const claudeTemplate = read(path.join(SRC, 'templates', 'CLAUDE.md')).replace('<PACK_VERSION>', () => PACK_VERSION);
const projectTypeKnown = declaredProjectType === undefined || Object.prototype.hasOwnProperty.call(PROJECT_TYPE_DROPS, declaredProjectType);
const claudeBlock = projectTypeKnown ? composeClaudeBlock(claudeTemplate, PROJECT_TYPE_DROPS[declaredProjectType] || []) : null;
const claudePath = path.join(TARGET, 'CLAUDE.md');
const BLOCK_RE = /^<!-- RESPAWNPACK:BEHAVIOR v[\s\S]*?^<!-- \/RESPAWNPACK:BEHAVIOR -->\r?\n?/m;
const BLOCK_VERSION_RE = /^<!-- RESPAWNPACK:BEHAVIOR v(\S+)/m;
if (!projectTypeKnown) {
  console.warn(`⚠️  respawnpack.config.json declares projectType ${JSON.stringify(declaredProjectType)}, which is not one of ${Object.keys(PROJECT_TYPE_DROPS).join(', ')} — CLAUDE.md's managed block was NOT written. An unknown project type is refused rather than guessed; fix the value or remove the key and re-run.`);
  skipped.push(`CLAUDE.md (unknown projectType ${JSON.stringify(declaredProjectType)} — block not written)`);
} else {
  placedPaths.add('CLAUDE.md');
  const variant = declaredProjectType === undefined ? '' : ` (${declaredProjectType} variant)`;
  if (!fs.existsSync(claudePath)) { writeFile(claudePath, claudeBlock); created.push(`CLAUDE.md${variant}`); }
  else {
    const cur = read(claudePath);
    if (BLOCK_RE.test(cur)) {
      const recorded = (cur.match(BLOCK_VERSION_RE) || [])[1];
      /*
       * A DECLARED type refreshes a same-version block when the composition no longer matches what is
       * on disk — otherwise declaring a project type on an already-installed target would do nothing
       * until the next pack version. Narrowly conditioned on a declaration ON PURPOSE: with no
       * projectType key this branch is bit-for-bit the version-gated refresh it has always been, so a
       * target that declares nothing still sees exactly today's write decisions.
       */
      const recomposed = declaredProjectType !== undefined && (cur.match(BLOCK_RE) || [])[0] !== claudeBlock;
      if (FORCE || recorded !== PACK_VERSION || recomposed) {
        writeFile(claudePath, cur.replace(BLOCK_RE, () => claudeBlock));
        if (recorded !== PACK_VERSION) created.push(`CLAUDE.md (block refreshed v${recorded || '?'} → v${PACK_VERSION})${variant}`);
        else created.push(recomposed && !FORCE ? `CLAUDE.md (block recomposed for the ${declaredProjectType} variant)` : `CLAUDE.md (block refreshed)${variant}`);
      } else skipped.push('CLAUDE.md (block present)');
    } else if (cur.includes('<!-- RESPAWNPACK:BEHAVIOR')) {
      // Opening marker without a complete block: appending would nest markers, replacing could eat user text.
      skipped.push('CLAUDE.md (marker fragment but no complete block — delete the fragment and re-run)');
    } else { writeFile(claudePath, cur.replace(/\s*$/, '\n\n') + claudeBlock); created.push(`CLAUDE.md (block appended)${variant}`); }
  }
}

// 5. Memory conventions → docs/reference/memory/
for (const m of ['README.md', 'knowledge-graph.md', 'learnings.template.md']) place(`memory/${m}`, `docs/reference/memory/${m}`);

// 5a. Case-insensitive-FS guard (B2, dogfood finding) — a target that already has a same-name-different-case
// sibling of `memory` (e.g. a dogfood target's `Memory/`) will have mkdir silently resolve INTO that existing dir on
// Windows/macOS's default case-insensitive filesystems (the OS folds the two names together; there's no way
// to force them apart from here). We can't fix the collision, only surface it — print a clear warning so it's
// not a silent merge, then continue. Intentionally low severity: a warning, not a failure.
function findCaseVariantDir(root, name) {
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return null; }
  const hit = entries.find((e) => e.isDirectory() && e.name !== name && e.name.toLowerCase() === name.toLowerCase());
  return hit ? hit.name : null;
}
const memoryCaseVariant = findCaseVariantDir(TARGET, 'memory');
if (memoryCaseVariant) {
  console.warn(`⚠️  target already has "${memoryCaseVariant}/" — a case-variant of "memory/". On a case-insensitive filesystem these merge silently; memory/graph/ will land inside the existing "${memoryCaseVariant}/" instead of a separate "memory/".`);
}

// 5b. memory/graph/ floor — the file-backend grep path (docs/reference/memory/knowledge-graph.md) assumes
// this directory exists even before anything has been written to it. Create it idempotently with a .gitkeep
// so a fresh install always has somewhere to grep, instead of failing on a missing directory.
{
  const graphDir = path.join(TARGET, 'memory', 'graph');
  const gitkeep = path.join(graphDir, '.gitkeep');
  placedPaths.add('memory/graph/.gitkeep');
  if (!fs.existsSync(gitkeep)) { ensureDir(graphDir); writeFile(gitkeep, ''); created.push('memory/graph/.gitkeep'); }
  else skipped.push('memory/graph/.gitkeep');
}

/*
 * 5c. --with-memory — the ONE explicit opt-in for the semantic/graph memory engine (owner decision OD-2).
 *
 * ⛔ WHY THIS EXISTS AND WHY IT IS OPT-IN. The README told people to run
 * `claude mcp add respawn-memory -- rmem mcp`, and `rmem` is the bin of a PRIVATE, unpublished package
 * that no installer ever placed or linked. The documented activation path could not resolve in any
 * target (OVERCLAIMS #4). The fix is not to publish a package and it is not to mutate PATH:
 *   • file-backed memory (memory/graph + grep) stays the ZERO-SETUP DEFAULT — no flag, no npm, no MCP,
 *     no external service. A default install still requires none of those after this change;
 *   • `--with-memory` copies the engine INTO the target under .claude/respawnpack/memory/engine/;
 *   • registration is PROJECT-LOCAL (.mcp.json) and names an ABSOLUTE Node entry point the installer
 *     resolved here, so nothing depends on a global `rmem` or on what happens to be on PATH later;
 *   • dependencies are installed with npm if npm is reachable, and if it is not, the install says so in
 *     one actionable sentence instead of leaving a directory that looks finished and answers nothing.
 * `respawnpack doctor` then proves it by completing a real MCP handshake and a real write/retrieve
 * round trip — because "the files are there" is exactly the check that missed this for months.
 */
const WITH_MEMORY = process.argv.includes('--with-memory');
const MEMORY_DEST_REL = path.join('.claude', 'respawnpack', 'memory', 'engine');
if (WITH_MEMORY) {
  const srcEngine = path.join(SRC, 'memory', 'engine');
  const destEngine = path.join(TARGET, MEMORY_DEST_REL);
  // node_modules and test/ are deliberately NOT copied: the first is restored by npm from the lockfile
  // (copying it would vendor another machine's binaries), the second is the pack's own suite.
  const SKIP = new Set(['node_modules', 'test', '.index']);
  const copyTree = (from, to, relBase) => {
    let entries = [];
    try { entries = fs.readdirSync(from, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (SKIP.has(e.name)) continue;
      const rel = relBase ? `${relBase}/${e.name}` : e.name;
      if (e.isDirectory()) { ensureDir(path.join(to, e.name)); copyTree(path.join(from, e.name), path.join(to, e.name), rel); continue; }
      if (!e.isFile()) continue;
      const destRel = `${MEMORY_DEST_REL.replace(/\\/g, '/')}/${rel}`;
      placedPaths.add(destRel);
      const d = path.join(to, e.name);
      if (fs.existsSync(d) && !FORCE) { skipped.push(destRel); continue; }
      ensureDir(path.dirname(d));
      writeFile(d, read(path.join(from, e.name)));
      created.push(destRel);
    }
  };
  if (!fs.existsSync(srcEngine)) {
    console.warn('⚠️  --with-memory: memory/engine/ is not present in this pack checkout — nothing was installed.');
  } else {
    ensureDir(destEngine);
    copyTree(srcEngine, destEngine, '');

    const entryAbs = path.join(destEngine, 'src', 'cli.mjs');
    const nodeAbs = process.execPath; // ⭐ the installer-resolved absolute Node, recorded verbatim

    // Dependencies. An honest, actionable outcome on failure — never a directory that looks finished.
    let deps = 'skipped (dry run)';
    if (!DRY_RUN) {
      const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';
      let r;
      try { r = execFileSync(npmBin, ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: destEngine, stdio: 'pipe', encoding: 'utf8', shell: process.platform === 'win32' }); deps = 'installed'; }
      catch (e) {
        deps = 'FAILED';
        console.warn(
          `⚠️  --with-memory: could not install the engine's dependencies (${(e.code || e.status || e.message)}).\n` +
          `    The engine is copied to ${MEMORY_DEST_REL} but will NOT answer until they are installed.\n` +
          `    Fix: cd "${destEngine}" && npm install --omit=dev\n` +
          '    Then confirm with: node .claude/respawnpack/respawnpack.js doctor',
        );
      }
      void r;
    }

    // PROJECT-LOCAL MCP registration, merged — never clobbering another server the project registered.
    const mcpPath = path.join(TARGET, '.mcp.json');
    placedPaths.add('.mcp.json');
    let mcp = {};
    if (fs.existsSync(mcpPath)) {
      try { mcp = JSON.parse(read(mcpPath)); }
      catch {
        mcp = null;
        console.warn('⚠️  --with-memory: .mcp.json exists but does not parse — left byte-identical, and respawn-memory was NOT registered. Fix the JSON and re-run.');
      }
    }
    if (mcp) {
      mcp.mcpServers = mcp.mcpServers || {};
      const already = Boolean(mcp.mcpServers['respawn-memory']);
      mcp.mcpServers['respawn-memory'] = { command: nodeAbs, args: [entryAbs, 'mcp'] };
      writeFile(mcpPath, `${JSON.stringify(mcp, null, 2)}\n`);
      (already ? skipped : created).push(`.mcp.json (respawn-memory ${already ? 're-pointed' : 'registered'})`);
    }

    // Record what was resolved, so doctor probes the same entry point a client would use.
    const cfgPath = path.join(TARGET, 'respawnpack.config.json');
    const cfg = fs.existsSync(cfgPath) ? (() => { try { return JSON.parse(read(cfgPath)); } catch { return null; } })() : {};
    if (cfg) {
      cfg.memory = { ...(cfg.memory || {}), engine: { entry: entryAbs, node: nodeAbs, installedAt: new Date().toISOString(), dependencies: deps } };
      writeFile(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`);
    }
    console.log(`  memory engine: ${MEMORY_DEST_REL} · node ${nodeAbs} · deps ${deps} · registered project-locally in .mcp.json`);
  }
}

// 7. Merge hooks + permissions into .claude/settings.json (additive; never clobber).
// PARSE-FAILURE GUARD: an EXISTING settings.json that doesn't parse is founder truth in an unknown
// state — treating it as absent would re-serialize a fresh object over whatever the broken JSON held
// (the uninstaller already refuses to touch that file for the same reason). Distinguish the two
// failure modes: no file at all → fresh merge as always; unparseable existing file → skip the ENTIRE
// settings merge (hooks, permissions, skill budget, the write), leave the file byte-identical, warn
// loudly, and let the rest of the install proceed.
const snippetSource = JSON.parse(read(path.join(SRC, 'hooks', 'settings.snippet.json'))); delete snippetSource['//'];
/*
 * ⛔ 7-PRE-A · COMPOSITION: THE SNIPPET IS THE `strict` COLUMN, NOT THE ONLY COLUMN (P3-T-11).
 *
 * The registration set laid into a target is now composed for that project's DECLARED posture rather
 * than copied fixed. `install/_settings-manifest.js` is the projection and its header carries the
 * reasoning; the two facts that matter here are that under `strict` it returns the snippet's own entry
 * objects unreordered — so the composed settings.json is byte-identical, which is anti-drift item 35 and
 * P3-N-2's freeze test — and that an entry is dropped ONLY where every rule the hook behind it carries
 * resolves to `off`, so nothing that still has something to say stops being wired.
 *
 * ⛔ DEFAULTED, UNREADABLE AND INVALID ALL COMPOSE `strict`, and that is `hooks/_posture.js`'s own
 * fail-closed answer rather than a second policy written here: `resolve()` returns the profile in every
 * one of its four states, and three of them return `strict`. A target that has never heard of posture
 * gets exactly what it got before, and a target whose config is broken gets the same — because "could
 * not read the policy" must never compose the loosest set of guards. The SOURCE is reported in the merge
 * summary so a founder can see which of the four they are in.
 *
 * `targetPosture` is resolved once, at §2e-bis, because §2f composes the kernel file set from the same
 * declaration (P3-K-14).
 */
const composed = manifest.compose(snippetSource, targetPosture.profile);
const snippet = composed.settings;
const omittedByProfile = composed.omitted;
/*
 * ⛔ 7-PRE-A-bis - THE WIRING PROJECTION IS A SECOND REASON AN ENTRY IS ABSENT, AND IT RETIRES
 * THROUGH THE SAME DOOR (P4-T-15b).
 *
 * `light` and `standard` run the PreToolUse guards through one `hooks/dispatch.js` process per
 * registration group; `strict` keeps the four-processes-per-Bash-call wiring, because that profile is
 * DEFINED as today's behaviour and anti-drift item 35 pins its composed bytes. So an entry can now be
 * missing from settings.json for a fourth reason - the profile in force composed the OTHER wiring - and
 * `manifest.compose` reports those tuples separately from `omitted` so a wiring change never reads as a
 * guard being switched off.
 *
 * They are UNIONED here because retirement is one mechanism, not two: the conditions at 7a-bis (this
 * profile does not compose it, the receipt proves we placed it, there is memory at all) are exactly the
 * conditions a wiring flip needs, and `dispatched` is symmetric - a dispatching profile retires the
 * per-hook entries, a non-dispatching one retires the dispatcher entry - so `light` -> `strict` and
 * `strict` -> `light` both restore what the other took away. Anything else makes a profile flip a
 * one-way door, which is the defect P3-T-11's record exists to prevent.
 */
const dispatchedByProfile = composed.dispatched;
const notComposedByProfile = [...omittedByProfile, ...dispatchedByProfile];
/*
 * ⛔ 7-PRE · THE OWNERSHIP RECORD THIS MERGE READS BEFORE IT ADDS ANYTHING (BUG-6).
 *
 * The merge below is additive by design and that half stays. What it lacked was MEMORY: it could not
 * tell "this hook is new in the pack version you are installing" from "you deleted this hook on
 * purpose last Tuesday", because both look identical from settings.json alone — absent. So it re-added
 * both, every run, which is why the pack felt un-loosenable and why `push-guard.js`'s own "delete the
 * entry to disable me" advice did not actually work.
 *
 * The receipt supplies the missing third state. A tuple is (event, matcher, command, if) — the same
 * identity the merge already dedupes on, plus the EVENT, because the same command legitimately rides
 * several events (index-guard is wired under five). Three cases, and they are exhaustive:
 *
 *   in receipt, in settings.json      → ours, still there. Left exactly as the founder has it.
 *   in receipt, NOT in settings.json  → FOUNDER-REMOVED. Not re-added, and said so in the summary.
 *   NOT in receipt                    → new in this pack version. Added, as always.
 *
 * ⛔ THE v1 COMPATIBILITY CLAUSE, AND WHY IT KEYS ON THE ARRAY RATHER THAN THE VERSION NUMBER. Every
 * receipt written before this version carries `schemaVersion: 1` and no `settingsHooks` key at all.
 * That is NOT "the installer placed no hooks" — it is "this install has no memory", and collapsing the
 * two would be the worst possible reading: an empty ownership record makes every snippet tuple
 * new-in-this-version, which is add-only behaviour wearing a receipt's name. So an ABSENT array
 * resolves to null (no memory), the merge falls back to today's add-only behaviour, and the summary
 * SAYS so rather than letting a founder believe a removal will stick when it will not. This run then
 * records what it owns, so the next removal does. A receipt naming a FUTURE schemaVersion is read the
 * same way — by the presence of the array — because a reader that refuses an unknown version outright
 * would silently downgrade a newer install to add-only without ever saying why.
 */
// The record itself is read at §2e-bis, because §2f-bis needs the same one; this is where what it MEANS
// is decided, and the three-way reading below is the whole of it.
// A tuple is DATA, and data is normalized before it is trusted: a row missing a string event or
// command names nothing this merge can act on, so it is dropped rather than guessed at.
const normalizeTuple = (t) => (t && typeof t === 'object' && !Array.isArray(t)
  && typeof t.event === 'string' && t.event
  && typeof t.command === 'string' && t.command)
  ? { event: t.event, matcher: typeof t.matcher === 'string' ? t.matcher : '', command: t.command, if: typeof t.if === 'string' ? t.if : '' }
  : null;
const tupleKey = (t) => JSON.stringify([t.event, t.matcher || '', t.command, t.if || '']);
const priorTuples = (priorReceipt && Array.isArray(priorReceipt.settingsHooks))
  ? priorReceipt.settingsHooks.map(normalizeTuple).filter(Boolean)
  : null;
const ownedTuples = priorTuples ? new Set(priorTuples.map(tupleKey)) : null; // null = no memory, NOT an empty set
/*
 * ⛔ 7-PRE-B · RETIRED-BY-PROFILE IS A THIRD ABSENCE, AND COLLAPSING IT INTO FOUNDER-REMOVED WOULD MAKE
 * A PROFILE FLIP A ONE-WAY DOOR (P3-T-11).
 *
 * §7-PRE's three cases are exhaustive only while the composed set never shrinks. Once it does, an entry
 * can be missing from settings.json for a THIRD reason: this installer took it out itself, because the
 * profile in force at the time composed without it. Read through §7-PRE's table that is indistinguishable
 * from a founder deletion — so flipping `light` → `strict` would never restore what flipping
 * `strict` → `light` retired, and the founder's own config edit would be silently un-undoable.
 *
 * So a retirement is RECORDED as one. `settingsRetired` names the tuples this installer removed by
 * profile; they stay in `settingsHooks` too, because they are still ours. A tuple named here is re-added
 * the moment a profile composes it again, and it leaves the retired list on that run. A tuple the founder
 * deleted is in `settingsHooks` and NOT here, and stays gone — T-08's mechanism is untouched.
 */
const priorRetiredTuples = (priorReceipt && Array.isArray(priorReceipt.settingsRetired))
  ? priorReceipt.settingsRetired.map(normalizeTuple).filter(Boolean)
  : [];
const retiredBefore = new Set(priorRetiredTuples.map(tupleKey));
const settingsPath = path.join(TARGET, '.claude', 'settings.json');
placedPaths.add('.claude/settings.json');
let settings = {};
let settingsUnparseable = false;
if (fs.existsSync(settingsPath)) {
  try { settings = JSON.parse(read(settingsPath)); }
  catch {
    settingsUnparseable = true;
    console.warn('⚠️  .claude/settings.json exists but is not valid JSON — the settings merge was SKIPPED and the file left byte-identical. Fix the JSON by hand, then re-run the install to wire the pack hooks/permissions.');
  }
}
let hooksAdded = 0;
let permsAdded = 0;
let skillBudgetWasUnset = false;
// The merge's own diff, reported from what it DID rather than from what the snippet intends
// (testing-standards rule 11). `hooksOwned` is what the receipt below will claim: every snippet tuple
// this run added, plus every one already present and therefore still ours to remember.
const hooksAddedTuples = [];
const hooksKeptTuples = [];
const hooksFounderRemoved = [];
const hooksOwned = [];
const hooksRetired = [];      // removed by THIS run because the composed set no longer names them
const hooksRestored = [];     // re-added because this profile composes something a prior profile retired
if (!settingsUnparseable) {
  settings.hooks = settings.hooks || {};
  for (const [evt, arr] of Object.entries(snippet.hooks)) {
    settings.hooks[evt] = settings.hooks[evt] || [];
    for (const entry of arr) {
      /*
       * Per-HOOK merge, not per-group. The old first-hook-only check silently dropped every hook
       * added to an existing group in a later pack version — the upgrade harvest's upgrade lost
       * secret-scan@commit, shell-guard, and mcp-reaper@SessionStart to exactly this. Keyed on
       * (command, if) because secret-scan runs twice with the same command under different `if`s.
       *
       * ⛔ AND KEYED ON THE MATCHER, WHICH EVENT-WIDE DEDUPE GOT WRONG IN THE WORST POSSIBLE PLACE.
       * `index-guard.js` is the one hook the snippet wires TWICE under one event: once for
       * Edit|Write|MultiEdit|NotebookEdit and once for Bash. Event-wide dedupe processed the editor
       * entry first, recorded the command as "already wired", and then silently skipped the Bash
       * entry — so on EVERY installed target index-guard was wired for editor tools only, and the
       * entire Bash side of Scenario M (no shell for a shared-checkout subagent, run-time-decided
       * pathspecs, --include, the wave check, the writer lease) never ran at all. An adversarial gate
       * found it by replaying the hooks the installed settings.json actually selects; the pack's own
       * installed-seam tests could not, because they invoked `.claude/hooks/index-guard.js` DIRECTLY
       * and so proved the file works rather than that it is called.
       *
       * The matcher is part of a hook's identity because it is part of WHEN IT RUNS. A hook a user
       * genuinely moved under their own matcher will now be re-added under ours — the honest trade,
       * since the alternative silently disables enforcement and looks identical to success.
       */
      const matcher = entry.matcher || '';
      const key = (h) => JSON.stringify([h.command, h.if || '']);
      const existing = new Set(
        settings.hooks[evt].filter((g) => (g.matcher || '') === matcher).flatMap((g) => (g.hooks || []).map(key)),
      );
      /*
       * ⛔ THE THREE-WAY SPLIT (see §7-PRE). Without the receipt this is exactly the filter it replaced
       * — `missing` is still "in the snippet, not in settings.json" — so a target with no ownership
       * record behaves byte-for-byte as it did before this version. With one, the middle case appears:
       * a tuple we PLACED and the founder DELETED is skipped, and it stays in the receipt below so the
       * skip holds on every later run rather than lapsing the moment the record is rewritten.
       */
      const missing = [];
      for (const h of (entry.hooks || [])) {
        if (!h.command) continue;
        const tuple = { event: evt, matcher, command: h.command, if: h.if || '' };
        if (existing.has(key(h))) { hooksKeptTuples.push(tuple); hooksOwned.push(tuple); continue; }
        /*
         * ⛔ AND THE RETIRED CASE IS CHECKED FIRST, because it is a SUBSET of "in the receipt, absent
         * from settings.json" and the broader test would swallow it (see §7-PRE-B). We took this entry
         * out ourselves under a previous profile; this profile composes it, so it comes back.
         */
        if (retiredBefore.has(tupleKey(tuple))) { hooksRestored.push(tuple); }
        else if (ownedTuples && ownedTuples.has(tupleKey(tuple))) { hooksFounderRemoved.push(tuple); continue; }
        missing.push(h);
        hooksAddedTuples.push(tuple);
        hooksOwned.push(tuple);
      }
      if (!missing.length) continue;
      // New hooks join the group this snippet entry seeded in an earlier version (any shared hook
      // identifies it); a fully-new entry becomes its own group — never injected into a group the
      // user authored, even on the same matcher. Matcher alone is not enough of a match — the
      // snippet legitimately ships two distinct "Bash" entries (secret-scan, push-guard) that must
      // stay separate groups.
      const sameMatcher = settings.hooks[evt].filter((g) => (g.matcher || '') === matcher);
      const home = sameMatcher.find((g) => (g.hooks || []).some((h) => (entry.hooks || []).some((eh) => key(eh) === key(h))));
      if (home) home.hooks = (home.hooks || []).concat(missing);
      else settings.hooks[evt].push({ ...entry, hooks: missing });
      hooksAdded += missing.length;
    }
  }

  /*
   * 7a-bis. RETIREMENT — the only place this installer REMOVES a hook entry, and every condition on it
   * is there to keep that removal provable rather than merely intended (P3-T-11).
   *
   * Three conjunctions, all required:
   *   • the tuple is one THIS PROFILE OMITTED. Not "absent from the composed set" in general — the
   *     manifest's own omission list, so an entry wired by an older pack version that today's snippet no
   *     longer names is left completely alone. That legacy shape is the uninstaller's business
   *     (`install/uninstall.js`'s receipt-union sweep), not a profile's.
   *   • THE RECEIPT SAYS WE PLACED IT. A founder-added entry naming the same hook is not ours to remove,
   *     which is the acceptance's "never touches a founder-owned entry" — and it is checked against the
   *     record rather than against the command, so a founder who wires `mcp-reaper.js` themselves under
   *     their own matcher keeps it.
   *   • THERE IS MEMORY AT ALL. With `ownedTuples === null` (a pre-receipt or v1 target) nothing is
   *     retired, because nothing can be proved ours. The v1 clause's discipline, applied to the one
   *     operation where guessing wrong deletes a founder's line instead of adding one.
   *
   * A group emptied by a retirement is dropped rather than left as `"hooks": []`, matching what the
   * founder's own hand-edit would leave behind.
   */
  if (ownedTuples && notComposedByProfile.length) {
    const omittedKeys = new Set(notComposedByProfile.map(tupleKey));
    for (const [evt, groups] of Object.entries(settings.hooks)) {
      if (!Array.isArray(groups)) continue;
      for (const g of groups) {
        if (!g || !Array.isArray(g.hooks)) continue;
        const keep = [];
        for (const h of g.hooks) {
          const tuple = { event: evt, matcher: (g.matcher || ''), command: (h && h.command) || '', if: (h && h.if) || '' };
          const k = tupleKey(tuple);
          if (tuple.command && omittedKeys.has(k) && ownedTuples.has(k)) { hooksRetired.push(tuple); continue; }
          keep.push(h);
        }
        g.hooks = keep;
      }
      const live = groups.filter((g) => !g || !Array.isArray(g.hooks) || g.hooks.length);
      if (live.length) settings.hooks[evt] = live; else delete settings.hooks[evt];
    }
  }

  // 7b. permissions.allow — union, exact-string dedupe, never remove existing entries. Read-only commands only.
  const allowBaseline = (snippet.permissions && snippet.permissions.allow) || [];
  if (opsTargets.host === 'fly') allowBaseline.push('Bash(flyctl status:*)', 'Bash(flyctl logs:*)'); // read-only ops visibility
  settings.permissions = settings.permissions || {};
  settings.permissions.allow = settings.permissions.allow || [];
  const haveAllow = new Set(settings.permissions.allow);
  for (const rule of allowBaseline) {
    if (!haveAllow.has(rule)) { settings.permissions.allow.push(rule); haveAllow.add(rule); permsAdded++; }
  }

  // 7c. skillListingBudgetFraction — additive, never clobber (T2): same nullish-merge discipline as hooks/
  // permissions.allow above. Raises the eager skill-listing budget so this pack's ~27 skills plus the target's
  // own don't silently truncate under the harness's default budget; see docs/research/claude-code-limits.md.
  skillBudgetWasUnset = settings.skillListingBudgetFraction === undefined;
  settings.skillListingBudgetFraction = settings.skillListingBudgetFraction ?? 0.02;

  ensureDir(path.dirname(settingsPath));
  writeFile(settingsPath, JSON.stringify(settings, null, 2) + '\n');
}

/*
 * 7d. THE RECEIPT WRITE — one file, both kinds of placement (see §3c for the adapter half and §7-PRE
 * for the hook half). schemaVersion 2 = "this receipt can carry settingsHooks"; the reader's v1 clause
 * is what keeps an older target working, and it keys on the array, never on this number.
 *
 * ⛔ A FOUNDER-REMOVED TUPLE STAYS IN THE RECEIPT, AND THAT IS THE WHOLE MECHANISM. Dropping it would
 * make the record agree with settings.json — which is exactly the state that means "new in this
 * version" — so the very next run would re-add it and the fix would last one install. So the written
 * list is the UNION of what this run owns and what the prior receipt claimed: removals accumulate,
 * they do not lapse. The union is also the migration path for an existing install: its first upgrade
 * has no memory, merges add-only (announced), and records the tuples now present — so the SECOND
 * removal is the first one that sticks.
 *
 * ⛔ AND AN UNPARSEABLE settings.json CARRIES THE PRIOR RECORD FORWARD UNCHANGED. The merge was
 * skipped entirely and the file left byte-identical (see §7's guard); this run therefore placed no
 * hook and learned nothing, so overwriting the ownership record with an empty one would silently
 * discard every removal the founder had made while their JSON was broken.
 */
{
  const merged = new Map();
  for (const t of (priorTuples || [])) merged.set(tupleKey(t), t);
  if (!settingsUnparseable) for (const t of hooksOwned) merged.set(tupleKey(t), t);
  const settingsHooks = [...merged.values()].sort((a, b) => (tupleKey(a) < tupleKey(b) ? -1 : 1));
  /*
   * ⛔ AND THE RETIRED LIST ACCUMULATES THE SAME WAY, MINUS WHATEVER CAME BACK. A tuple this run added
   * or kept is live, so it leaves the list on that run — leaving it in would make a restored entry look
   * retired forever and the next flip would remove it again. An unparseable settings.json retires
   * nothing and restores nothing, so the prior list carries forward untouched, exactly as
   * `settingsHooks` does.
   */
  const retiredMerged = new Map();
  for (const t of priorRetiredTuples) retiredMerged.set(tupleKey(t), t);
  if (!settingsUnparseable) {
    for (const t of hooksRetired) retiredMerged.set(tupleKey(t), t);
    for (const t of hooksOwned) retiredMerged.delete(tupleKey(t));
  }
  const settingsRetired = [...retiredMerged.values()].sort((a, b) => (tupleKey(a) < tupleKey(b) ? -1 : 1));
  /*
   * ⛔ AND THE KERNEL HALF ACCUMULATES BY EXACTLY THE SAME RULE (P3-K-14). A path this profile PLACED is
   * live and leaves the list on that run, so a flip back does not leave a restored subsystem recorded as
   * retired forever — and a file left in place because a founder had edited it is not recorded either,
   * because nothing was retired. Unlike the settings half this is not conditioned on the settings merge:
   * an unparseable `settings.json` skips that merge and does not stop §2f from placing the kernel, so
   * pretending nothing happened here would put the record out of step with the tree.
   */
  const kernelRetiredMerged = new Map();
  for (const rel of (Array.isArray(priorReceipt && priorReceipt.kernelRetired) ? priorReceipt.kernelRetired : [])) {
    if (typeof rel === 'string' && rel) kernelRetiredMerged.set(rel, rel);
  }
  for (const r of kernelRetiredNow) kernelRetiredMerged.set(r.rel, r.rel);
  for (const rel of kernelPlacedRel) kernelRetiredMerged.delete(rel);
  const kernelRetired = [...kernelRetiredMerged.values()].sort();
  if (adapterReceipt.length || settingsHooks.length) {
    ensureDir(path.join(TARGET, '.respawnpack'));
    // An EMPTY settingsHooks is never written: "no key" is the honest way to say no memory, and the
    // reader above turns an empty array into memory-of-nothing, which is a different claim.
    /*
     * ⛔ WHICH WIRING THIS RUN LAID, RECORDED SO THE OTHER ONE CAN BE RE-LAID (P4-T-15b, behind
     * P3-T-08's receipt). `settingsHooks` says WHAT is ours; this says HOW it is wired, which is the
     * fact an upgrade needs to roll a target back from the dispatcher to the multi-hook registrations
     * without re-deriving it from the entries themselves. `groups` names the registration groups the
     * dispatcher answers for, so a later pack version that dispatches a different set can see which
     * one the target is actually holding.
     *
     * Skipped entirely when the settings merge was skipped: an unparseable settings.json means this run
     * wired nothing, and a wiring claim it did not place would be the same lie the ownership record
     * refuses to tell one field over.
     */
    const settingsWiring = settingsUnparseable
      ? (priorReceipt && priorReceipt.settingsWiring) || null
      : { mode: composed.wiring, groups: [...new Set(dispatchedByProfile.map((t) => t.group))].sort() };
    const receipt = {
      schemaVersion: 2,
      adapters: adapterReceipt,
      ...(settingsWiring ? { settingsWiring } : {}),
      ...(settingsHooks.length ? { settingsHooks } : {}),
      // Same rule as settingsHooks: an EMPTY array is never written, because "no key" is the honest way
      // to say nothing is retired and an empty list is a different claim from an absent one.
      ...(settingsRetired.length ? { settingsRetired } : {}),
      // And the same rule again for the kernel half, which is also why a `strict` receipt is byte-for-byte
      // what it was before this task: that profile omits nothing, so this key is never written there.
      ...(kernelRetired.length ? { kernelRetired } : {}),
    };
    writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  }
}

// 8. respawnpack.config.json (protected: re-detecting the stack would stomp a founder-edited codeTruth/opsTargets)
/*
 * ⛔ THE `state` BLOCK IS SEEDED, NOT LEFT FOR SOMEONE TO DISCOVER. It did not exist here at all, and
 * the the 2026-08-07 field run (§2) measured the cost: `state.removals.liveContentDirs` was unset in
 * the target, so the "⛔ killed features are never re-added" guarantee — which CLAUDE.md and the
 * savepoint skill both present as a core promise — scanned ZERO directories and reported
 * CANNOT_DETERMINE forever. The schema supported the key, the kernel read it, and nothing ever wrote
 * it. A default that has to be found in a schema file is not a default.
 *
 * ⛔ AND THE FIRST SEED WAS ITSELF TOO NARROW — `['docs']` DEFAULT-CLOSED WHERE IT HAD TO DEFAULT-OPEN.
 * `docs/` was chosen because this installer creates it, so it provably exists. That reasoning is sound
 * and the result was still nearly useless, because it is not where a project's prose actually lives.
 * Measured on a real target: `docs/` held 37 markdown files while four sibling directories held 453
 * more, so the scan read 8% of the corpus. The phrase that project had retired survived in 24 of the
 * unscanned files and ZERO `docs/` files — a registry would have reported a
 * clean PASS over the one directory that could not contain the defect. The same shape appeared in the
 * pack's own repository, where root-level `README.md` is the most drift-prone prose there is and no
 * directory list can reach a root file at all.
 *
 * ⭐ SO THE SEED IS `['.']` MINUS WHAT IS DEMONSTRABLY NOT PROSE. A directory nobody scans is the
 * run-A defect, and a LIST is default-closed: every directory added after install day is a
 * silent blind spot, which is exactly how a scan ends up reading 8%. Scanning the root and subtracting
 * is default-OPEN — new content is covered the day it lands, and the burden moves to excluding things
 * that are provably not the project's own writing. The kernel already drops `node_modules`, `.git` and
 * `__pycache__` at any depth; this seeds the arguable ones it FOUND in this target, so the config
 * describes a real tree rather than carrying a generic denylist nobody verified.
 *
 * `historyPaths` names the files whose whole job is to DESCRIBE removals — a phrase in `DECISIONS.md`
 * or a changelog is a record of a killing, not a reintroduction, and seeding the dirs without these
 * would hand every founder a false positive on their first scan. Root-level ones are detected because
 * `['.']` now reaches them.
 *
 * This is still a floor, not a claim of completeness: a reintroduction spelled in words no row lists,
 * or expressed in code rather than prose, is outside what this can see. `respawnpack removals` prints
 * the directories, extensions and always-excluded names it read so the boundary stays inspectable.
 */
/*
 * ⛔ AUTO-EXCLUDING BY NAME REBUILDS THE BLIND SPOT THIS SEED EXISTS TO CLOSE — a first version of this
 * list carried `build`, `vendor`, `target`, `out`, `dist`, `third_party` and `tmp`, and every one of
 * those is a directory a real project may fill with hand-written prose. A target holding
 * `vendor/business-rules.md` or `build/spec.md` had it silently dropped and the scan returned PASS
 * having never read it. That is the run-A defect, reintroduced by the very change that was
 * widening the scan to prevent it, and it contradicted the rule stated one file over in removals.js:
 * anything arguable stays the PROJECT's declared decision.
 *
 * ⭐ SO THE SPLIT IS BY PROVABILITY, NOT BY CONVENTION. The installer auto-excludes NONE of these;
 * existence and a conventional name do not establish that a target owns no prose there. It suggests
 * them in the summary instead. The kernel's tiny by-name set (`.git`, `node_modules`, `__pycache__`) is
 * the only implicit set. A false FAIL is loud and one config line to fix, while a directory nobody scans
 * reports success forever.
 */
// Existence and a conventional name are not proof of ownership. Suggest every arguable directory and
// auto-exclude none; the kernel's tiny by-name set is the only implicit set.
const SUGGESTED_EXCLUDE_CANDIDATES = [
  'dist', 'build', 'out', 'target', 'vendor', 'third_party', 'tmp', 'venv', 'coverage',
  '.next', '.nuxt', '.svelte-kit', '.venv', '.tox', '.mypy_cache', '.pytest_cache', '.cache', 'bower_components',
];
const detectedExcludes = [];
const suggestedExcludes = SUGGESTED_EXCLUDE_CANDIDATES.filter((d) => exists(d));
// The two this installer places, plus any root-level history file the target already keeps.
const detectedHistoryPaths = [
  'docs/DECISIONS.md',
  'docs/derived/CHANGELOG.md',
  ...['CHANGELOG.md', 'HISTORY.md', 'ATTRIBUTION.md'].filter((f) => exists(f)),
];
const cfg = {
  respawnpack: read(path.join(SRC, 'VERSION')).trim(),
  installedAt: today,
  // Detected or omitted. `codeTruth` has no detector at all — nothing about a file tree says which paths
  // outrank prose — so it is never seeded, and /respawn or /onboard fills it from evidence.
  ...(routeSource ? { routeSource } : {}),
  opsTargets,
  extras: [], // accepted adoption-interview extras — /respawn records choices here
  state: {
    removals: {
      registry: 'docs/derived/state/removals.json',
      liveContentDirs: ['.'],
      extensions: ['.md', '.mdx', '.markdown', '.txt', '.rst', '.adoc'],
      historyPaths: detectedHistoryPaths,
      exclude: detectedExcludes,
    },
    /*
     * DF-005. Seeded as a VISIBLE placeholder, never as an answer: the generic pack assumes no task
     * system, and an installer that wrote `notApplicable: true` here would be INFERRING a
     * not-applicable on the founder's behalf — the precise defect class the gate and the removal
     * contract both exist to prevent. So this declares nothing and reports NOT_CONFIGURED, which is
     * honest, is not a failure, and is now the same answer an absent key gives.
     */
    reconcile: {
      note: 'UNCONFIGURED — reconciliation compares your task list against your own gap/gate/requirement records, and reports CANNOT_DETERMINE until both sides are declared. '
        + 'To enable: set `tasks` and `project`, each {kind: "json"|"adapter"|"requirements", ...}. '
        + 'To opt out: replace this note with `"notApplicable": true` and a `"reason"` saying why. '
        + 'Leaving it as-is is a valid third choice — nothing is claimed, so nothing is broken.',
    },
  },
  note: 'routeSource + codeTruth feed the /savepoint drift-check; each is ABSENT until decided, and an absent one reports UNDECIDED rather than pretending to a value. '
    + 'Resolve either by naming real paths, or by declaring {"notApplicable": true, "reason": "<why this project has none>"}. `respawnpack doctor` lists what is still undecided. '
    + 'OPS_TARGETS feed the ops skills; EXTRAS is the adoption interview\'s record. '
    + 'state.removals.liveContentDirs is what the killed-feature scan reads — it is seeded as ["."] (the whole repo) minus state.removals.exclude, so new content is covered the day it lands; narrow it only deliberately, because a directory nobody scans is a blind spot that reports success. '
    + 'state.removals.registry is the file that makes a removal enforceable — a row naming the phrases that would reintroduce it. An empty registry is CANNOT_DETERMINE, never a pass.',
};
/*
 * ⛔ A LEGACY-SHAPE MATCH IS MIGRATION ELIGIBILITY, NOT OWNERSHIP PROVENANCE.
 *
 * Every old installer wrote the docs-only block below, and the field run measured its blind spot. But a founder
 * can deliberately choose the same values, so structural equality cannot authorize a rewrite. A plain
 * install only announces the migration. `--migrate-removals-scope` is the explicit decision that
 * authorizes replacing an exact known seed; any added, removed, or changed field remains ineligible.
 *
 * The array is a versioned migration registry: future seeds append their predecessors rather than
 * silently changing which old targets are eligible.
 */
const LEGACY_SEEDED_REMOVALS = [
  {
    registry: 'docs/derived/state/removals.json',
    liveContentDirs: ['docs'],
    extensions: ['.md', '.mdx', '.markdown', '.txt', '.rst', '.adoc'],
    historyPaths: ['docs/DECISIONS.md', 'docs/derived/CHANGELOG.md'],
  },
];
// Key-order-independent structural comparison — a config rewritten by any JSON tool must still match.
const canonicalJSON = (v) => {
  if (Array.isArray(v)) return `[${v.map(canonicalJSON).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJSON(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
};
const isUntouchedLegacySeed = (block) => {
  if (!block || typeof block !== 'object' || Array.isArray(block)) return false;
  const c = canonicalJSON(block);
  return LEGACY_SEEDED_REMOVALS.some((seed) => canonicalJSON(seed) === c);
};
let removalsWidened = false;
let removalsMigrationOffered = false;
let plannedConfig = null; // dry-run summaries report the after-state without pretending it was written

placedPaths.add('respawnpack.config.json');
const cfgExists = exists('respawnpack.config.json');
if (!cfgExists || FORCE_ALL) {
  plannedConfig = cfg;
  writeFile(path.join(TARGET, 'respawnpack.config.json'), JSON.stringify(cfg, null, 2) + '\n');
  created.push('respawnpack.config.json');
} else {
  /*
   * Protected — but two of the installer's own fields are not the founder's. On upgrade, touch ONLY
   * the version stamp and any structurally-absent `state` default. Every founder field survives.
   *
   *   · `respawnpack` + `upgradedAt` — the version the target records (upgrade harvest: upgrades silently
   *     kept the old version string until the founder hand-bumped it).
   *
   *   · `state.removals` — BACK-FILLED, and only when the key is entirely absent. Every install made
   *     before the seed above shipped a config with no `state` key at all, and field run §2 is what that
   *     costs: an unenforced killed-feature guarantee that no upgrade would ever repair, because the
   *     whole file is protected. ⛔ ADDITIVE ONLY, exactly like the settings.json hook/permission merge:
   *     an EXISTING `state.removals` — even `{}`, even one whose `liveContentDirs` a founder has
   *     deliberately narrowed — is never read, never merged into, and never widened. Filling a gap and
   *     overwriting a decision are different acts, and only the first is the installer's to make.
   */
  try {
    const existing = JSON.parse(read(path.join(TARGET, 'respawnpack.config.json')));
    if (!existing || typeof existing !== 'object' || Array.isArray(existing)) throw new Error('root must be an object');
    const changes = [];
    if (existing.respawnpack !== cfg.respawnpack) {
      existing.respawnpack = cfg.respawnpack;
      existing.upgradedAt = today;
      changes.push(`version → ${cfg.respawnpack}`);
    }
    // A `state` that exists but is not a plain object is a founder value this installer does not
    // understand — leave it exactly as written rather than replacing it with something parseable.
    if (existing.state === undefined) existing.state = {};
    const stateIsObject = existing.state && typeof existing.state === 'object' && !Array.isArray(existing.state);
    if (stateIsObject && existing.state.removals === undefined) {
      existing.state.removals = cfg.state.removals;
      changes.push('state.removals seeded (was unset — the killed-feature scan read zero directories)');
    } else if (stateIsObject && isUntouchedLegacySeed(existing.state.removals)) {
      /*
       * Structural equality is strong evidence that an old installer wrote this block, and it is not
       * provenance: a founder can deliberately choose the same values. Preview by default; only the
       * dedicated flag authorizes replacing founder-owned config.
       */
      if (MIGRATE_REMOVALS_SCOPE) {
        existing.state.removals = cfg.state.removals;
        removalsWidened = true;
        changes.push('state.removals WIDENED off the superseded docs-only default (explicitly authorized by --migrate-removals-scope)');
      } else removalsMigrationOffered = true;
    }
    /*
     * ⛔ `state.reconcile` BACK-FILLS ON THE SAME ADDITIVE RULE, and for the same reason: every install
     * before this one shipped without the key, so DF-005 reported "no state.reconcile" forever with
     * nothing in the founder's own config to hint that a choice existed. The seed DECLARES NOTHING — it
     * is a note — so back-filling it cannot change any verdict, only make the choice visible.
     *
     * ⛔ AN EXISTING KEY IS NEVER TOUCHED, including one a founder emptied to `{}`. Filling a gap and
     * overwriting a decision are different acts, and only the first is the installer's to make.
     *
     * NOTE the narrowing this does NOT do automatically: an already-seeded docs-only block is previewed,
     * never rewritten from a content match alone. Its owner may authorize the known migration with
     * --migrate-removals-scope.
     */
    if (stateIsObject && existing.state.reconcile === undefined) {
      existing.state.reconcile = cfg.state.reconcile;
      changes.push('state.reconcile seeded (was unset — a placeholder that declares nothing, so no verdict changes)');
    }
    plannedConfig = existing;
    if (changes.length) {
      writeFile(path.join(TARGET, 'respawnpack.config.json'), JSON.stringify(existing, null, 2) + '\n');
      created.push(`respawnpack.config.json (${changes.join('; ')}; founder fields untouched)`);
    } else protectedKept.push('respawnpack.config.json');
  } catch { protectedKept.push('respawnpack.config.json (unparseable — left untouched)'); }
}

/*
 * 8b. The removal registry the config has always POINTED AT and nothing ever CREATED.
 *
 * ⛔ THE GAP THIS CLOSES. `state.removals.registry` named `docs/derived/state/removals.json` in every
 * config this installer has ever written, and the string appeared exactly once in this file — as that
 * path. No target ever received the file. So the killed-feature scan reported CANNOT_DETERMINE on
 * every install ever performed, and the founder's only clue was a path in a config pointing at
 * nothing. A guarantee whose input file is never created is not a guarantee with a gap in it; it is a
 * guarantee that has never once run.
 *
 * ⭐ THE SKELETON IS EMPTY ON PURPOSE, AND EMPTY IS STILL NOT A PASS. `removals: []` reports
 * CANNOT_DETERMINE — "a check with nothing to check" — which is the honest verdict for a project that
 * has not yet recorded a removal. What the file buys is DISCOVERABILITY: the shape, the schema
 * version, and a worked example are on disk where the founder edits, instead of in a schema file they
 * have no reason to open. Protected like any authored file: an existing registry is never rewritten.
 */
const DEFAULT_REGISTRY_REL = 'docs/derived/state/removals.json';
let activeConfig = DRY_RUN ? plannedConfig : null;
if (!activeConfig) {
  try { activeConfig = JSON.parse(read(path.join(TARGET, 'respawnpack.config.json'))); } catch { /* classified below */ }
}
const activeState = activeConfig && typeof activeConfig.state === 'object' && !Array.isArray(activeConfig.state)
  ? activeConfig.state : null;
const activeRemovals = activeState && activeState.removals && typeof activeState.removals === 'object' && !Array.isArray(activeState.removals)
  ? activeState.removals : null;
let REGISTRY_REL = DEFAULT_REGISTRY_REL;
let registrySeedError = null;
if (!activeConfig) registrySeedError = 'respawnpack.config.json is missing, unreadable, or unparseable; the installer cannot infer which registry path is authoritative';
else if (!activeRemovals) registrySeedError = 'state.removals is missing or malformed; the installer cannot infer which registry path is authoritative';
else if (Object.prototype.hasOwnProperty.call(activeRemovals, 'registry')) REGISTRY_REL = activeRemovals.registry;

if (!registrySeedError && (typeof REGISTRY_REL !== 'string' || !REGISTRY_REL.trim()
    || portableAbsolute(REGISTRY_REL.trim()) || posixPath(REGISTRY_REL).split('/').includes('..'))) {
  registrySeedError = `state.removals.registry must be a non-empty project-relative path with no parent traversal; got ${JSON.stringify(REGISTRY_REL)}`;
}
if (!registrySeedError) {
  REGISTRY_REL = posixPath(REGISTRY_REL.trim());
  const registryAbs = path.resolve(TARGET, ...REGISTRY_REL.split('/'));
  const authority = containedResolution(TARGET, registryAbs);
  if (!authority.ok) {
    const why = authority.kind === 'symlink' ? 'resolves outside the project through a symlink'
      : authority.kind === 'lexical' ? 'resolves outside the project'
        : `could not be resolved (${(authority.error && (authority.error.code || authority.error.message)) || 'unknown error'})`;
    registrySeedError = `state.removals.registry ${why}: ${REGISTRY_REL}`;
  }
}
if (!registrySeedError) {
  placedPaths.add(REGISTRY_REL);
  if (!exists(REGISTRY_REL)) {
    const skeleton = {
      schemaVersion: '1.0.0',
      reason: 'The killed-feature contract. Each row names a retired feature and the FORBIDDEN LIVE ASSERTIONS whose presence in live prose means it is back — not the feature\'s name, which every retirement notice necessarily contains. '
        + 'An EMPTY registry is CANNOT_DETERMINE, never a pass: it is a check with nothing to check. Add a row the moment you retire something, not at the next audit. '
        + 'Quoting a retirement is not reintroducing it: retirement vocabulary must scope the named feature; unrelated historical words do not shield a live assertion. History sections, blockquotes, fenced code and wholly struck lines pass. '
        + 'Run `respawnpack removals` to see which rows are guarded, which are unverified, and exactly which directories were read.',
      _exampleRow: {
        id: 'D-075',
        feature: 'the magic gauntlet',
        risk: 'high',
        reason: 'Why it was retired, and why it must not come back. Read by humans, not by code.',
        forbidden: ['magic gauntlet', 'gauntlet empowerment'],
      },
      removals: [],
    };
    ensureDir(path.dirname(path.join(TARGET, REGISTRY_REL)));
    writeFile(path.join(TARGET, REGISTRY_REL), JSON.stringify(skeleton, null, 2) + '\n');
    created.push(REGISTRY_REL);
  } else protectedKept.push(REGISTRY_REL); // authored truth: even --force-all never erases it
}

// 9. .gitignore self-heal (B1, dogfood finding) — a target's own .gitignore can incidentally swallow a
// placed path (one dogfood target's `build/` rule matches `.claude/skills/build/`, silently git-ignoring that skill dir on
// the next commit). Detect which placed paths are actually git-ignored in the target and re-include exactly
// those via a targeted negation block — never a blanket `!.claude/` (that would also un-ignore anything a
// user deliberately ignores under these trees, e.g. their own `.claude/settings.local.json`).
function gitCheckIgnore(target, relPaths) {
  if (!relPaths.length) return [];
  try {
    const out = execFileSync('git', ['-C', target, 'check-ignore', '--', ...relPaths], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch (err) {
    // Non-zero exit covers three cases we all want to treat the same way: status 1 (git ran fine, none of the
    // given paths are ignored — the common case), status 128 (fatal — target isn't a git repo), and git
    // missing entirely (ENOENT, no .stdout at all). All three mean "nothing to report" — skip silently, per spec.
    const out = err && typeof err.stdout === 'string' ? err.stdout.trim() : '';
    return out ? out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : [];
  }
}

const GITIGNORE_MARKER_OPEN = '# --- RespawnPack: re-included install paths (auto-generated, do not hand-edit) ---';
const GITIGNORE_MARKER_CLOSE = '# --- /RespawnPack: re-included install paths ---';
let gitignoreTargets = []; // placed paths that are (or already were) re-included this run
let gitignoreWrote = false; // true only when we actually appended the block just now (never true in DRY_RUN)
{
  const ignoredLeaves = gitCheckIgnore(TARGET, [...placedPaths]);
  if (ignoredLeaves.length) {
    // A directory-only ignore pattern (e.g. `build/`) hides its entire contents from git, including from a
    // negation aimed only at a file inside it — git won't even descend into an ignored directory to evaluate
    // a per-file negation. Find the shortest ignored ancestor directory for each hit (the level the pattern
    // actually matched at) and negate that instead; fall back to the leaf path itself if no ancestor dir is
    // ignored (i.e. the leaf file was matched directly).
    // Build ancestor candidates WITHOUT a trailing slash: `git check-ignore` given a trailing-slash path
    // spuriously reports intermediate dirs as ignored (querying `.claude/skills/` comes back matched even though
    // only the `build/` rule at `.claude/skills/build/` applies), which made the old logic pick too-broad and
    // non-functional a target (`!.claude/skills/` can't re-include a file whose parent `build/` dir is excluded).
    // Query bare paths for the true match level, then re-add the trailing slash when negating a directory.
    const ancestorCandidates = new Set();
    const perLeaf = ignoredLeaves.map((rel) => {
      const segs = rel.split('/');
      const ancestors = [];
      for (let i = 1; i < segs.length; i++) { const a = segs.slice(0, i).join('/'); ancestors.push(a); ancestorCandidates.add(a); }
      return { rel, ancestors };
    });
    const ignoredAncestors = new Set(gitCheckIgnore(TARGET, [...ancestorCandidates]));
    const targets = new Set();
    let blanketRoot = null;
    for (const { rel, ancestors } of perLeaf) {
      const dir = ancestors.find((a) => ignoredAncestors.has(a)); // shortest ancestor dir the ignore rule actually matched (no trailing slash)
      if (dir && dir.indexOf('/') === -1) { blanketRoot = dir; continue; } // a whole top-level install root is ignored (e.g. `.claude`): auto-re-including it would be the blanket we forbid
      targets.add(dir ? `${dir}/` : rel); // a directory target needs the trailing slash to re-include its contents; a directly-matched leaf file stays as-is
    }
    if (blanketRoot) console.warn(`⚠️  your .gitignore ignores all of "${blanketRoot}/", which hides RespawnPack's installed files there. Re-include the specific paths you want tracked; a blanket "!${blanketRoot}/" is not written automatically.`);
    gitignoreTargets = [...targets].sort();

    const gitignorePath = path.join(TARGET, '.gitignore');
    let cur = ''; try { cur = read(gitignorePath); } catch { /* target has no .gitignore yet — create/append still applies */ }
    if (!cur.includes(GITIGNORE_MARKER_OPEN) && gitignoreTargets.length) {
      const block = [
        GITIGNORE_MARKER_OPEN,
        '# One of this target\'s own ignore rules above matched a path RespawnPack placed (e.g. a generic',
        '# `build/` rule catching `.claude/skills/build/`). Re-included by exact path only, never a blanket',
        '# `!.claude/`, so anything else you deliberately ignore under these trees stays ignored.',
        ...gitignoreTargets.map((p) => `!${p}`),
        GITIGNORE_MARKER_CLOSE,
        '',
      ].join('\n');
      const prefix = cur ? `${cur.replace(/\s*$/, '\n')}\n` : '';
      writeFile(gitignorePath, prefix + block);
      gitignoreWrote = true;
    }
  }
}

// 9b. .respawnpack/ runtime-state ignore — hooks and skills write session-local state there (push-guard
// markers, the wave ledger, lockdown.allow, guard toggles, onboarding drafts) from the first session on,
// but nothing ever gave the TARGET's .gitignore the rule the pack's own repo has, so that state lands as
// untracked noise that can get committed (upgrade harvest: guard state files surfaced in git status). Append
// it marker-wrapped and idempotent, same discipline as the self-heal block above — the markers are the
// uninstaller's ownership proof, so it can strip exactly this block while a hand-written rule (no markers,
// ambiguous ownership) survives an uninstall. A hand-written rule in any of its spellings counts as present
// here too, so a target that already ignores it is left byte-identical. Only inside a git repo (a
// worktree's .git is a file — both count): a non-git target's .gitignore is inert and not ours to edit —
// the no-git self-heal test pins that stance.
const RESPAWNPACK_IGNORE_OPEN = '# --- RespawnPack: runtime state (auto-generated, do not hand-edit) ---';
const RESPAWNPACK_IGNORE_CLOSE = '# --- /RespawnPack: runtime state ---';
let respawnIgnoreWrote = false; // true when the block was appended (or would be, in DRY_RUN) this run
if (fs.existsSync(path.join(TARGET, '.git'))) {
  const gitignorePath = path.join(TARGET, '.gitignore');
  let cur = ''; try { cur = read(gitignorePath); } catch { /* no .gitignore yet — the block becomes the file */ }
  const hasRule = cur.includes(RESPAWNPACK_IGNORE_OPEN) || cur.split(/\r?\n/).some((l) => /^\/?\.respawnpack\/?$/.test(l.trim()));
  if (!hasRule) {
    const block = [
      RESPAWNPACK_IGNORE_OPEN,
      '# Per-repo hook/skill runtime state (push-guard markers, wave ledger, guard toggles, onboarding',
      '# drafts) — session-local, never meant to be committed.',
      '.respawnpack/',
      RESPAWNPACK_IGNORE_CLOSE,
      '',
    ].join('\n');
    const prefix = cur ? `${cur.replace(/\s*$/, '\n')}\n` : '';
    writeFile(gitignorePath, prefix + block);
    respawnIgnoreWrote = true;
  }
}

// MCP wiring suggestions — two connection paths (ops/README.md, "Which way does a server connect?"): `direct`
// (claude mcp add) for remote-OAuth endpoints and local/CLI-coupled stdio tools, and the `gateway` (/mcp-runtime,
// docker mcp) for keyed or third-party npx servers, so a keyed server's credential lands in the OS keychain
// instead of plaintext Claude config. Research reach is universal (not stack-gated): every project benefits
// from browser/crawler reach beyond WebFetch, so playwright (direct) and firecrawl (gateway) always print,
// ahead of the opsTarget-conditional direct lines below. chrome-devtools-mcp rides alongside playwright as
// the site-testing introspection probe (console/network/perf for /walkthrough + /playtest); its guardrail
// flags (isolated profile, no Google egress) are baked into the printed command, not left to the reader.
const mcpDirect = [
  '         research (browser):  claude mcp add playwright npx @playwright/mcp@latest   # JS-rendered + interactive pages; keyless — can also ride the gateway',
  '         site-testing:        claude mcp add chrome-devtools -- npx -y chrome-devtools-mcp@latest --isolated --no-usage-statistics --no-performance-crux   # console/network/perf for /walkthrough + /playtest; keyless, isolated profile, no Google egress',
];
if (opsTargets.db === 'supabase') mcpDirect.push('         db (supabase):       claude mcp add --transport http supabase https://mcp.supabase.com/mcp');
if (opsTargets.host === 'fly') mcpDirect.push('         host (fly):          claude mcp add fly -- flyctl mcp server');
if (opsTargets.edge === 'cloudflare') mcpDirect.push('         edge (cloudflare):    claude mcp add --transport http cloudflare-api https://mcp.cloudflare.com/mcp');

const mcpGateway = [
  '         research (crawl):    docker mcp secret set FIRECRAWL_API_KEY   # then enable/add firecrawl via the gateway — see /mcp-runtime (situational tier: catalog/README.md)',
  '           fallback, no Docker/WSL2: claude mcp add firecrawl --env FIRECRAWL_API_KEY=fc-YOUR_API_KEY -- npx -y firecrawl-mcp   # ⚠️  plaintext key lands in Claude config — run /secrets-audit after',
];

// Summary
if (DRY_RUN) {
  console.log(`\n🔍 RespawnPack ${cfg.respawnpack} DRY RUN → ${TARGET} (nothing written)`);
  console.log(`   would create ${created.length} file(s) · would skip ${skipped.length} existing · ${protectedKept.length} protected file(s) would stay kept · ${hooksAdded} hook(s) would be added · ${permsAdded} permission(s) would be added`);
} else {
  console.log(`\n✅ RespawnPack ${cfg.respawnpack} installed → ${TARGET}`);
  console.log(`   created ${created.length} file(s) · skipped ${skipped.length} existing · ${protectedKept.length} protected file(s) kept · ${hooksAdded} hook(s) added · ${permsAdded} permission(s) added`);
}
/*
 * ⛔ THE SETTINGS-MERGE DIFF. Read off what the merge actually did (rule 11), so a re-run against a
 * target whose founder has pruned hooks reports THEIR state, not the snippet's intentions. The
 * founder-removed lines print in every mode, because "we deliberately did not re-add this" is the one
 * outcome a founder cannot see by reading the file afterwards; the full three-way listing is the
 * --dry-run diff, where a founder is deciding whether to run the merge at all.
 */
if (!settingsUnparseable) {
  const label = (t) => `${path.posix.basename(t.command)}${t.if ? ` (if ${t.if})` : ''} @ ${t.event}${t.matcher ? `/${t.matcher}` : ''}`;
  const verb = DRY_RUN ? 'would add' : 'added';
  if (ownedTuples === null) {
    console.log(`   settings.json hooks: ${verb} ${hooksAdded} · ${hooksKeptTuples.length} already present, left as they are · NO ownership record was on file (.respawnpack/install-receipt.json predates it, or is unreadable), so this merge was ADD-ONLY: a hook entry you had deleted comes back. This run ${DRY_RUN ? 'would record' : 'records'} the ${hooksOwned.length} entr(ies) it owns, so the next removal sticks.`);
  } else {
    console.log(`   settings.json hooks: ${verb} ${hooksAdded} · ${hooksKeptTuples.length} left as you have them · ${hooksFounderRemoved.length} respected as founder-removed (named in the install receipt, absent from settings.json — NOT re-added)`);
  }
  for (const t of hooksFounderRemoved) console.log(`      ⤷ stays removed: ${label(t)}`);
  /*
   * ⛔ THE COMPOSITION DIFF — PRINTED, BECAUSE IT IS THE ONE THING A FOUNDER CANNOT READ OFF THE FILE.
   * settings.json afterwards shows what IS wired; it cannot show that two entries are absent because a
   * profile omitted them, nor which of the resolver's four sources decided that. Reported from what the
   * composition actually did (testing-standards rule 11), so a re-run at an unchanged profile reports no
   * churn rather than re-announcing intentions.
   */
  {
    const shape = manifest.shapeOf(snippet);
    console.log(`   settings.json posture: \`${targetPosture.profile}\` (${targetPosture.source}) — composed ${shape.entries} entr(ies) in ${shape.groups} group(s)${omittedByProfile.length ? `, ${omittedByProfile.length} omitted by profile` : ''}`);
    if (targetPosture.source !== 'DECLARED') console.log(`      ⤷ ${targetPosture.detail}`);
    for (const t of omittedByProfile) {
      console.log(`      − omitted by \`${targetPosture.profile}\`: ${label(t)} (every rule it carries is off: ${t.rules.join(', ')})`);
    }
    if (dispatchAction) {
      console.log(dispatchAction === 'retired'
        ? `      \u2212 ${DRY_RUN ? 'would remove' : 'removed'}: .claude/hooks/dispatch.js \u2014 this profile wires the guards one process per hook, and an unwired hook file on disk is a \`doctor\` SILENTLY INACTIVE row`
        : '      = kept:    .claude/hooks/dispatch.js \u2014 this profile does not wire it, but the file is not byte-identical to ours, so it was left alone and is reported instead');
    }
    if (dispatchedByProfile.length) {
      const groups = [...new Set(dispatchedByProfile.map((t) => t.group))].sort().join(', ');
      console.log(composed.wiring === 'dispatch'
        ? `      ⇉ PreToolUse wiring: one \`hooks/dispatch.js\` process per group (${groups}) — same guards, same declared order, ${dispatchedByProfile.length} separate registration(s) replaced`
        : `      ⇉ PreToolUse wiring: one process per hook (${groups}) — \`${targetPosture.profile}\` is defined as today's behaviour, so the dispatcher is not composed here`);
    }
    for (const t of hooksRetired) console.log(`      − ${DRY_RUN ? 'would retire' : 'retired'}:  ${label(t)} — this profile no longer composes it, and the receipt says this installer placed it`);
    for (const t of hooksRestored) console.log(`      ↺ ${DRY_RUN ? 'would restore' : 'restored'}: ${label(t)} — retired by an earlier profile, composed again by this one`);
  }
  if (DRY_RUN) {
    for (const t of hooksAddedTuples) console.log(`      + would add:     ${label(t)}`);
    for (const t of hooksKeptTuples) console.log(`      = would keep:    ${label(t)}`);
  }
}
/*
 * ⛔ THE KERNEL-PLACEMENT DIFF (P3-K-14), AND IT PRINTS OUTSIDE THE settings.json BLOCK ON PURPOSE. An
 * unparseable settings.json skips the merge entirely (anti-drift item 30) and does NOT stop §2f from
 * placing the kernel, so a founder in that state still has to be told which subsystem their profile left
 * out. Like the composition diff above, this is the one fact the tree afterwards cannot show: a file that
 * is not there looks the same whether a profile declined it or an install lost it.
 */
{
  const verb = DRY_RUN ? 'would place' : 'placed';
  const omitted = kernelPlacement.omitted;
  console.log(`   kernel: ${verb} ${kernelPlacement.files.length} of ${KERNEL_FILES.length} file(s) under .claude/respawnpack/ for posture \`${targetPosture.profile}\` (${targetPosture.source})`);
  for (const o of omitted) {
    console.log(`      − omitted by \`${targetPosture.profile}\`: ${o.file.replace(/^kernel\//, '')} (ADR-003 ${o.row} reads n.a. in this column) — \`doctor\` reports it as not-installed-by-profile, not BROKEN`);
  }
  for (const r of kernelRetiredNow) {
    console.log(`      − ${DRY_RUN ? 'would retire' : 'retired'}:  ${r.rel} — this profile no longer places it, and the file was byte-identical to the one this installer laid`);
  }
  for (const rel of kernelKeptEdited) {
    console.log(`      = kept: ${rel} — this profile does not place it, but the file on disk is NOT the one this installer laid, so it is yours to remove`);
  }
}
if (skillBudgetWasUnset) {
  const verb = DRY_RUN ? 'would set' : 'set';
  console.log(`   ${verb} skillListingBudgetFraction=0.02 in settings.json (was unset) — raises the eager skill-listing budget so this pack's ~27 skills plus your project's own don't silently truncate; see docs/research/claude-code-limits.md`);
}
console.log(`   detected: routeSource=${routeSource || '(none detected — left UNDECIDED, no key written)'}  opsTargets=${JSON.stringify(opsTargets)}`);
{
  // T-13: effective state, not just this run's declaration (rerun/upgrade summaries read what is
  // actually on disk — testing-standards.md rule 11 — so a run that saw the extras flip off after a
  // prior run placed them still reports the truth instead of a stale default claim).
  const coreCount = agentStems.length - AGENT_EXTRAS.size;
  const extrasOnDisk = DRY_RUN ? agentsExtrasDeclared : agentStems.some((s) => AGENT_EXTRAS.has(s) && exists(`.claude/agents/${s}.md`));
  const verb = DRY_RUN ? 'would place' : 'placed';
  const tier = extrasOnDisk ? `core + extras (${agentStems.length}/${agentStems.length})` : `core set only (${coreCount}/${agentStems.length})`;
  const note = (agentsDeclarationUnreadable && !agentsExtrasDeclared) ? ' — respawnpack.config.json unreadable; extras declaration ignored, core set only' : '';
  console.log(`   agents: ${verb} ${tier}${note}`);
}
/*
 * P6-5-7: which digest sections the managed block was composed from. Printed only when a project type
 * was DECLARED, so a target that declares nothing sees the summary it has always seen, and reporting
 * the effective composition rather than the declaration alone is the same rule-11 discipline the
 * agents line above follows.
 */
if (declaredProjectType !== undefined) {
  if (!projectTypeKnown) {
    console.log(`   CLAUDE.md: NOT written — projectType ${JSON.stringify(declaredProjectType)} is not one of ${Object.keys(PROJECT_TYPE_DROPS).join(', ')}, and an unknown project type is refused rather than guessed`);
  } else {
    const dropped = PROJECT_TYPE_DROPS[declaredProjectType];
    const what = dropped.length ? `dropped digest section(s): ${dropped.join(', ')}` : 'every digest section applies here, so none was dropped';
    console.log(`   CLAUDE.md (${declaredProjectType} variant): ${what} — the boot, contract, behaviour, safety-check and licensing sections are fixed and no project type can drop one`);
  }
}
/*
 * ⛔ WHAT IS INERT ON ARRIVAL IS STATED, NOT LEFT TO BE DISCOVERED. Both of these report
 * CANNOT_DETERMINE on a fresh install — correctly, because nothing has been recorded yet — and a
 * founder who is never told will read that as noise from a check that does not work. the field run ran for
 * months with both silently undetermined.
 */
/*
 * ⛔ REPORT THE STATE ON DISK, NOT THE SEED'S INTENTIONS. These lines were written unconditionally, so
 * a RE-RUN against a configured target announced "the registry is EMPTY" and "reconcile declares no
 * sources" over a project that had authored rows and declared both sides. An installer that reports a
 * fresh install's situation every time is telling a founder their own work does not exist, and it
 * trains them to stop reading the summary — which is where the rest of these warnings live.
 * Read back after every write path (fresh, upgrade, protected, widened) so one code path reports all.
 */
let effRemovals = activeRemovals;
let effReconcile = activeState && activeState.reconcile && typeof activeState.reconcile === 'object'
  && !Array.isArray(activeState.reconcile) ? activeState.reconcile : null;
let effRows = null;
const effRegistryPath = (effRemovals && typeof effRemovals.registry === 'string' && effRemovals.registry.trim())
  ? posixPath(effRemovals.registry.trim()) : REGISTRY_REL;
if (!registrySeedError) {
  try {
    const onDisk = JSON.parse(read(path.join(TARGET, ...effRegistryPath.split('/'))));
    effRows = Array.isArray(onDisk.removals) ? onDisk.removals.length : null;
  } catch {
    // In dry-run an absent safe authority WOULD receive the empty skeleton. Report that planned
    // after-state; malformed existing content remains unknown and is never described as empty.
    if (DRY_RUN && !exists(effRegistryPath)) effRows = 0;
  }
}

const effDirs = effRemovals && Array.isArray(effRemovals.liveContentDirs) ? effRemovals.liveContentDirs : null;
const effExcl = effRemovals && Array.isArray(effRemovals.exclude) ? effRemovals.exclude : [];
console.log(`   killed-feature scan: reads ${effDirs ? JSON.stringify(effDirs) : '(no liveContentDirs configured — the scan reads nothing)'}${effExcl.length ? ` minus exclude=${JSON.stringify(effExcl)}` : ''} — narrow it only deliberately (a directory nobody scans is a blind spot)`);
if (suggestedExcludes.length) {
  console.log(`   these look generated but were NOT excluded for you — add any that hold no hand-written prose to state.removals.exclude: ${suggestedExcludes.join(', ')}`);
}
if (removalsWidened) {
  console.log(`   ⛔ state.removals ${DRY_RUN ? 'would be WIDENED' : 'was WIDENED'} off the superseded docs-only default because --migrate-removals-scope explicitly authorized it. The scan ${DRY_RUN ? 'would read' : 'now reads'} far more files, so a killed feature outside docs/ that used to pass can now FAIL.${DRY_RUN ? ' Review the preview before re-running without --dry-run.' : ' Review `git diff respawnpack.config.json`.'}`);
}
if (removalsMigrationOffered) {
  console.log('   ⛔ state.removals still matches the superseded docs-only seed. It was NOT rewritten: matching content is evidence, not proof of installer ownership. Preview the diff, then re-run with --migrate-removals-scope to authorize widening it to ["."].');
}
if (registrySeedError) {
  console.log(`   ⛔ removal registry was not seeded: ${registrySeedError}`);
} else if (effRows === 0) {
  console.log(`   ⛔ ${effRegistryPath} is EMPTY, so \`respawnpack removals\` reports CANNOT_DETERMINE — not a pass. Add a row per retired feature; an empty registry is a check with nothing to check.`);
} else if (effRows === null) {
  console.log(`   ⛔ ${effRegistryPath} is missing or unparseable, so \`respawnpack removals\` reports CANNOT_DETERMINE — not a pass.`);
} else {
  console.log(`   killed-feature registry: ${effRows} removal row(s) recorded — run \`respawnpack removals\` to see which are guarded and which are unverified.`);
}
if (!effReconcile || (effReconcile.notApplicable !== true
    && !Object.prototype.hasOwnProperty.call(effReconcile, 'tasks')
    && !Object.prototype.hasOwnProperty.call(effReconcile, 'project'))) {
  console.log('   ⛔ state.reconcile declares no sources, so `respawnpack reconcile` reports CANNOT_DETERMINE. Declare a task source and a project record source, or set notApplicable with a reason.');
}
/*
 * compliance material — read the EFFECTIVE state on disk, not just this run's own decision (same
 * discipline as effRemovals/effReconcile above), so a rerun or an upgrade over an already-configured
 * target reports what is actually there rather than repeating this run's local verdict.
 */
{
  const libraryEffPresent = exists('library/compliance/requirements') || (DRY_RUN && placeComplianceMaterial);
  const docsComplianceEffPresent = exists('docs/compliance/README.md') || (DRY_RUN && placeComplianceMaterial);
  if (!complianceScope.ok) {
    console.log(`   ⛔ compliance.config.md is unparseable (${complianceScope.reason}) — library/ and docs/compliance/ were NOT placed. Never "place everything to be safe": fix compliance.config.md's "## 4. Applicable frameworks" section (or restore it from the pack's template) and re-run.`);
  } else if (libraryEffPresent && docsComplianceEffPresent) {
    console.log('   compliance material: scope declared in compliance.config.md section 4 — library/ (vendored requirement texts) and docs/compliance/ are placed.');
  } else {
    console.log('   compliance material: no scope declared in compliance.config.md section 4 — library/ and docs/compliance/ were NOT placed (saves ~471 KB / 24 files + ~20 KB / 5 files). Declare a scope and re-run install/upgrade to place them; see /comply for where the material comes from meanwhile.');
  }
}
if (detectionNotes.length) console.log(`   monorepo detection: ${detectionNotes.join(' · ')}`);
if (skipped.length) console.log(`   (skipped existing — re-run with --force to overwrite: ${skipped.slice(0, 6).join(', ')}${skipped.length > 6 ? ' …' : ''})`);
if (protectedKept.length) console.log(`   (${protectedKept.length} protected file(s) kept — overwrite with --force-all: ${protectedKept.slice(0, 6).join(', ')}${protectedKept.length > 6 ? ' …' : ''})`);
if (gitignoreTargets.length) {
  const verb = gitignoreWrote ? (DRY_RUN ? 'would re-include' : 're-included') : 'already re-included';
  console.log(`   .gitignore: ${verb} ${gitignoreTargets.length} placed path(s) the target's own rules were swallowing: ${gitignoreTargets.join(', ')}`);
}
if (respawnIgnoreWrote) console.log(`   .gitignore: ${DRY_RUN ? 'would add' : 'added'} .respawnpack/ — hook/skill runtime state stays untracked`);
if (DRY_RUN) {
  console.log('\n(dry run — nothing was written; re-run without --dry-run to actually install)');
} else {
  console.log('\nNext steps:');
  console.log('  1. Fill docs/ canonical templates — replace the <PLACEHOLDERS> (start with PRODUCT.md + FEATURES-PAGES.md).');
  console.log('  2. Run `/respawn` and finish onboarding: every optional contract needs an answer — configure it, or declare');
  console.log('     it not applicable WITH A REASON. `node .claude/respawnpack/respawnpack.js doctor` lists what is still undecided.');
  console.log('     Undecided is a real state, not a failure — but it is not release-ready, so savepoint will not exit 0 until it is resolved.');
  console.log('  3. Review .claude/settings.json — lockdown + secret-scan hooks are wired; the Stop→savepoint nudge is included (remove the Stop block to disable).');
  {
    // Point the pre-push guidance at the REAL hooks dir: husky-managed repos set core.hooksPath, so a
    // wrapper copied into .git/hooks never fires there (upgrade harvest: the guard sat dead under husky).
    let hookDir = '.git/hooks';
    try {
      const gitCfg = read(path.join(TARGET, '.git', 'config'));
      const m = gitCfg.match(/^\s*hooksPath\s*=\s*(.+)$/m);
      if (m) hookDir = m[1].trim();
      else if (fs.existsSync(path.join(TARGET, '.husky'))) hookDir = '.husky';
    } catch { /* not a git repo yet: keep the default */ }
    const huskyNote = hookDir === '.git/hooks' ? '' : ` (core.hooksPath/husky detected — .git/hooks is bypassed here)`;
    console.log(`  4. (optional) git-level secret guard: cp .claude/hooks/pre-push ${hookDir}/pre-push && chmod +x ${hookDir}/pre-push${huskyNote}`);
  }
  console.log('  5. Run /respawn to boot a session and /savepoint at session end; /loadout to start new work.');
  console.log('  6. Run /respawn in Claude Code to finish setup — the first-run adoption interview offers optional extras (marketplaces, vendor packs) and captures your compliance scope.');
  console.log(WITH_MEMORY
    ? '  7. hybrid memory: the engine is installed under .claude/respawnpack/memory/engine and registered project-locally in .mcp.json against an absolute Node path. Confirm it actually answers with: node .claude/respawnpack/respawnpack.js doctor — that completes a real MCP handshake and a real write/retrieve round trip, not a file-presence check.'
    : '  7. (optional) hybrid memory: file/grep memory works out of the box and is the default. For semantic + graph-augmented recall, re-run the installer with --with-memory — it installs the engine INTO this project and registers it project-locally against an absolute Node path. (There is no global `rmem`: it is the bin of a private, unpublished package, and the old `claude mcp add respawn-memory -- rmem mcp` instruction could never resolve.)');
  console.log('  8. (optional) add the credited skill marketplaces from the catalog (see ATTRIBUTION.md):');
  console.log('       /plugin marketplace add cloudflare/skills · EveryInc/compound-engineering-plugin · google-labs-code/stitch-skills · anthropics/claude-plugins-official');
  console.log('  9. CLAUDE.md now carries the behavioral baseline as a managed marker block — keep project-specific guidance outside the markers.');
  if (mcpDirect.length || mcpGateway.length) {
    console.log('  10. (optional) wire up MCP servers — two connection paths: direct (claude mcp add) for remote-OAuth/local tools, or the Docker MCP gateway (/mcp-runtime) for keyed/third-party npx servers — secrets go to the OS keychain, never plaintext config. Details: ops/README.md → "Which way does a server connect?".');
    console.log('       direct:');
    for (const line of mcpDirect) console.log(line);
    console.log('       gateway:');
    for (const line of mcpGateway) console.log(line);
    console.log('       verify: claude mcp list for direct adds · docker mcp tools for the gateway');
  }
  console.log('  11. (optional) structural code graph: the mcp-graphify skill (.claude/skills/mcp-graphify) covers extract+serve setup for structural code questions (what-calls-X, blast-radius, symbol paths) via Graphify — a read-only external tool (`pip install graphifyy==0.9.10`), not installed by this installer; offered as an opt-in extra by the /respawn adoption interview.');
}
console.log('');
