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

// --- the aggregate listing-budget ratchet (the novel, RespawnPack-specific guard) -----------------------
// docs/research/claude-code-limits.md measured the pack's total model-visible listing payload (every
// skill's description+when_to_use, EXCLUDING skills flagged disable-model-invocation, which never enter the
// model-routed listing at all) at ~10,376 chars post-W4a-trim, against a runtime skill-listing context
// budget whose default proxy is ~8,000 chars — already tight. This is a tighten-only ratchet, same pattern
// as gsd-core's assertTightCeiling: the ceiling below may be LOWERED as the pack trims further, but must
// never be RAISED to accommodate new bloat — a real increase needs a deliberate lever (see the "Levers"
// section of claude-code-limits.md), not a quiet ceiling bump here.
const AGGREGATE_LISTING_BUDGET_CEILING = 10736; // measured 10336 (2026-07-11, this suite's own measurement) + 400 chars headroom

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
