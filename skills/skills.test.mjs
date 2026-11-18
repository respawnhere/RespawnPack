// RespawnPack skill-eval harness — Stage 1 (structural lint) + Stage 2 (trigger-collision detection).
// node:test + node:assert only (zero new dependencies), matching install/install.test.mjs's style.
//
// Design note (per the prior-art findings (theme T1), "(b) a concrete RespawnPack
// proposal"): Stage 1 checks the pack's own SKILL.md/SKILL.base.md content directly off disk — it never
// installs into a target repo, mirroring how install.test.mjs tests the installer's *output* rather than
// something the installer *ships*. The one exception is the cross-reference LINK check: RespawnPack's own
// install.js renames/flattens several source directories on the way into a target (`ops/mcp/<m>/` becomes
// `.claude/skills/mcp-<m>/`; `ops/<name>/` and `memory/knowledge/` become `.claude/skills/<name>/`), so a
// link that is correct against the SOURCE tree can be silently broken once installed, and vice versa. Rather
// than re-implement install.js's placement rules a second time here (a maintenance trap — the two copies
// would drift), this file runs the real installer once into a throwaway temp dir (same fs.mkdtempSync
// pattern install.test.mjs already uses) and resolves every link against THAT tree — the actual ground
// truth a target repo would see.
//
// Run:
//   node --test skills/skills.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const INSTALL_JS = path.join(ROOT, 'install', 'install.js');

// --- every shipped skill, per the task's file-placement list -------------------------------------------
// `installedName` is what the skill is actually called once install.js places it — for most sources that's
// just the source directory's basename, but ops/mcp/<m>/SKILL.base.md gets an `mcp-` prefix (install.js
// places it at `.claude/skills/mcp-<m>/`). The frontmatter `name` field is expected to equal this, not the
// raw source-directory basename, since that's the name the installed skill actually answers to.
const SKILL_SOURCES = [
  ...['respawn', 'loadout', 'build', 'review', 'playtest', 'walkthrough', 'ship', 'debug', 'secure', 'comply', 'savepoint', 'wordsmith', 'skill-guard', 'checkup', 'onboard', 'task', 'aar']
    .map((n) => ({ sourceDir: `skills/${n}`, sourceFile: 'SKILL.md', installedName: n })),
  ...['deploy-verify', 'db-ops', 'secrets-audit', 'infra-status']
    .map((n) => ({ sourceDir: `ops/${n}`, sourceFile: 'SKILL.md', installedName: n })),
  { sourceDir: 'memory/knowledge', sourceFile: 'SKILL.md', installedName: 'knowledge' },
  ...['context7', 'fly', 'github', 'graphify', 'runtime', 'security-audit', 'supabase']
    .map((m) => ({ sourceDir: `ops/mcp/${m}`, sourceFile: 'SKILL.base.md', installedName: `mcp-${m}` })),
];
assert.equal(SKILL_SOURCES.length, 29, 'the pack is documented as shipping 29 skills — update this list (and the memory index) if that count ever changes');

// --- frontmatter parsing (hand-rolled, no YAML lib — matches the pack's own zero-dependency stance) ------
// RespawnPack's frontmatter is `key: value` lines, one per line, between two `---` delimiters. `when_to_use`
// is a comma-separated list of double-quoted phrases on one line, not real YAML flow syntax, so this is a
// line-oriented parser rather than a YAML one, same reasoning as addyosmani/agent-skills' validate-skills.js.
function parseFrontmatter(content) {
  const lines = content.split(/\r?\n/);
  if (lines[0] !== '---') return null;
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') { end = i; break; }
  }
  if (end === -1) return null; // opening delimiter with no closing one — malformed
  const fm = {};
  for (let i = 1; i < end; i++) {
    const m = /^([A-Za-z0-9_-]+):\s?(.*)$/.exec(lines[i]);
    if (m) fm[m[1]] = m[2];
  }
  return { fm, bodyLineCount: lines.length - (end + 1) };
}

// Splits a `when_to_use` raw value into its individual quoted trigger phrases, trimmed and lower-cased for
// collision comparison. `"a", "b", "c"` -> ['a', 'b', 'c'].
function splitPhrases(when_to_use) {
  return [...(when_to_use || '').matchAll(/"([^"]*)"/g)].map((m) => m[1].trim());
}

// Load + parse every skill once, up front — every test below reads from this rather than re-parsing.
const SKILLS = SKILL_SOURCES.map((s) => {
  const filePath = path.join(ROOT, s.sourceDir, s.sourceFile);
  const content = fs.readFileSync(filePath, 'utf8');
  const parsed = parseFrontmatter(content);
  return { ...s, filePath, content, parsed };
});

// =========================================================================================================
// STAGE 1 — structural lint
// =========================================================================================================

test('[stage1] every skill\'s frontmatter parses and has non-empty name + description + when_to_use', () => {
  for (const sk of SKILLS) {
    assert.ok(sk.parsed, `${sk.installedName} (${sk.sourceDir}/${sk.sourceFile}): frontmatter must be a well-formed --- delimited block`);
    const { fm } = sk.parsed;
    assert.ok(fm.name && fm.name.length > 0, `${sk.installedName}: frontmatter must declare a non-empty name`);
    assert.ok(fm.description && fm.description.length > 0, `${sk.installedName}: frontmatter must declare a non-empty description`);
    assert.ok(fm.when_to_use && fm.when_to_use.length > 0, `${sk.installedName}: frontmatter must declare a non-empty when_to_use`);
  }
});

test('[stage1] name rules: matches installed name, kebab-case, <=64 chars, no claude/anthropic prefix', () => {
  const kebab = /^[a-z0-9]+(-[a-z0-9]+)*$/;
  for (const sk of SKILLS) {
    const name = sk.parsed.fm.name;
    assert.equal(name, sk.installedName, `${sk.sourceDir}: frontmatter name "${name}" must match the installed skill name "${sk.installedName}" (.claude/skills/${sk.installedName}/)`);
    assert.match(name, kebab, `${sk.installedName}: name must be kebab-case (lowercase letters/digits, hyphen-separated)`);
    assert.ok(name.length <= 64, `${sk.installedName}: name must be <=64 chars, got ${name.length}`);
    assert.doesNotMatch(name, /^(claude|anthropic)(-|$)/i, `${sk.installedName}: name must not start with a reserved "claude"/"anthropic" prefix`);
  }
});

test('[stage1] no angle brackets anywhere in frontmatter values (injection guard)', () => {
  // docs/research/claude-code-limits.md: frontmatter lands in the system prompt, so `<`/`>` is an injection
  // guard, not a style nit. One real violation (mcp-context7) was found and fixed by the 2026-07-10 audit;
  // this turns that one-off fix into a permanent regression guard.
  for (const sk of SKILLS) {
    for (const [key, value] of Object.entries(sk.parsed.fm)) {
      assert.doesNotMatch(String(value), /[<>]/, `${sk.installedName}: frontmatter field "${key}" must not contain "<" or ">" — found in "${value}"`);
    }
  }
});

test('[stage1] description <=1024 chars (validation-hub cap, distinct from the 1536 listing cap)', () => {
  for (const sk of SKILLS) {
    const len = sk.parsed.fm.description.length;
    assert.ok(len <= 1024, `${sk.installedName}: description is ${len} chars, must be <=1024`);
  }
});

// The post-trim house ceiling (docs/research/claude-code-limits.md, "Levers... since applied"). Nothing in
// the pack currently exceeds this — the list below is deliberately empty. If a future skill's combined
// description+when_to_use crosses 700 chars, either trim it back under 700, or add its exact installed name
// here with a comment explaining why the extra length earns its keep (a deliberate exemption, not a default).
const OVER_700_RATCHET_ALLOWLIST = [];

test('[stage1] combined description+when_to_use <=1536 hard cap; >700 requires an explicit ratchet entry', () => {
  for (const sk of SKILLS) {
    const combined = sk.parsed.fm.description.length + sk.parsed.fm.when_to_use.length;
    assert.ok(combined <= 1536, `${sk.installedName}: combined description+when_to_use is ${combined} chars, exceeds the hard 1536-char listing cap (Claude Code truncates past this)`);
    if (combined > 700) {
      assert.ok(OVER_700_RATCHET_ALLOWLIST.includes(sk.installedName), `${sk.installedName}: combined length ${combined} exceeds the 700-char house ceiling and is not in OVER_700_RATCHET_ALLOWLIST — trim it, or add it to the allowlist with a justification`);
    }
  }
});

test('[stage1] when_to_use carries at least 2 comma-separated trigger phrases (the WHEN, alongside description\'s WHAT)', () => {
  for (const sk of SKILLS) {
    const phrases = splitPhrases(sk.parsed.fm.when_to_use);
    assert.ok(phrases.length >= 2, `${sk.installedName}: when_to_use should list at least 2 trigger phrases, found ${phrases.length}`);
  }
});

test('[stage1] SKILL body size stays under the 500-line guidance (warning only, never fails the build)', (t) => {
  for (const sk of SKILLS) {
    if (sk.parsed.bodyLineCount >= 500) {
      t.diagnostic(`${sk.installedName}: body is ${sk.parsed.bodyLineCount} lines, at/over the <500-line guidance (guidance, not a hard limit — not failing this build)`);
    }
  }
  assert.ok(true); // this check is advisory-only by design; see docs/research/claude-code-limits.md
});

// --- cross-reference link resolution, checked against the real INSTALLED layout ------------------------
// See the file-header comment: install.js renames/flattens source directories on the way into a target
// (ops/mcp/<m>/ -> .claude/skills/mcp-<m>/, ops/<name>/ + memory/knowledge/ -> .claude/skills/<name>/), so
// this runs the real installer into a throwaway temp dir once, and resolves every relative markdown link in
// every installed SKILL.md/SKILL.base.md against that tree.
const LINK_CHECK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-skillstest-install-'));
// Fly/Supabase/security-audit are conditionally placed (install.js T2 gating) — seed the markers so all 25
// skills land, matching install.test.mjs's own "MCP server skills" fixture setup.
fs.writeFileSync(path.join(LINK_CHECK_DIR, 'fly.toml'), '# fly config\n');
fs.mkdirSync(path.join(LINK_CHECK_DIR, 'supabase'), { recursive: true });
fs.writeFileSync(path.join(LINK_CHECK_DIR, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0' }));
// library/ and docs/compliance/ are ALSO conditionally placed (P2-T-12: gated on compliance.config.md
// declaring a non-empty scope) — seed a declared scope so those land too, same reasoning as the three
// markers above: comply/SKILL.md's own cross-references to library/compliance/requirements/ and
// library/compliance/references/ are correct for a target that actually uses /comply (one that HAS
// declared a scope), and the link check should validate against that realistic, fully-populated tree
// rather than the no-scope default this fixture would otherwise leave those two trees absent from.
fs.writeFileSync(path.join(LINK_CHECK_DIR, 'compliance.config.md'), [
  '# link-check fixture — compliance scope',
  '',
  '## 4. Applicable frameworks (the resolved list)',
  '- **Default scope (almost always):** GDPR, CCPA',
  '- **Conditional/sector (triggered):** none',
  '- **Explicitly out of scope (and why):** n/a',
  '',
].join('\n'));
// B5: the onboarding mappers (codebase-mapper, docs-ingestor) that /onboard links to are opt-in agents,
// placed only when `extras: ["agents"]` is declared — the same shape this fixture already uses (markers +
// a compliance scope) to make conditionally-placed files land. A real /onboard target carries the bench,
// so declaring it here resolves those links against the tree a target running /onboard would actually see.
fs.writeFileSync(path.join(LINK_CHECK_DIR, 'respawnpack.config.json'), JSON.stringify({ extras: ['agents'] }, null, 2));
const linkCheckInstall = spawnSync(process.execPath, [INSTALL_JS, LINK_CHECK_DIR], { encoding: 'utf8' });
if (linkCheckInstall.status !== 0) {
  throw new Error(`skills.test.mjs: installer failed while priming the link-check fixture\n--- stdout ---\n${linkCheckInstall.stdout}\n--- stderr ---\n${linkCheckInstall.stderr}`);
}
after(() => fs.rmSync(LINK_CHECK_DIR, { recursive: true, force: true }));

// Known, pre-existing broken links (found by this suite, not introduced by it) — see the W4b build report.
// Each is `${relative installed path}::${literal link target}`. This allowlist may only SHRINK: fixing one of
// these links in the source skill removes its entry; it must never grow to cover a newly introduced break.
const KNOWN_BROKEN_LINKS = new Set([
  // Empty since the W4b wave-close fixed all five originally-found breaks (cross-category references
  // now use `/name` code spans or bare installed docs/ paths, valid in both layouts).
]);

// B5: the two /onboard mapper agents moved to the opt-in bench (extras:["agents"]); a DEFAULT install
// omits them, so a skill link to either is the one dangling agent link a default placement is allowed to
// leave. Both the [b5] default-placement pin and G10's knowledge link check except these by name, so each
// still proves default placement rather than hiding behind a full extras:["agents"] fixture.
const OPT_IN_MAPPER_LINKS = new Set(['codebase-mapper.md', 'docs-ingestor.md']);

function collectInstalledSkillFiles(installDir) {
  const skillsDir = path.join(installDir, '.claude', 'skills');
  const dirs = fs.readdirSync(skillsDir, { withFileTypes: true }).filter((e) => e.isDirectory());
  const files = [];
  for (const d of dirs) {
    const dirPath = path.join(skillsDir, d.name);
    const hasBase = fs.existsSync(path.join(dirPath, 'SKILL.base.md'));
    // When a frozen SKILL.base.md exists, the living SKILL.md starts as a byte-identical generated copy
    // (install.test.mjs asserts this) — checking both would just double-report the same link twice.
    files.push(path.join(dirPath, hasBase ? 'SKILL.base.md' : 'SKILL.md'));
  }
  return files;
}

test('[stage1] every relative markdown link in an installed skill body resolves to a real file', () => {
  const linkRe = /\[[^\]]*\]\(([^)]+)\)/g;
  const files = collectInstalledSkillFiles(LINK_CHECK_DIR);
  assert.ok(files.length >= 25, `expected at least 25 installed skill files (fly/supabase/security-audit seeded), found ${files.length}`);

  const newlyBroken = [];
  const knownStillPresent = new Set();
  for (const f of files) {
    const relPath = path.relative(LINK_CHECK_DIR, f).split(path.sep).join('/');
    const content = fs.readFileSync(f, 'utf8');
    let m;
    while ((m = linkRe.exec(content))) {
      const target = m[1];
      if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target)) continue; // external URI scheme (http/https/mailto/...) — not a local path
      const withoutAnchor = target.split('#')[0];
      if (!withoutAnchor) continue; // pure same-file anchor
      const resolved = path.resolve(path.dirname(f), withoutAnchor);
      if (!fs.existsSync(resolved)) {
        const key = `${relPath}::${target}`;
        if (KNOWN_BROKEN_LINKS.has(key)) knownStillPresent.add(key);
        else newlyBroken.push(`${relPath} -> ${target}`);
      }
    }
  }

  assert.deepEqual(newlyBroken, [], `new broken link(s) found (not in the pre-existing KNOWN_BROKEN_LINKS allowlist):\n${newlyBroken.join('\n')}`);

  // Keep the allowlist honest: an entry that's no longer broken (because someone fixed the source link)
  // must be removed, not left stale — otherwise a *different* new break at the same coordinates could hide
  // behind it undetected.
  const stale = [...KNOWN_BROKEN_LINKS].filter((k) => !knownStillPresent.has(k));
  assert.deepEqual(stale, [], `KNOWN_BROKEN_LINKS entry no longer reproduces as broken — remove it from the allowlist:\n${stale.join('\n')}`);
});

// --- B5: default-placement link integrity ----------------------------------------------------------------
// The link check above declares extras:["agents"], so it resolves links against all 32 agents. This pins
// the OTHER state: on a pure six-lens default install (no extras, no stack markers), no placed skill may
// link an agent that is not installed. The two onboard mappers are documented opt-in (extras:["agents"])
// and are the only agent links a default install is allowed to leave dangling, so they are excepted by name.
test('[b5] no default-placed skill links an absent agent (the onboard opt-in mappers excepted by name)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-b5-default-links-'));
  const r = spawnSync(process.execPath, [INSTALL_JS, dir], { encoding: 'utf8' }); // bare target: no config, no markers
  if (r.status !== 0) throw new Error(`installer failed priming the default-links fixture\n${r.stdout}\n${r.stderr}`);
  const linkRe = /\[[^\]]*\]\(([^)]+)\)/g;
  const dangling = [];
  for (const f of collectInstalledSkillFiles(dir)) {
    const content = fs.readFileSync(f, 'utf8');
    let m;
    while ((m = linkRe.exec(content))) {
      const target = m[1].split('#')[0];
      if (!/(^|\/)agents\//.test(target)) continue; // only agent links are in scope for this pin
      if (OPT_IN_MAPPER_LINKS.has(target.split('/').pop())) continue; // documented opt-in, placed only with extras:["agents"]
      if (!fs.existsSync(path.resolve(path.dirname(f), target))) {
        dangling.push(`${path.relative(dir, f).split(path.sep).join('/')} -> ${target}`);
      }
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });
  assert.deepEqual(dangling, [], `a default install leaves a skill linking an absent agent (only the onboard opt-in mappers may):\n${dangling.join('\n')}`);
});

// --- the aggregate listing-budget ratchet (the novel, RespawnPack-specific guard) -----------------------
// docs/research/claude-code-limits.md measured the pack's total model-visible listing payload (every
// skill's description+when_to_use, EXCLUDING skills flagged disable-model-invocation, which never enter the
// model-routed listing at all) at ~10,376 chars post-W4a-trim, against a runtime skill-listing context
// budget whose default proxy is ~8,000 chars — already tight. This is a tighten-only ratchet, same pattern
// as gsd-core's assertTightCeiling: the ceiling below may be LOWERED as the pack trims further, but must
// never be RAISED to accommodate new bloat — a real increase needs a deliberate lever (see the "Levers"
// section of claude-code-limits.md), not a quiet ceiling bump here.
// B5 (2026-10-09): the default skill set is now the ten model-invocable roles (respawn, savepoint, loadout,
// build, review, ship, debug, task, secure, comply); every other shipped skill carries
// disable-model-invocation (command-only, reached by its slash command) and never enters this aggregate.
// That drops the measured payload from 10,336 to 4,024. The ceiling is lowered to 4,096 (the ~4 KB
// model-visible cap the obsolescence review set as the goal), still tighten-only: trim further or move a
// skill off the listing to lower it, never raise it to admit new bloat.
const AGGREGATE_LISTING_BUDGET_CEILING = 4096; // measured 4024 (2026-10-09, this suite's own measurement) — the ten model-invocable roles only

test('[stage1] aggregate model-visible listing payload stays under the committed, tighten-only ceiling', () => {
  let total = 0;
  const contributions = [];
  for (const sk of SKILLS) {
    if (sk.parsed.fm['disable-model-invocation'] === 'true') continue; // never enters the model-routed listing
    const combined = sk.parsed.fm.description.length + sk.parsed.fm.when_to_use.length;
    total += combined;
    contributions.push({ name: sk.installedName, combined });
  }
  contributions.sort((a, b) => b.combined - a.combined);
  const top5 = contributions.slice(0, 5).map((c) => `${c.name}=${c.combined}`).join(', ');
  assert.ok(
    total <= AGGREGATE_LISTING_BUDGET_CEILING,
    `aggregate model-visible listing payload is ${total} chars, exceeds the committed ceiling of ${AGGREGATE_LISTING_BUDGET_CEILING}. ` +
    `This is the pack's own already-documented listing-budget overflow risk (docs/research/claude-code-limits.md) — lower it by trimming a ` +
    `when_to_use/description, flipping a low-routing-value skill to disable-model-invocation, or gate it behind a stack condition; do not ` +
    `raise this ceiling to make the assertion pass. Top contributors: ${top5}`
  );
});

// --- B5: the model-invocable set is EXACTLY the ten default roles ----------------------------------------
const MODEL_INVOCABLE_TEN = [
  'respawn', 'savepoint', 'loadout', 'build', 'review', 'ship', 'debug', 'task', 'secure', 'comply',
];

test('[b5] exactly the ten named roles are model-invocable; every other shipped skill is command-only', () => {
  const modelInvocable = SKILLS
    .filter((sk) => sk.parsed.fm['disable-model-invocation'] !== 'true')
    .map((sk) => sk.installedName)
    .sort();
  assert.deepEqual(modelInvocable, [...MODEL_INVOCABLE_TEN].sort(),
    `the model-invocable set must be exactly the ten default roles. A non-default skill that loses ` +
    `disable-model-invocation re-enters the listing (and the aggregate budget) and fails here; one of the ` +
    `ten that gains the flag disappears from the model's reach and also fails here. Got: ${modelInvocable.join(', ')}`);
});

test('[b5] the respawn bootstrap sentence names the command-only skills in its model-visible description', () => {
  // One skill's model-visible description tells the model the other skills exist as commands and how to
  // list them, so a lost or truncated description never hides a capability. respawn is that skill — it is
  // the one every session reads first. Pinned at the sentence level: dropping it fails here.
  const respawn = SKILLS.find((sk) => sk.installedName === 'respawn');
  assert.match(respawn.parsed.fm.description, /install as slash commands/i,
    'respawn must tell the model the other pack skills exist as slash commands');
  assert.match(respawn.parsed.fm.description, /type \/ to list them|\.claude\/skills\//,
    'respawn must tell the model how to list the command-only skills');
});

// --- B5: the default agents listing stays under 2.5 KB ---------------------------------------------------
// The host lists an installed agent by its frontmatter `description`. B5 makes the default placed set the
// six review lenses only; the other 26 agents opt in through respawnpack.config.json's `extras: ["agents"]`.
// This measures the DEFAULT set's listing the same way the skill aggregate above measures skills: a
// tighten-only ceiling with the measured number beside it. install.test.mjs pins which files the installer
// actually places; this pins the set by name and its byte cost.
const AGENTS_DIR = path.join(ROOT, 'agents');
const AGENT_DEFAULT_LENSES = [
  'correctness-reviewer', 'maintainability-reviewer', 'performance-reviewer',
  'security-reviewer', 'design-reviewer', 'spine-consistency-reviewer',
].sort();
const AGENTS_DEFAULT_LISTING_CEILING = 2560; // measured 2108 (2026-10-09) — the six review lenses' descriptions

test('[b5] the default agents (the six review lenses) exist and their listing stays under the tighten-only ceiling', () => {
  let total = 0;
  for (const name of AGENT_DEFAULT_LENSES) {
    const fp = path.join(AGENTS_DIR, `${name}.md`);
    assert.ok(fs.existsSync(fp), `${name}.md must exist in agents/ — it is a default review lens`);
    const parsed = parseFrontmatter(fs.readFileSync(fp, 'utf8'));
    assert.ok(parsed && parsed.fm.description, `${name}: must declare a frontmatter description`);
    total += parsed.fm.description.length;
  }
  assert.ok(total <= AGENTS_DEFAULT_LISTING_CEILING,
    `the default agents listing is ${total} bytes, over the tighten-only ceiling of ${AGENTS_DEFAULT_LISTING_CEILING} ` +
    `(2.5 KB). Trim a lens description to lower it; do not raise the ceiling.`);
});

// =========================================================================================================
// STAGE 2 — trigger-collision detection
// =========================================================================================================

// Known, pre-existing exact-phrase collisions (found by this suite, not sanctioned aliases the spec names).
// Each entry is the normalized phrase plus the exact pair of installed skill names that share it. This
// allowlist may only SHRINK: a fix (dropping the phrase from one of the two skills) removes its entry; it
// must never grow to cover a newly introduced collision, including a third skill later adding either phrase.
const KNOWN_EXACT_PHRASE_COLLISIONS = [
  // Empty since the W4b wave-close fixed both originally-found collisions ("ship" dropped from
  // mcp-github, "/secure" dropped from mcp-security-audit — each phrase kept by its canonical owner).
];

test('[stage2] no when_to_use trigger phrase is claimed by two different skills', () => {
  const phraseOwners = new Map(); // normalized phrase -> [installedName, ...]
  for (const sk of SKILLS) {
    const phrases = splitPhrases(sk.parsed.fm.when_to_use);
    const seenInThisSkill = new Set();
    for (const raw of phrases) {
      const norm = raw.toLowerCase();
      if (seenInThisSkill.has(norm)) continue; // a skill repeating its own phrase isn't a cross-skill collision
      seenInThisSkill.add(norm);
      if (!phraseOwners.has(norm)) phraseOwners.set(norm, []);
      phraseOwners.get(norm).push(sk.installedName);
    }
  }

  const newCollisions = [];
  const knownStillPresent = new Set();
  for (const [phrase, owners] of phraseOwners) {
    if (owners.length < 2) continue;
    const pairKey = [...owners].sort().join('+');
    const known = KNOWN_EXACT_PHRASE_COLLISIONS.find((k) => k.phrase === phrase && k.skills.join('+') === pairKey);
    if (known) knownStillPresent.add(known);
    else newCollisions.push(`"${phrase}" claimed by: ${owners.join(', ')}`);
  }

  assert.deepEqual(newCollisions, [], `new exact-phrase when_to_use collision(s), not in KNOWN_EXACT_PHRASE_COLLISIONS:\n${newCollisions.join('\n')}`);

  const stale = KNOWN_EXACT_PHRASE_COLLISIONS.filter((k) => !knownStillPresent.has(k));
  assert.deepEqual(stale, [], `KNOWN_EXACT_PHRASE_COLLISIONS entry no longer collides — remove it: ${JSON.stringify(stale)}`);
});

// --- TF-IDF + cosine similarity, hand-rolled (no deps), per the spec's addyosmani-derived approach --------
const STOPWORDS = new Set(['the', 'a', 'an', 'of', 'to', 'for', 'and', 'or', 'in', 'on', 'is', 'this', 'that', 'via', 'with', 'from', 'its', 'it', 'be', 'as', 'are', 'not', 'never', 'always', 'role', 'skill']);

function tokenize(text) {
  return (text.toLowerCase().match(/[a-z0-9]+/g) || []).filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

// Builds a TF-IDF vector (Map<term, weight>) per document, using smoothed IDF (ln((1+N)/(1+df)) + 1, the
// same smoothing scikit-learn's TfidfVectorizer defaults to) so a term appearing in every document doesn't
// divide by zero and still contributes a small positive weight.
function buildTfidfVectors(tokenizedDocs) {
  const N = tokenizedDocs.length;
  const df = new Map();
  for (const tokens of tokenizedDocs) {
    for (const t of new Set(tokens)) df.set(t, (df.get(t) || 0) + 1);
  }
  const idf = (t) => Math.log((1 + N) / (1 + (df.get(t) || 0))) + 1;
  return tokenizedDocs.map((tokens) => {
    const tf = new Map();
    for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
    const vec = new Map();
    for (const [t, c] of tf) vec.set(t, (c / tokens.length) * idf(t));
    return vec;
  });
}

function cosineSimilarity(v1, v2) {
  let dot = 0, n1 = 0, n2 = 0;
  for (const [t, w] of v1) { n1 += w * w; if (v2.has(t)) dot += w * v2.get(t); }
  for (const [, w] of v2) n2 += w * w;
  if (n1 === 0 || n2 === 0) return 0;
  return dot / (Math.sqrt(n1) * Math.sqrt(n2));
}

const SIMILARITY_WARN_THRESHOLD = 0.50;
const SIMILARITY_ERROR_THRESHOLD = 0.75;
// No pair currently reaches even the warn threshold (highest measured: secure <-> mcp-security-audit at
// ~0.40, which is expected — mcp-security-audit is documented as "the JS/npm leg of /secure"). Add an entry
// here (as a sorted 2-name array) only with a reviewed, deliberate reason if a future pair crosses error.
const ALLOWED_SIMILAR_PAIRS = [];

test('[stage2] no pair of skills has near-duplicate description+when_to_use text (TF-IDF cosine similarity)', (t) => {
  const tokenizedDocs = SKILLS.map((sk) => tokenize(`${sk.parsed.fm.description} ${sk.parsed.fm.when_to_use}`));
  const vectors = buildTfidfVectors(tokenizedDocs);

  const newErrors = [];
  for (let i = 0; i < SKILLS.length; i++) {
    for (let j = i + 1; j < SKILLS.length; j++) {
      const sim = cosineSimilarity(vectors[i], vectors[j]);
      if (sim < SIMILARITY_WARN_THRESHOLD) continue;
      const pairKey = [SKILLS[i].installedName, SKILLS[j].installedName].sort().join('+');
      if (sim >= SIMILARITY_ERROR_THRESHOLD) {
        const allowed = ALLOWED_SIMILAR_PAIRS.some((p) => [...p].sort().join('+') === pairKey);
        if (!allowed) newErrors.push(`${SKILLS[i].installedName} <-> ${SKILLS[j].installedName}: ${(sim * 100).toFixed(1)}%`);
      } else {
        t.diagnostic(`similarity watch (${(sim * 100).toFixed(1)}%, below the ${SIMILARITY_ERROR_THRESHOLD * 100}% error line): ${SKILLS[i].installedName} <-> ${SKILLS[j].installedName}`);
      }
    }
  }

  assert.deepEqual(newErrors, [], `pair(s) at/above ${SIMILARITY_ERROR_THRESHOLD * 100}% cosine similarity, not in ALLOWED_SIMILAR_PAIRS:\n${newErrors.join('\n')}`);
});

// =========================================================================================================
// STAGE 3: field-feedback G13 - two operational rules carried by the acting skills
// =========================================================================================================
// the 2026-10-05 field report: a long mutation (apply, migration, build, publish) runs
// in the background and is polled, never killed in the foreground; an out-of-band step (a deploy, a
// dashboard change, a published page) is recorded OPEN with a named recheck until independently re-checked.
// behavior-standards.md carries the rule for a bare session (pinned in kernel.test.mjs); the three acting
// skills carry it in role. Pins are sentence-level, not word-level: a skill that drops the kill clause or
// the refusal fails here.
const skillByName = (name) => SKILLS.find((s) => s.installedName === name);

test('[g13] build, task and ship each carry the long-mutation rule (background + polled, never a foreground kill)', () => {
  for (const name of ['build', 'task', 'ship']) {
    const sk = skillByName(name);
    assert.ok(sk, `${name}: expected this skill to be in SKILL_SOURCES`);
    assert.match(sk.content, /background/i, `${name}: must say a long mutation runs in the background`);
    assert.match(sk.content, /poll/i, `${name}: must say the background mutation is polled`);
    assert.match(sk.content, /never killed in the foreground/i,
      `${name}: must forbid the foreground kill, not merely prefer the background`);
  }
});

test('[g13] build, task and ship each pin the OPEN (out-of-band): recording convention with a named recheck', () => {
  for (const name of ['build', 'task', 'ship']) {
    const sk = skillByName(name);
    assert.match(sk.content, /OPEN \(out-of-band\):/, `${name}: must carry the literal recording convention, so dropping it fails here`);
    assert.match(sk.content, /recheck/i, `${name}: the out-of-band record names an independent recheck`);
  }
});

test("[g13] ship's pre-ship gate refuses while any OPEN (out-of-band) item exists, naming where it reads them", () => {
  const ship = skillByName('ship');
  // nearest bypass: a ship that lists the convention but never REFUSES on it must fail this pin
  assert.match(ship.content, /refuse/i, 'ship must refuse to proceed while an OPEN out-of-band item exists');
  assert.match(ship.content, /wave-ledger\.md/, 'ship must say it reads the wave ledger for OPEN items');
  assert.match(ship.content, /CONTINUITY\.md/, 'ship reads CONTINUITY.md when there is no ledger');
});

// D2 · a review's verdict is a fact about the tree it judged. /review records a receipt binding the
// verdict to HEAD + the working tree; /ship re-checks it and refuses a stale or absent one. Pins are
// sentence-level: a skill that mentions the verb but never binds the verdict to the tree, or never
// REFUSES on a stale one, fails here.
test('[d2] /review records a tree-bound receipt and /ship refuses a stale or absent one', () => {
  const review = skillByName('review');
  const ship = skillByName('ship');
  assert.match(review.content, /review-receipt --write/, 'review Step 4 must record the receipt through the verb');
  assert.match(review.content, /re-review/i, 'review must say fixing findings moves the tree, so a re-review writes a fresh receipt');
  // project-type neutrality (owner feedback 2026-09-03): a review judges a tree, not only code.
  assert.match(review.content, /infrastructure manifest/i, 'review must name a non-code tree so the receipt reads as project-type neutral');
  assert.match(ship.content, /review-receipt --check/, 'ship Step 1 must run the freshness check through the verb');
  // nearest bypass: a ship that runs the check but proceeds anyway must fail this pin.
  assert.match(ship.content, /FAIL or CANNOT_DETERMINE|refuse[^.]*FAIL[^.]*CANNOT_DETERMINE/i,
    'ship must refuse on FAIL or CANNOT_DETERMINE, not merely run the check');
});

test('[A7] the /respawn skill carries the routing instruction the SessionStart hook dropped', () => {
  // A7 retired the boot routing paragraph on the assumption the skill carries it; this pins that
  // assumption from the skills side so the sentence cannot be lost without the skills fence noticing.
  const respawn = skillByName('respawn');
  assert.ok(respawn, 'the respawn skill is missing from SKILL_SOURCES');
  assert.match(respawn.content, /no slash command is required/i,
    'the /respawn skill lost the folded routing sentence; session-routing-nudge.js dropped it on the assumption the skill carries it (A7)');
  assert.match(respawn.content, /describe the goal in prose/i,
    'the /respawn skill lost the describe-the-goal-in-prose half of the folded routing instruction');
});

// =========================================================================================================
// STAGE 4: field-feedback G10 - a project's own writing rules win, and the three enforcement mechanics
// =========================================================================================================
// the 2026-10-05 field report: /wordsmith read only the shipped writing-standards.md, so a document
// project's 46-rule versioned wordsmith-rules.md (six direct conflicts with the shipped file, a gate
// script, a different-agent reader pass) had no mechanism in the pack. These pins put the precedence and
// the three mechanics in the skill's LOADED TEXT (sentence-level, so dropping one fails here). Three
// states: the original defect (the skill names only the shipped standard) fails these; the corrected skill
// passes; the nearest bypass (an unversioned file applied but not reported so, or a [script] rule silently
// treated as enforced) fails the `unversioned`/`unenforced` pins below, which demand those exact words.
// The installer half (a knowledge install lays no coding-standards.md) is in install/install.test.mjs.

test('[g10] /wordsmith loads a project rules file and a project rule wins over the shipped default', () => {
  const w = skillByName('wordsmith');
  assert.ok(w, 'the wordsmith skill is missing from SKILL_SOURCES');
  // precedence: the project's rule wins, from one of exactly two locations
  assert.match(w.content, /the project'?s rule wins/i, 'wordsmith must state the project rule wins over the shipped default');
  assert.match(w.content, /docs\/reference\/wordsmith-rules\.md/, 'wordsmith must name the docs/reference/wordsmith-rules.md location');
  assert.match(w.content, /\.claude\/rules\/writing\*\.md/, 'wordsmith must name the .claude/rules/writing*.md location (B4)');
  assert.match(w.content, /highest `?version:?`?/i, 'wordsmith must say the highest version wins among the rules files');
  // Step 1 announces what it applied, so the reader can see which rule won
  assert.match(w.content, /no project rules file[^.]*applying the shipped/i,
    'wordsmith must say that with no rules file the shipped standard applies, and announce it at Step 1');
});

test('[g10] /wordsmith pins the three enforcement mechanics and the different-agent reader pass', () => {
  const w = skillByName('wordsmith');
  assert.match(w.content, /versioned rule file/i, 'mechanic 1: a versioned rule file whose version grows');
  for (const tag of ['\\[script\\]', '\\[reader\\]', '\\[both\\]']) {
    assert.match(w.content, new RegExp(tag), `mechanic 2: the per-rule ${tag.replace(/\\/g, '')} tag must be named`);
  }
  // nearest bypass: a [script] rule with no wired gate must be reported unenforced, not assumed caught
  assert.match(w.content, /unenforced/i, 'mechanic 2: a [script] rule with no gate is reported unenforced, not silently treated as enforced');
  assert.match(w.content, /never signs off its own prose/i, 'mechanic 3: the writer never signs off its own prose');
  assert.match(w.content, /reader pass[\s\S]*subagent|subagent[\s\S]*reader pass/i, 'the reader pass dispatches to a different agent');
  // nearest bypass: an unversioned file is applied but reported as unversioned and loses to a versioned one
  assert.match(w.content, /unversioned/i, 'an unversioned rules file is reported as unversioned');
  assert.match(w.content, /ignored/i, 'a rules file outside the two locations is ignored (and named), not loaded');
});

test('[g10] /review carries the one-sentence prose lens with the same precedence', () => {
  const r = skillByName('review');
  assert.match(r.content, /prose lens/i, 'review must carry a prose lens sentence');
  assert.match(r.content, /wordsmith-rules\.md|\.claude\/rules\/writing\*\.md/, 'the prose lens must name the project rules file location');
  assert.match(r.content, /say which file (you |it )?applied/i, 'the prose lens must say which file it applied');
});

test('[g10] the shipped writing-standards.md marks itself the default a project overrides', () => {
  // The skills fence reads the SOURCE standard (install.test.mjs proves it is placed), so the sentence
  // cannot be removed without a test noticing, the bypass the brief names.
  const std = fs.readFileSync(path.join(ROOT, 'spine', 'reference', 'writing-standards.md'), 'utf8');
  assert.match(std, /the default a project overrides/i,
    'writing-standards.md must say it is the default a project overrides through a rules file');
});

// --- the link check passes for a knowledge target too (the software standards it omits are cited as code
// spans, not markdown links; living-skills.md, which skill-guard markdown-links, is kept) ----------------
const KNOWLEDGE_LINK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-skillstest-knowledge-'));
fs.writeFileSync(path.join(KNOWLEDGE_LINK_DIR, 'fly.toml'), '# fly config\n');
fs.mkdirSync(path.join(KNOWLEDGE_LINK_DIR, 'supabase'), { recursive: true });
fs.writeFileSync(path.join(KNOWLEDGE_LINK_DIR, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0' }));
fs.writeFileSync(path.join(KNOWLEDGE_LINK_DIR, 'compliance.config.md'), [
  '# link-check fixture — compliance scope', '', '## 4. Applicable frameworks (the resolved list)',
  '- **Default scope (almost always):** GDPR, CCPA', '- **Conditional/sector (triggered):** none',
  '- **Explicitly out of scope (and why):** n/a', '',
].join('\n'));
const knowledgeInstall = spawnSync(process.execPath, [INSTALL_JS, KNOWLEDGE_LINK_DIR, '--project-type', 'knowledge'], { encoding: 'utf8' });
if (knowledgeInstall.status !== 0) {
  throw new Error(`skills.test.mjs: installer failed priming the knowledge link-check fixture\n${knowledgeInstall.stdout}\n${knowledgeInstall.stderr}`);
}
after(() => fs.rmSync(KNOWLEDGE_LINK_DIR, { recursive: true, force: true }));

test('[g10] every installed skill link still resolves on a knowledge target (the six software standards are omitted)', () => {
  // a knowledge install omits coding/testing/performance/observability/design/skill-authoring; this proves
  // no installed skill markdown-LINKS one of them (they are cited as code spans, which the resolver skips).
  assert.ok(!fs.existsSync(path.join(KNOWLEDGE_LINK_DIR, 'docs', 'reference', 'coding-standards.md')),
    'the knowledge fixture must actually omit coding-standards.md, or this test is not measuring the omission');
  const linkRe = /\[[^\]]*\]\(([^)]+)\)/g;
  const files = collectInstalledSkillFiles(KNOWLEDGE_LINK_DIR);
  const broken = [];
  for (const f of files) {
    const content = fs.readFileSync(f, 'utf8');
    let m;
    while ((m = linkRe.exec(content))) {
      const target = m[1];
      if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target)) continue;
      const withoutAnchor = target.split('#')[0];
      if (!withoutAnchor) continue;
      if (OPT_IN_MAPPER_LINKS.has(withoutAnchor.split('/').pop())) continue; // B5: /onboard's mapper links are the opt-in bench (extras:["agents"]); a default knowledge install omits them, same rule as the [b5] pin
      if (!fs.existsSync(path.resolve(path.dirname(f), withoutAnchor))) {
        broken.push(`${path.relative(KNOWLEDGE_LINK_DIR, f).split(path.sep).join('/')} -> ${target}`);
      }
    }
  }
  assert.deepEqual(broken, [], `installed skill link(s) broken on a knowledge target: cite an omitted standard as a code span, not a markdown link:\n${broken.join('\n')}`);
});

// Honest degradation is grep-driven, not a hand-maintained list: every shipped skill that cites one of the
// six software standards a knowledge/docs-only install omits must also carry the absent guard (say the file
// is not on disk and skip, never grade from memory), so a FUTURE citation added without the guard fails
// here. The six stems are install.js's SOFTWARE_STANDARDS set. A skill citing only `living-skills` (kept
// for every type) or no standard is not required to carry it.
const G10_SOFTWARE_STANDARD_STEMS = [
  'coding-standards', 'testing-standards', 'performance-standards',
  'observability-basics', 'design-standards', 'skill-authoring-standards',
];
test('[g10] every skill citing one of the six omitted software standards carries the not-on-disk absent guard', () => {
  const missing = [];
  for (const sk of SKILLS) {
    const cites = G10_SOFTWARE_STANDARD_STEMS.some((stem) => new RegExp(`docs/reference/${stem}\\b`).test(sk.content));
    if (!cites) continue;
    // the guard's signature phrase plus a degrade verb, so a skill that merely names a file is not enough
    const guarded = /not on disk/i.test(sk.content) && /(skip|not[- ]applicable|not placed|grading from memory)/i.test(sk.content);
    if (!guarded) missing.push(sk.installedName);
  }
  assert.deepEqual(missing, [], `these skills cite a software standard a knowledge install omits but lack the absent guard; add "... not on disk (a knowledge/docs-only target omits it), say so and skip ...": ${missing.join(', ')}`);
});

test('[C3] no shipped skill names the retired memory engine or its MCP tools', () => {
  // The memory engine and --with-memory were retired (decision 33). The shipped skills named its tools
  // (memory_query, memory_recall, memory_lessons) and the respawn-memory server as a backend; those
  // clauses are gone and the file backend (memory/graph + grep) is the one the skills name. The nearest
  // bypass — a skill that still tells a session to call the engine — must fail here, because an agent
  // following it on a target that no longer has the engine gets nothing.
  const banned = /memory_query|memory_recall|memory_lessons|memory_add_observation|add_observations|memory_remember|create_entities|memory_spine_sync|respawn-memory engine|the memory engine|--with-memory/;
  // G18 · the engine's spine-sync tool joins the banned set; it was omitted, so a skill naming it slipped
  // through. The known-bad control proves the fence detects it before the shipped skills are checked.
  assert.match('a session should call memory_spine_sync here', banned,
    'the fence does not catch memory_spine_sync; a skill naming the retired engine tool would pass over it');
  for (const sk of SKILLS) {
    assert.doesNotMatch(sk.content, banned,
      `${sk.installedName} still names the retired memory engine or its tools — name the file backend (memory/graph + grep) instead`);
  }
});

test('[B1] the /respawn skill states the 8k-token boot budget, reads killed features from STATE.json, and drops the whole-DECISIONS read', () => {
  // The budget sentence, the Step 1 reorientation, and the Step 2 verb are what keep the boot set small;
  // removing any of them fails here, which is the skills-fence half of B1's three states.
  const respawn = skillByName('respawn');
  assert.match(respawn.content, /8,000 tokens/, 'the /respawn skill lost the 8k-token boot budget sentence');
  assert.match(respawn.content, /counted as bytes[\s\S]{0,20}divided by four/i,
    'the budget must state the bytes-over-four token proxy, not just a token count');
  assert.match(respawn.content, /STATE\.json[^\n]{0,12}killedFeatures/i,
    'Step 1 must read the killed features from STATE.json killedFeatures, already loaded in Step 0');
  assert.match(respawn.content, /removals\.json/,
    'Step 1 must still name the removals registry for a row\'s guarded phrases');
  assert.match(respawn.content, /Do not read[^\n]*DECISIONS\.md[^\n]*whole/i,
    'Step 1 must say docs/DECISIONS.md is not read whole at boot — the fastest-growing read B1 removes');
  assert.match(respawn.content, /doctor --onboarding/,
    'Step 2 must read the onboarding projection (doctor --onboarding), not the full doctor --json');
});

test('[D3] Step 0 reads docs/derived/HANDOFF.md FIRST, before CONTINUITY', () => {
  // The D3 done-when: /respawn Step 0 reads HANDOFF.md before CONTINUITY. The handoff is the pointer-first
  // summary a fresh session needs first; CONTINUITY's note is the operator prose it points at. Pinned by
  // position so a later edit that reorders them (or drops the handoff) fails here.
  const respawn = skillByName('respawn');
  const handoffAt = respawn.content.indexOf('docs/derived/HANDOFF.md');
  const continuityAt = respawn.content.indexOf('docs/derived/CONTINUITY.md');
  assert.ok(handoffAt >= 0, 'the /respawn skill does not name docs/derived/HANDOFF.md at all');
  assert.ok(continuityAt >= 0, 'the /respawn skill does not name docs/derived/CONTINUITY.md');
  assert.ok(handoffAt < continuityAt, 'Step 0 must read HANDOFF.md before CONTINUITY.md (the D3 done-when)');
  assert.match(respawn.content, /pointer-first handoff/i, 'the skill must describe HANDOFF.md as the pointer-first handoff');
});

// =========================================================================================================
// STAGE 5: C5 - the three acting skills are thin wrappers over the host's native commands (decision 48)
// =========================================================================================================
// /review, /secure and /playtest re-implemented in prose what the host now ships (/code-review,
// /security-review + the security-guidance plugin, /verify, /run). C5 makes each a THIN WRAPPER: it names
// its host command, keeps only the pack's own steps, and attributes nothing to the host that the
// obsolescence review's notes (OBSOLESCENCE-REVIEW.md §2/§3) do not list. Three states, per the brief:
//   defect  — /review names the five generic lens agents as fan-out steps (the host carries them now);
//   correct — each skill names its host command and keeps its pack-only steps by name (the review receipt,
//             /secrets-audit + SBOM + MCP advisories, the regression-test-per-commit rule);
//   bypass  — dropping the receipt or the spine lens, or attributing to the host a /command the notes do
//             not list, fails here.
// The pins read the real skills off disk (the correction). The defect and the bypass are exercised against
// the SAME predicates with synthetic samples, so all three states are proven, not just the happy path.

// The pack's own slash commands ARE exactly the installed skill names; a thin-wrapper skill may name a
// NON-pack slash command only from the host vocabulary the obsolescence review attributes to the host.
// Naming any other /command as the host's invents a capability the notes do not support.
const PACK_COMMANDS = new Set(SKILLS.map((s) => `/${s.installedName}`));
const ALLOWED_HOST_COMMANDS = new Set(['/code-review', '/security-review', '/verify', '/run']);
const C5_GENERIC_LENS_AGENTS = ['correctness-reviewer', 'security-reviewer', 'performance-reviewer', 'maintainability-reviewer', 'design-reviewer'];

// Body with the frontmatter stripped — so when_to_use aliases like "/qa" are never read as host-command
// claims (they are prose-routing triggers, not statements about the host).
function c5Body(content) {
  const m = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/);
  return m ? m[1] : content;
}
// Slash-command tokens in a body. The lookbehind excludes path segments (`agents/foo.md`, `docs/ref/...`,
// URLs): a real slash command is preceded by whitespace, a backtick or a bracket, never a word char, dot,
// slash or hyphen.
function c5SlashCommands(body) {
  return new Set([...body.matchAll(/(?<![\w./-])\/[a-z][a-z0-9-]+/g)].map((m) => m[0]));
}
function c5AttributesUnlistedHostCommand(body) {
  for (const cmd of c5SlashCommands(body)) {
    if (!PACK_COMMANDS.has(cmd) && !ALLOWED_HOST_COMMANDS.has(cmd)) return true;
  }
  return false;
}
const c5FansOutGenericLenses = (body) => C5_GENERIC_LENS_AGENTS.some((id) => body.includes(id));
const c5KeepsReceipt = (body) => /review-receipt --write/.test(body);
const c5NamesSpine = (body) => /spine-consistency-reviewer/.test(body);

test('[c5] /review delegates the generic lenses to /code-review and fans out only the spine lens (defect/correct/bypass)', () => {
  const body = c5Body(skillByName('review').content);
  // correction: the real skill names /code-review and fans out only the spine lens
  assert.ok(!c5FansOutGenericLenses(body),
    '/review still names a generic lens agent (correctness/security/performance/maintainability/design-reviewer) as a step — those are the host\'s /code-review now (C5)');
  assert.ok(c5NamesSpine(body), '/review must still name and fan out the spine-consistency lens (the one lens the host has no equivalent for)');
  assert.match(body, /\/code-review/, '/review must name the host command it delegates the generic lenses to');
  // the differentiator agent must still exist on disk and be the one /review names
  assert.ok(fs.existsSync(path.join(AGENTS_DIR, 'spine-consistency-reviewer.md')),
    'agents/spine-consistency-reviewer.md must still exist — C5 keeps exactly this lens');
  // defect state: the pre-C5 skill named all six lens agents as fan-out steps — the predicate trips on it
  const DEFECT = 'Step 2 — Fan out lenses: correctness-reviewer, security-reviewer, performance-reviewer, maintainability-reviewer, design-reviewer, spine-consistency-reviewer.';
  assert.ok(c5FansOutGenericLenses(DEFECT), 'the defect sample (all six lens agents as steps) must trip the fan-out fence');
  // bypass state: re-adding even one generic lens agent as a step fails
  assert.ok(c5FansOutGenericLenses(body + '\nAlso fan out the correctness-reviewer agent.'),
    'the bypass sample (one generic lens agent re-added as a step) must trip the fan-out fence');
});

test('[c5] each thin-wrapper skill names its host command once and keeps its pack-only steps by name', () => {
  const review = c5Body(skillByName('review').content);
  const secure = c5Body(skillByName('secure').content);
  const playtest = c5Body(skillByName('playtest').content);
  // /review keeps the receipt (the pack's own fact about the tree it judged)
  assert.match(review, /\/code-review/, '/review names its host command /code-review');
  assert.ok(c5KeepsReceipt(review), '/review keeps the review-receipt --write step');
  // /secure keeps the secrets delegation, the dependency/SBOM legs, the LLM lens and the MCP advisories
  assert.match(secure, /\/security-review/, '/secure names its host command /security-review');
  assert.match(secure, /security-guidance/, '/secure names the security-guidance plugin (assumed present when the host reports it)');
  assert.match(secure, /\/secrets-audit/, '/secure keeps the /secrets-audit delegation');
  assert.match(secure, /\bSBOM\b/, '/secure keeps the SBOM leg (the pack\'s)');
  assert.match(secure, /get_advisors/, '/secure keeps the MCP-first infra advisories (the pack\'s)');
  assert.match(secure, /LLM/, '/secure keeps the pack\'s LLM-surface lens (the notes do not give the host one)');
  // /playtest exercises via /run, verifies via /verify, and keeps the regression-test-per-commit rule
  assert.match(playtest, /\/run\b/, '/playtest exercises the surface with the host /run');
  assert.match(playtest, /\/verify\b/, '/playtest verifies before/after with the host /verify');
  assert.match(playtest, /regression test/i, '/playtest keeps the regression-test-per-fix rule');
  assert.match(playtest, /per atomic commit|atomic commit/i, '/playtest keeps the atomic-commit-per-fix rule');
});

test('[c5] the thin wrappers attribute no host /command outside the notes, and the pack-only steps cannot be dropped', () => {
  // correction: every slash command the three name is either a pack skill or one of the four listed host commands
  for (const name of ['review', 'secure', 'playtest']) {
    const body = c5Body(skillByName(name).content);
    assert.ok(!c5AttributesUnlistedHostCommand(body),
      `/${name} names a slash command that is neither a pack skill nor a host command the obsolescence review lists — it would invent a host capability the notes do not support`);
  }
  // bypass: a skill that attributes an unlisted host /command fails (/sbom is the pack's leg, not a host one)
  assert.ok(c5AttributesUnlistedHostCommand("Run the host's /sbom to produce the bill of materials."),
    'the vocabulary fence must reject an unlisted host /command');
  // the four listed host commands pass the fence
  assert.ok(!c5AttributesUnlistedHostCommand('the host\'s /code-review and /security-review, then /verify and /run'),
    'the four host commands the notes list must pass the vocabulary fence');
  // bypass: dropping the receipt step or the spine lens is caught by the same predicates the correction uses
  const review = c5Body(skillByName('review').content);
  assert.ok(c5KeepsReceipt(review) && c5NamesSpine(review), 'the real /review keeps both the receipt and the spine lens');
  assert.ok(!c5KeepsReceipt(review.replace(/review-receipt --write/g, 'done')), 'a /review that drops the receipt step fails the receipt fence');
  assert.ok(!c5NamesSpine(review.replace(/spine-consistency-reviewer/g, 'x')), 'a /review that drops the spine lens fails the spine fence');
});
