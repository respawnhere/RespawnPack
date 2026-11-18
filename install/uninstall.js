#!/usr/bin/env node
/*
 * RespawnPack uninstaller — surgically removes the framework from a target repo.
 *   node install/uninstall.js [targetDir]   (default: cwd)
 *     (no flags)     DRY RUN — prints the full removal listing, removes nothing
 *     --force        actually executes the removal
 *     --for-upgrade  removes current + legacy pack files only; settings.json, CLAUDE.md,
 *                    respawnpack.config.json, .gitignore, and .respawnpack/ all stay intact
 *                    so install.js can re-lay a newer pack cleanly on top (composes with
 *                    --force the same way the default mode does; install/upgrade.js is the
 *                    fronting one-command verb that composes this flag with the reinstall)
 *     --purge-config also remove respawnpack.config.json (founder-edited, so kept by default;
 *                    contradicts --for-upgrade, which must keep it — combining them errors)
 *     --dry-run      forces a dry run even alongside --force (safety wins on conflict)
 *
 * INVENTORY-DRIVEN: everything removed here is named by mirroring install.js's own placement
 * logic (its static dest lists + the same readdirSync enumerations over the pack source), plus
 * KNOWN_LEGACY below for artifacts older pack versions placed that the current source no longer
 * ships. NEVER key removal on a name prefix — targets legitimately author their own skills inside
 * our namespaces (that target's hand-written mcp-routing sits in .claude/skills/ beside six pack-placed
 * mcp-* skills; a prefix sweep would eat it). Only paths the inventory names, file by file.
 *
 * NEVER TOUCHED, in any mode: the canonical spine docs (docs/PRODUCT.md, FEATURES-PAGES.md,
 * DECISIONS.md, DESIGN.md, ARCHITECTURE-ROADMAP.md), docs/README.md, docs/derived/*,
 * docs/_archive/*, docs/compliance/*, compliance.config.md, memory/** (the knowledge graph),
 * CLAUDE.md text outside the RESPAWNPACK:BEHAVIOR markers, settings.json beyond our own hook
 * entries (permissions.allow and skillListingBudgetFraction stay — read-only allows and a
 * preference, both harmless and possibly user-tuned by now).
 *
 * Directories are never removed recursively (sole exception: .respawnpack/, pure pack runtime
 * state) — files are unlinked by name and a dir is pruned only once it is genuinely empty, so a
 * user file dropped inside a pack dir keeps that dir (and itself) alive.
 * No dependencies (fs/path only). Node-only; git is not needed for any of this.
 */
const fs = require('fs');
const path = require('path');
// The ONE declaration of the kernel and core file sets, shared with install.js (which places them)
// and upgrade.js (which preflights them). Re-rooted at the target below.
const { KERNEL_FILES: SRC_KERNEL_FILES, CORE_FILES: SRC_CORE_FILES, CONTENT_MATCHED_FILES: SRC_CONTENT_MATCHED_FILES, normalizedDigest } = require('./_sources.js');

const SRC = path.resolve(__dirname, '..');

const KNOWN_FLAGS = new Set(['--force', '--dry-run', '--for-upgrade', '--purge-config']);
const flagArgs = process.argv.slice(2).filter((a) => a.startsWith('--'));
const unknownFlags = flagArgs.filter((f) => !KNOWN_FLAGS.has(f));
if (unknownFlags.length) {
  // A destructive tool must not let a typo'd flag fall through as a target-dir argument.
  console.error(`Unknown flag(s): ${unknownFlags.join(' ')} — supported: --force --dry-run --for-upgrade --purge-config`);
  process.exit(1);
}
const FORCE = flagArgs.includes('--force');
const DRY_RUN = !FORCE || flagArgs.includes('--dry-run'); // dry-run is the default; an explicit --dry-run also beats --force
const FOR_UPGRADE = flagArgs.includes('--for-upgrade');
const PURGE_CONFIG = flagArgs.includes('--purge-config');
if (PURGE_CONFIG && FOR_UPGRADE) {
  console.error('--purge-config contradicts --for-upgrade (upgrade must keep respawnpack.config.json for the re-install). Pick one.');
  process.exit(1);
}
const argv = process.argv.slice(2).filter((a) => !a.startsWith('--'));
// More than one positional means the shell split an unquoted spaced path ("uninstall.js C:\My Projects\app"
// would silently target C:\My) or a stray argument — refuse before ANY action, naming every value seen.
if (argv.length > 1) {
  console.error(`Too many positional arguments — expected at most one (the target dir), got: ${argv.map((a) => `"${a}"`).join(' ')}. If the path has spaces, quote it.`);
  process.exit(1);
}
const TARGET = path.resolve(argv[0] || process.cwd());
// Same canonicalization as install.js: realpath + case-fold on the case-insensitive-FS platforms
// (win32/darwin), so a case-flipped spelling of the pack root cannot dodge the self-target refusal.
const canonicalDir = (p) => {
  let r; try { r = fs.realpathSync.native(p); } catch { r = path.resolve(p); }
  return process.platform === 'win32' || process.platform === 'darwin' ? r.toLowerCase() : r;
};
if (canonicalDir(TARGET) === canonicalDir(SRC)) { console.error('Refusing to uninstall RespawnPack from itself.'); process.exit(1); }

const read = (p) => fs.readFileSync(p, 'utf8');
const exists = (rel) => fs.existsSync(path.join(TARGET, rel));
// CRLF-insensitive equality: the pack checkout and the target can sit on opposite sides of git's
// EOL normalization, and that alone must not make an untouched file look founder-edited.
const sameContent = (a, b) => a.replace(/\r\n/g, '\n') === b.replace(/\r\n/g, '\n');
function listSrc(dirRel, keep) {
  // Same defensive posture as install.js's agents/ guard: an incomplete pack checkout enumerates
  // to nothing here rather than crashing (those files then simply aren't in the inventory).
  try { return fs.readdirSync(path.join(SRC, dirRel), { withFileTypes: true }).filter(keep).map((e) => e.name); }
  catch { return []; }
}

// ---------------------------------------------------------------------------------------------
// The inventory. Each block mirrors the install.js section that places it (§ numbers are its
// comment headings) — keep the two files in lockstep. install/uninstall.test.mjs's round-trip
// sweep is the fence: a new install.js placement that isn't named here (or in the deliberate
// keep-set) fails that test as a leftover.
// ---------------------------------------------------------------------------------------------

// §1/§5 — framework reference docs under docs/reference/ (the canonical + derived + _archive +
// compliance spine pages are deliberately NOT here: they hold project truth the founder filled in).
const REFERENCE_DOCS = [
  'README.md',
  'coding-standards.md', 'writing-standards.md', 'performance-standards.md', 'behavior-standards.md',
  'design-standards.md',
  'design-standards/01-interaction-craft.md', 'design-standards/02-visual-system.md',
  'design-standards/03-psychology-of-use.md', 'design-standards/04-accessibility.md',
  'design-standards/05-validation.md',
  'compliance-requirements.md', 'skill-authoring-standards.md', 'testing-standards.md',
  'orchestration-patterns.md', 'observability-basics.md', 'living-skills.md',
  'models/capability-register.json', 'models/capability-register.md', 'models/prompting-anthropic.md',
  'models/prompting-openai.md', 'models/prompting-minimax.md', 'models/prompting-general.md',
  'memory/README.md', 'memory/knowledge-graph.md', 'memory/learnings.template.md',
].map((f) => `docs/reference/${f}`);

// §2 — the role/knowledge/ops skills (basenames of install.js's skillDirs).
const SKILLS = [
  'respawn', 'loadout', 'build', 'review', 'playtest', 'walkthrough', 'ship', 'debug', 'secure',
  'comply', 'savepoint', 'wordsmith', 'knowledge', 'deploy-verify', 'db-ops', 'secrets-audit',
  'infra-status', 'skill-guard', 'checkup', 'onboard', 'task', 'aar',
].map((s) => `.claude/skills/${s}/SKILL.md`);

// §2e — MCP server skills, enumerated UNGATED from the pack source. install.js gates fly/supabase/
// security-audit on the target's detected stack, which is exactly how the mcp-fly legacy class is
// born: the stack matched once, the skill landed, the stack moved on, and the gate now skips the
// name entirely on re-runs. Uninstall must therefore name every server the pack ships, not just
// the ones the gate passes today — presence on disk is the only gate that matters for removal.
const MCP_SERVERS = listSrc('ops/mcp', (e) => e.isDirectory());
const MCP_FILES = MCP_SERVERS.flatMap((m) => [`.claude/skills/mcp-${m}/SKILL.base.md`, `.claude/skills/mcp-${m}/SKILL.md`]);

// §2f — agents (every pack-shipped .md except the folder README).
const AGENT_FILES = listSrc('agents', (e) => e.isFile() && e.name.endsWith('.md') && e.name !== 'README.md')
  .map((f) => `.claude/agents/${f}`);

// §2g — the state kernel (the executable behind /savepoint --verify).
// ⛔ NOT A SECOND LIST. These are install/_sources.js's SOURCE-relative lists re-rooted at the target;
// install.js places from the same declaration and upgrade.js preflights from it. It used to be typed
// out here independently, and the day a file was added to the installer and not to this copy, the only
// thing that caught it was a round-trip test noticing an orphan left behind.
const KERNEL_FILES = SRC_KERNEL_FILES.map((rel) => `.claude/respawnpack/${rel.replace(/^kernel\//, '')}`);

// §2g — the host-neutral rollover core, shared by the kernel and the hooks (both reach it as `../core/`;
// installed, both resolve to `.claude/core/`). Mirrors install.js's own list, which is the ground truth:
// this file is inventory-driven, so a placed file missing from here is an orphan left behind on uninstall.
const CORE_FILES = SRC_CORE_FILES.map((rel) => `.claude/core/${rel.replace(/^core\//, '')}`);

// §3 — governance hooks, plus the nine shared modules they require (`_contracts.js`, `_boot.js`,
// `_runtime.js`, `_cmd.js`, `_manifest.js`, `_artifact.js`, `_shell.js`, `_git-effect.js`,
// `_index-lease.js`). The modules are pack-owned files placed by the same installer step, so they leave
// by the same door; a hook directory left holding orphaned libraries is exactly the drift this
// inventory exists to prevent.
// ⛔ `_posture.js` IS THE TENTH, AND IT IS HERE FOR THE INVENTORY REASON, NOT THE REQUIRE-GRAPH ONE. It
// arrived before any rule consulted it (ADR-003 lands the one posture reader first); the kernel reaches
// it cross-tree for doctor's posture row, install.js places it in the same step as the nine above, and a
// placed file this list did not name would be an orphan left behind on uninstall.
// ⛔ `_exceptions.js` IS THE ELEVENTH, AND WAS IN EXACTLY THAT STATE FOR ONE TASK (P1-E-1a): the one reader
// of the project's declared exceptions, reached cross-tree by doctor's `exceptions` row before any hook
// (E-1b to E-1d then landed the six guards that consume it). Same placement step, same door out.
const HOOK_FILES = [
  '_contracts.js', '_boot.js', '_runtime.js', '_cmd.js', '_manifest.js', '_artifact.js', '_index-lease.js', '_posture.js', '_exceptions.js', '_shell.js', '_git-effect.js',
  'lockdown.js', 'secret-scan.js', 'stop-savepoint.js', 'push-guard.js', 'spawn-guard.js',
  'precompact-ledger-nudge.js', 'worktree-guard.js', 'index-guard.js', 'injection-scan.js', 'context-monitor.js',
  'session-routing-nudge.js', 'websearch-freshness.js', 'shell-guard.js', 'mcp-reaper.js',
  'docker-session-tag.js', 'pre-push',
  // ⛔ `dispatch.js` IS PLACED BY EVERY PROFILE AND WIRED BY TWO (P4-T-15b), WHICH IS WHY IT IS
  // HERE UNCONDITIONALLY. It is not a governance hook - it runs them - but install.js places the file
  // regardless of posture, so a list that named it only for the dispatching profiles would leave an
  // orphaned entry point behind on every `strict` target. Existence is what this inventory tracks;
  // whether anything referenced it is the settings sweep's question, further down.
  'dispatch.js',
].map((h) => `.claude/hooks/${h}`);

// §4e — pack-owned rule files (B4). install.js places these under a pack-owned subdirectory and
// version-manages them like the CLAUDE.md block, so they leave by the same door. They are removed by
// the marker-aware loop below (not REMOVE): a file a founder has taken over — its opening no longer
// carries the RESPAWNPACK:RULE marker — is KEPT and reported, the mirror of install.js's refresh
// guard, and a founder's own `.claude/rules/*.md` are never named here at all.
const RULE_FILES = [
  '.claude/rules/respawnpack/safety-checks.md',
  '.claude/rules/respawnpack/performance.md',
  '.claude/rules/respawnpack/licensing.md',
];

// §4 — workflow templates.
const WORKFLOW_FILES = listSrc('workflows', (e) => e.isFile() && e.name.endsWith('.workflow.js'))
  .map((w) => `.claude/workflows/${w}`);

// §4b — CI templates. respawnpack-*.yml are pack-namespaced (ours to remove outright); CODEOWNERS
// is a shared filename the installer tells the founder to fill in, so it moves to the
// content-matched class below instead.
const CI_FILES = ['.github/workflows/respawnpack-security.yml', '.github/workflows/respawnpack-quality.yml'];

// KNOWN_LEGACY — pack artifacts that are no longer derivable from the current source but that
// older pack versions placed. Seeded from the 2026-07-11 upgrade harvest, whose one named
// class is the conditionally-gated MCP skills (see the MCP_FILES note above). mcp-fly is listed
// here explicitly even though ops/mcp/fly still ships today: the moment the pack drops that
// server, the enumeration above goes silent about it, and stranded installs would otherwise
// leak it forever. Entries are exact target-relative paths — the mcp-routing lesson applies
// here hardest of all, since legacy names are precisely where a prefix sweep looks tempting.
const KNOWN_LEGACY = [
  '.claude/skills/mcp-fly/SKILL.base.md',
  '.claude/skills/mcp-fly/SKILL.md',
];

// Settings-hook commands wired by older snippet versions but absent from today's snippet would
// belong here (same (command,if) shape as the snippet itself). Every historical snippet revision
// still matches the current command set, so this starts empty — it exists so a future hook
// rename doesn't strand its settings entry in every installed target.
const LEGACY_HOOK_ENTRIES = [];

/*
 * ⛔ THE ENTRIES THE COMPOSER CAN PLACE THAT THE SNIPPET DOES NOT NAME (P4-T-15b).
 *
 * `hooks/settings.snippet.json` is the `strict` column and `strict` keeps the multi-hook wiring, so the
 * dispatcher registrations `light` and `standard` compose appear in NO snippet. The receipt names them
 * and the sweep below reads the receipt, which is enough for any target this pack version installed -
 * but a target whose receipt is absent, torn or pre-dates the ownership record would keep a live
 * `dispatch.js` entry pointing at a file the uninstall just deleted, and every Bash tool call in that
 * project would then fail its hook. Named here for exactly the reason LEGACY_HOOK_ENTRIES exists: the
 * receipt is the good path, not the only one.
 *
 * The commands are spelled out rather than imported from `install/_settings-manifest.js` because
 * requiring that module pulls in `hooks/_posture.js` for a question this file does not ask - it removes
 * every wiring it finds, under every profile. `install/uninstall.test.mjs` fences this list against the
 * manifest's own composition so the two cannot drift.
 */
const DISPATCH_HOOK_ENTRIES = [
  { command: 'node ${CLAUDE_PROJECT_DIR}/.claude/hooks/dispatch.js PreToolUse edit --covers lockdown.js,worktree-guard.js,index-guard.js' },
  { command: 'node ${CLAUDE_PROJECT_DIR}/.claude/hooks/dispatch.js PreToolUse bash --covers push-guard.js,index-guard.js,shell-guard.js,docker-session-tag.js' },
];

// Unconditional removals: pack-owned paths (living drift included — a /skill-guard-evolved
// SKILL.md is still pack surface; content is deliberately NOT checked for these).
const REMOVE = [...new Set([
  ...REFERENCE_DOCS, ...SKILLS, ...MCP_FILES, ...AGENT_FILES, ...HOOK_FILES, ...KERNEL_FILES, ...CORE_FILES,
  ...WORKFLOW_FILES, ...CI_FILES, ...KNOWN_LEGACY,
])];

// Content-matched removals: root-level / shared-namespace files the founder plausibly hand-fills
// (CODEOWNERS' whole job is to be filled in). Removed only when byte-equal (EOL aside) to the
// pack source they were placed from; anything edited is kept and reported, never deleted.
//
// ⛔ THE library/* ENTRIES ARE NOW CONDITIONALLY PLACED (P2-T-12) — install.js §4c places them only
// when compliance.config.md declares a non-empty scope — and this list still names every one of them
// unconditionally. That is deliberate, not a gap: the removal loop below (`for (const { rel, src }
// of REMOVE_IF_UNMODIFIED) { if (!exists(rel)) continue; ... }`) already treats "not present" as
// nothing to do rather than an error, for the same reason a founder-edited CODEOWNERS is skipped —
// existence is checked before content ever is. So both states an install can leave library/ in
// (placed, because a scope was declared; never placed, because none was) uninstall cleanly, and a
// target that never had library/ never had docs/compliance/ or compliance.config.md touched either —
// both stay in the NEVER-TOUCHED set above regardless of whether a scope was ever declared.
// ⛔ THE FIXED SHARED FILES COME FROM install/_sources.js (CONTENT_MATCHED_FILES), the ONE declaration
// install.js also reads to write their `placed` digests (G1 LOW-2) — so a file can no longer be content-
// matched on this side while going undigested on the other. The conditionally placed
// library/compliance/requirements/* are enumerated from the pack source the same way install.js adds them
// from placedPaths; that set is decided at runtime by the compliance scope, so neither script hand-keeps it.
const REMOVE_IF_UNMODIFIED = [
  ...SRC_CONTENT_MATCHED_FILES,
  ...listSrc('library/compliance/requirements', (e) => e.isFile())
    .map((f) => ({ rel: `library/compliance/requirements/${f}`, src: `library/compliance/requirements/${f}` })),
];

// ---------------------------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------------------------
const removed = [], keptModified = [], notes = [];
const pruneCandidates = new Set();
function markPrunable(rel) {
  // Every ancestor dir of a removed file is a prune candidate — actual pruning (bottom-up,
  // empty-only) happens after all removals, so ordering here doesn't matter.
  let d = path.posix.dirname(rel.replace(/\\/g, '/'));
  while (d && d !== '.' && d !== '/') { pruneCandidates.add(d); d = path.posix.dirname(d); }
}
function removeFile(rel) {
  if (!exists(rel)) return false;
  if (!DRY_RUN) fs.unlinkSync(path.join(TARGET, rel));
  removed.push(rel);
  markPrunable(rel);
  return true;
}

/*
 * §4b — THE LIVING OVERLAY IS FOUNDER CONTENT, AND AN UPGRADE USED TO EAT IT SILENTLY.
 *
 * ⛔ THE DEFECT THIS REPLACES (found by the final truth audit, not by a test — no test covered
 * `upgrade` against an enabled skill at all). `.claude/skills/debug/SKILL.md` is in the SKILLS
 * inventory, so `--for-upgrade` unlinked it and `install.js` re-laid the pack's copy. The overlay —
 * lines a founder's own memory graph produced — was gone. `.skill-meta.json` and `SKILL.base.md`
 * both survive, and when the pack's SKILL.md happens to be byte-identical to the frozen base (the
 * common case, since `living enable` freezes whatever is on disk), `living status` then reported
 * `PASS · living, base intact, overlay 0/12 line(s)`. Every check it runs was TRUE. The post-upgrade
 * state is simply indistinguishable from "nothing was ever learned here" — which is the shape this
 * whole program exists to refuse: a green outcome that establishes nothing about what it destroyed.
 *
 * The correction is not to skip the removal — a founder who upgrades wants the new pack skill. It is
 * that DESTRUCTION MUST LEAVE A RECORD THE NEXT READER TRIPS OVER. The living form is copied beside
 * its meta as `SKILL.superseded.md` and the meta gets a `supersededByUpgrade` stamp, so `living
 * status` reports the loss (see kernel/lib/living.js) instead of a clean PASS. Nothing is deleted to
 * make this work: `reset` already archives, and now so does upgrade.
 */
/*
 * ⛔ ONE PLAN, TWO MODES — BECAUSE A PREVIEW THAT DISAGREES WITH THE RUN IS WORSE THAN NO PREVIEW.
 *
 * Reproduced before this existed, on a real installed target with five archive slots occupied:
 *     dry run   → "living form WOULD be archived beside its base before the upgrade replaces it"
 *     execution → "5 superseded archives already exist — living form LEFT IN PLACE (not upgraded)"
 * The dry run is what `install/uninstall.js` documents as the thing a founder reads BEFORE anything
 * happens. It promised an archive the run then refused to make. The cause was structural rather than a
 * wrong string: the bound lived inside `if (!DRY_RUN)`, so the preview never evaluated the decision it
 * was previewing — it printed an outcome nobody had computed.
 *
 * `planLivingArchive()` decides everything: the archive name, whether the bound is reached, whether the
 * living form must stay, and the exact sentence the founder sees. Both modes consume the SAME plan, and
 * only the write itself is conditional on DRY_RUN. A future edit that gives the preview its own decision
 * path has to delete this function to do it.
 */
const MAX_LIVING_ARCHIVES = 5;
function planLivingArchive(dir, rel, meta) {
  // The series is `SKILL.superseded.md`, then `.2` … `.MAX`. First free slot wins; never overwrite.
  let name = 'SKILL.superseded.md';
  let n = 2;
  while (fs.existsSync(path.join(dir, name)) && n <= MAX_LIVING_ARCHIVES) {
    name = `SKILL.superseded.${n}.md`;
    n += 1;
  }
  if (fs.existsSync(path.join(dir, name))) {
    /*
     * "Never overwrite" and "never stop" are different promises. upgrade.js documents itself as safe to
     * repeat, so an unbounded series turns a re-runnable command into a directory of near-identical
     * files of which only the first holds anything the founder wrote. At the bound the upgrade REFUSES
     * to remove the living form rather than quietly dropping it — their text stays on disk either way.
     */
    return {
      archive: null,
      bounded: true,
      keepLiving: true,
      note: `${rel}: ${MAX_LIVING_ARCHIVES} superseded archives already exist — living form LEFT IN PLACE (not upgraded). `
        + 'Regenerate or reset it, and delete the archives you no longer need.',
    };
  }
  return {
    archive: name,
    bounded: false,
    keepLiving: false,
    // ⭐ The same sentence names the same file in both modes; only the tense differs, and the tense is
    // computed from DRY_RUN at the call site rather than from a separate branch that could disagree.
    note: `${rel}: living form archived as ${name} before the upgrade replaced it — \`living status\` will `
      + 'report it until you regenerate',
    previewNote: `${rel}: living form WOULD be archived as ${name} before the upgrade replaces it`,
    stamp: !meta.supersededByUpgrade,
  };
}

const supersededOverlays = [];
// Skills whose living form must survive this upgrade untouched (unparseable meta — see below).
const keepLiving = new Set();
if (FOR_UPGRADE) {
  for (const rel of SKILLS) {
    if (!exists(rel)) continue;
    const dir = path.dirname(path.join(TARGET, rel));
    const metaPath = path.join(dir, '.skill-meta.json');
    if (!fs.existsSync(metaPath)) continue; // static skill — nothing was ever learned into it
    let meta = null;
    try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch { meta = null; }
    /*
     * ⛔ SKIPPING THE ARCHIVE IS NOT SKIPPING THE DELETION, AND FOR ONE ROUND IT PRETENDED TO BE.
     *
     * The previous version answered "do not clobber the first archive" with `continue` — which skipped
     * only this block. `for (const rel of REMOVE) removeFile(rel)` below runs unconditionally and SKILLS
     * is in REMOVE, so every skipped skill still had its SKILL.md deleted, now with no archive AND no
     * stamp. The reachable path was the ordinary lifecycle this file's own fixture demonstrates:
     * upgrade → status FAIL → `regenerate --write` (clears the stamp, keeps the archive) → learn more →
     * upgrade again → archive exists → skip → overlay destroyed, unrecorded, and `living status` said
     * PASS. The fix for a P0 reinstated the P0 one release later, which is why the rule below is stated
     * as an invariant rather than as a case:
     *
     *   ⭐ EVERY UPGRADE THAT REMOVES A LIVING FORM ARCHIVES IT AND STAMPS IT. Never overwrite, never
     *     skip — if the name is taken, take the next one. `SKILL.superseded.md`, then
     *     `SKILL.superseded.2.md`, and so on. Both halves of the promise hold at once, for every cycle.
     *
     * The unparseable-meta case is the same trap wearing different clothes: its note said "living form
     * left in place" while REMOVE deleted it. That skill is now genuinely left in place, by removing it
     * from the deletion set — the note and the behaviour agree.
     */
    if (!meta) {
      keepLiving.add(rel);
      notes.push(`${rel}: .skill-meta.json does not parse — living form LEFT IN PLACE (not upgraded); fix or delete the meta, then re-run`);
      continue;
    }
    const living = read(path.join(TARGET, rel));
    const plan = planLivingArchive(dir, rel, meta);
    if (plan.keepLiving) {
      // The bound is reached. Identical in both modes: the living form stays, and the founder is told
      // the same sentence whether or not anything was written.
      keepLiving.add(rel);
      notes.push(plan.note);
      continue;
    }
    supersededOverlays.push(`${rel} → ${plan.archive}`);
    notes.push(DRY_RUN ? plan.previewNote : plan.note);
    if (!DRY_RUN) {
      // ⭐ ONLY THE WRITE IS CONDITIONAL. Every decision above was made once, for both modes.
      fs.writeFileSync(path.join(dir, plan.archive), living);
      /*
       * ⛔ ARCHIVE EVERY TIME, BUT DO NOT RE-POINT AN EXISTING STAMP. An upgrade that follows another
       * upgrade with no regenerate between them removes the PACK's own copy — archiving it costs a file
       * and loses nothing, but moving the stamp to it would leave `living status` naming an archive with
       * nothing of the founder's in it. That is the exact harm the stamp was introduced to end, so the
       * first stamp stands until the founder clears it with `regenerate --write` or `reset`.
       */
      if (plan.stamp) {
        meta.supersededByUpgrade = { lines: living.split('\n').length, archive: plan.archive };
        fs.writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
      }
    }
  }
}

for (const rel of REMOVE) { if (keepLiving.has(rel)) continue; removeFile(rel); }

// §4e — pack-owned rule files: removed when they still carry the pack marker, kept and reported when a
// founder has taken one over (its opening lost the marker). A dropped file — e.g. the performance rule
// on a knowledge project, which install.js never placed — is simply absent and skipped.
for (const rel of RULE_FILES) {
  if (!exists(rel)) continue;
  if (/RESPAWNPACK:RULE v/.test(read(path.join(TARGET, rel)).split(/\r?\n/, 2).join('\n'))) removeFile(rel);
  else keptModified.push(rel);
}

/*
 * §3b/§3c — RECEIPT-BASED adapter removal. install.js §3c wrote .respawnpack/install-receipt.json
 * listing exactly what it placed under .claude/adapters/, derived from its own placedPaths so the two
 * cannot disagree. Uninstall replays that list rather than carrying a second static inventory that
 * would drift the day an adapter file is added to the installer and not to a copy here — the exact
 * defect class _sources.js was written to end, applied to the newest surface. The round-trip sweep in
 * install/uninstall.test.mjs is the fence: an adapter file the receipt fails to name survives this and
 * fails the exact keep-set comparison, so incompleteness is loud, not silent.
 *
 * ⛔ A RECEIPT IS DATA, AND DATA NAMES ONLY WHAT IT IS ALLOWED TO. Every entry is contained to
 * .claude/adapters/ by resolved path before removal — a receipt that named ../../etc/anything (a torn
 * or tampered file) removes nothing outside the adapter root. A missing or unparseable receipt (an
 * install that predates receipts, or a hand-placed adapter) replays nothing rather than throwing.
 *
 * ⛔ P5-CT-4: A RECEIPTED FILE THE FOUNDER EDITED IS NOT OURS TO DELETE EITHER. Every entry named here
 * used to be removed unconditionally — correct for a file nobody touched, wrong for one a founder
 * hand-patched (a timeout tuned for their CI, a local workaround) since phase 2 of an upgrade never
 * re-creates what phase 1 left in place (place() skips an existing destination without --force), so an
 * unconditional removal here was the ONLY thing standing between that edit and a silent loss on the
 * next upgrade. Content-matched now, the same way REMOVE_IF_UNMODIFIED already treats
 * CODEOWNERS/ATTRIBUTION/etc below: byte-equal (EOL aside) to what this pack version would place is
 * removed, same as before; anything else is kept and named in the summary, same as a founder-filled
 * CODEOWNERS already is. The destination mirrors the source 1:1 under .claude/ (place() puts
 * adapters/claude-code/<x> at .claude/adapters/claude-code/<x>), so the pack copy to compare against
 * is the receipted path with its leading .claude/ stripped — no second lookup table needed.
 */
const RECEIPT_REL = path.join('.respawnpack', 'install-receipt.json');
const adaptersRoot = path.resolve(TARGET, '.claude', 'adapters');
let receiptAdapters = [];
let receiptHooks = []; // the (event, matcher, command, if) tuples install.js §7d recorded; [] on a v1 receipt
let receiptFounderHooks = []; // a founder's own hooks identical to ours, present before we placed them: never removed
/*
 * ⛔ THE `placed` DIGEST MAP (G1). install.js §7d-bis records the sha256 (CRLF-folded, the shared rule
 * from _sources.js) of the bytes it placed for every content-matched shared file, every adapter and
 * every B4 rule file. The content-matched and adapter loops below compare the bytes on disk to THAT
 * digest — "unchanged since install" vs "a local edit" — rather than to the current pack source, which
 * is the G1 defect: a file changed upstream but untouched locally failed the source comparison, was
 * kept as modified, and the reinstall never re-placed it. `null` means NO MEMORY: a pre-`placed`
 * receipt (v1/v2), or a torn/absent one — each loop then falls back to the old source comparison and
 * NAMES that it did, so the verdict is never silent about which rule decided.
 */
let receiptPlaced = null;
let receiptDeny = []; // the permissions.deny rules install.js §7d recorded as pack-owned; [] when none/absent
let receiptExcludes = [];  // D1 · claudeMdExcludes the pack owns
let receiptSymlinks = [];  // D1 · worktree.symlinkDirectories the pack owns
let receiptSparse = [];    // D1 · worktree.sparsePaths the pack owns
try {
  const parsed = JSON.parse(read(path.join(TARGET, RECEIPT_REL)));
  if (parsed && Array.isArray(parsed.adapters)) receiptAdapters = parsed.adapters;
  if (parsed && Array.isArray(parsed.settingsHooks)) receiptHooks = parsed.settingsHooks;
  if (parsed && Array.isArray(parsed.settingsHooksFounder)) receiptFounderHooks = parsed.settingsHooksFounder;
  if (parsed && parsed.placed && typeof parsed.placed === 'object' && !Array.isArray(parsed.placed)) receiptPlaced = parsed.placed;
  if (parsed && Array.isArray(parsed.permissionsDeny)) receiptDeny = parsed.permissionsDeny.filter((r) => typeof r === 'string' && r);
  if (parsed && Array.isArray(parsed.claudeMdExcludes)) receiptExcludes = parsed.claudeMdExcludes.filter((r) => typeof r === 'string' && r);
  if (parsed && Array.isArray(parsed.worktreeSymlinkDirectories)) receiptSymlinks = parsed.worktreeSymlinkDirectories.filter((r) => typeof r === 'string' && r);
  if (parsed && Array.isArray(parsed.worktreeSparsePaths)) receiptSparse = parsed.worktreeSparsePaths.filter((r) => typeof r === 'string' && r);
} catch { /* no receipt, or unreadable/unparseable — replay nothing, and fall back to source comparison below */ }
// Every content-matched verdict, for the summary: {rel, action: 'remove'|'keep', rule}. Mode-neutral on
// purpose, so the dry run and the real run print the identical list (only the top banner's tense differs).
const managedVerdicts = [];
const keptNoDigest = []; // kept by the source-comparison fallback (no digest on file), reported apart from edited-since-install
// The receipt's own byte identity is trusted the way STATE.json is: a hand-forged `placed` digest made
// to match a locally-edited file would make that edit read as "unchanged since install" and be removed.
// That is outside this guarantee, stated in install/README.md, the same trust root the whole pack rests on.
const digestFor = (rel) => (receiptPlaced && typeof receiptPlaced[rel] === 'string' ? receiptPlaced[rel] : null);
for (const rel of receiptAdapters) {
  if (typeof rel !== 'string' || !rel) continue;
  const abs = path.resolve(TARGET, rel);
  if (abs !== adaptersRoot && !abs.startsWith(adaptersRoot + path.sep)) continue; // containment
  const relPosix = rel.replace(/\\/g, '/');
  if (!exists(relPosix)) continue; // named by the receipt but already gone
  const srcRel = relPosix.replace(/^\.claude\//, ''); // .claude/adapters/... mirrors adapters/... in SRC 1:1
  judgeManaged(relPosix, srcRel);
}
/*
 * ⛔ G1 · THE ONE VERDICT FUNCTION FOR A CONTENT-MATCHED FILE, SHARED BY THE ADAPTER LOOP ABOVE AND THE
 * REMOVE_IF_UNMODIFIED LOOP BELOW, AND IDENTICAL IN DRY-RUN AND REAL MODE.
 *
 *   • a digest on file (the common case): compare the bytes on disk to it. EQUAL = unchanged since
 *     install, so remove it and let phase 2 re-place the current version — even if the source was retired
 *     from this pack version, because the digest alone proves we placed it, which is exactly the retirement
 *     the old "keep when the source is gone" rule got wrong. DIFFERENT = a local edit, kept and named.
 *   • NO digest (a pre-`placed` receipt, or a torn/absent one): fall back to the old source comparison and
 *     SAY so per file, so the verdict names which rule decided. A source retired from this pack version
 *     cannot be attested this way, so it is kept — the pre-G1 behaviour, now explicit.
 *
 * `srcRel` is the SOURCE-relative path for the fallback comparison and the retirement check; the adapter
 * and REMOVE_IF_UNMODIFIED callers each pass their own mapping, so there is no second lookup table here.
 */
function judgeManaged(rel, srcRel) {
  const onDisk = read(path.join(TARGET, rel));
  const digest = digestFor(rel);
  const srcAbs = path.join(SRC, srcRel);
  const retired = !fs.existsSync(srcAbs);
  if (digest !== null) {
    if (normalizedDigest(onDisk) === digest) {
      removeFile(rel);
      managedVerdicts.push({ rel, action: 'remove', rule: retired ? 'unchanged since install; source retired from this pack version, not re-placed' : 'unchanged since install' });
    } else {
      keptModified.push(rel);
      managedVerdicts.push({ rel, action: 'keep', rule: 'edited since install' });
    }
    return;
  }
  // No digest for this file: fall back to today's rule (compare to the current source) and name it.
  let srcTxt = null;
  try { srcTxt = read(srcAbs); } catch { /* retired — cannot attest ownership, so keep */ }
  if (srcTxt !== null && sameContent(onDisk, srcTxt)) {
    removeFile(rel);
    managedVerdicts.push({ rel, action: 'remove', rule: 'no digest in the receipt; matched the current source' });
  } else {
    keptNoDigest.push(rel);
    managedVerdicts.push({ rel, action: 'keep', rule: retired ? 'no digest in the receipt; source retired from this pack version' : 'no digest in the receipt; compared to the current source' });
  }
}
/*
 * The receipt itself is pack metadata under .respawnpack/ — the target's session-state dir, which an
 * upgrade PRESERVES (see the --for-upgrade round-trip test). So it is removed on a full uninstall and
 * KEPT on --for-upgrade, where phase 2's reinstall rewrites it from the freshly-placed set.
 */
if (!FOR_UPGRADE) removeFile(RECEIPT_REL.replace(/\\/g, '/'));

/*
 * §5c — LEGACY cleanup of the retired memory engine (`install.js --with-memory`, retired decision 33).
 *
 * The installer no longer places an engine, but a target installed by an older pack version still
 * carries one, so an upgrade must remove it: the tree, its `.mcp.json` registration, and its
 * `respawnpack.config.json` record. This is KNOWN_LEGACY work — a target this version installed never
 * has any of it.
 *
 * ⛔ TWO THINGS MUST NOT BE CONFUSED HERE, and one of them is the user's. The ENGINE — a copy of
 * pack source plus the node_modules npm restored from its lockfile — lives entirely inside
 * `.claude/respawnpack/memory/` and is ours to remove. The MEMORY — `memory/graph/**`, the markdown
 * entity files that ARE the knowledge — is the user's, is the source of truth by design, and is never
 * touched here (nor is `memory/.index/`, the engine's own database, which is theirs to rebuild or
 * delete; `doctor` names it once as a legacy artifact). The engine is enumerated from disk rather than
 * from a file list because npm decided what node_modules contained.
 */
{
  const engineRoot = path.join(TARGET, '.claude', 'respawnpack', 'memory');
  const walk = (abs, rel) => {
    let entries = [];
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const childRel = `${rel}/${e.name}`;
      if (e.isDirectory() && !e.isSymbolicLink()) { walk(path.join(abs, e.name), childRel); continue; }
      removeFile(childRel);
    }
  };
  if (fs.existsSync(engineRoot)) walk(engineRoot, '.claude/respawnpack/memory');
}

/*
 * …and the project-local MCP registration, which is a MERGE the same way settings.json is: only our
 * own server key leaves, and a file that still holds someone else's servers stays.
 */
{
  const mcpRel = '.mcp.json';
  if (exists(mcpRel)) {
    let doc = null;
    try { doc = JSON.parse(read(path.join(TARGET, mcpRel))); } catch { doc = null; }
    if (!doc) notes.push('.mcp.json does not parse — left byte-identical; remove the respawn-memory entry by hand if you want it gone');
    else if (doc.mcpServers && doc.mcpServers['respawn-memory']) {
      delete doc.mcpServers['respawn-memory'];
      const empty = !Object.keys(doc.mcpServers).length && Object.keys(doc).length === 1;
      if (empty) { removeFile(mcpRel); }
      else if (!DRY_RUN) { fs.writeFileSync(path.join(TARGET, mcpRel), `${JSON.stringify(doc, null, 2)}\n`); notes.push('.mcp.json: removed the respawn-memory server, kept the rest'); }
      else notes.push('.mcp.json: would remove the respawn-memory server, keeping the rest');
    }
  }
}

/*
 * …and the `memory.engine` record the old installer wrote into respawnpack.config.json. The config is
 * founder-owned and kept (an upgrade preserves it), so only this one legacy key leaves, and only when
 * it is present — a config that never carried it is left byte-identical.
 */
{
  const cfgRel = 'respawnpack.config.json';
  if (exists(cfgRel)) {
    let cfg = null;
    try { cfg = JSON.parse(read(path.join(TARGET, cfgRel))); } catch { cfg = null; }
    if (cfg && cfg.memory && Object.prototype.hasOwnProperty.call(cfg.memory, 'engine')) {
      delete cfg.memory.engine;
      if (!Object.keys(cfg.memory).length) delete cfg.memory;
      if (!DRY_RUN) { fs.writeFileSync(path.join(TARGET, cfgRel), `${JSON.stringify(cfg, null, 2)}\n`); notes.push('respawnpack.config.json: removed the legacy memory.engine record'); }
      else notes.push('respawnpack.config.json: would remove the legacy memory.engine record');
    }
  }
}

/*
 * §5d — the D3 handoff pointer in the host's auto memory. `savepoint --write` registers one
 * `respawnpack-handoff.md` file plus one index line in the host's `MEMORY.md`; uninstalling removes both,
 * the inverse of the kernel's writeHandoffMemoryLine. It is machine-local and outside the target, so it is
 * handled here rather than in the receipted file sweep: resolve the directory the kernel resolves (the env
 * override for tests, else `autoMemoryDirectory` from the target's settings, else the host default), and
 * when it is absent say NOT_APPLICABLE and touch nothing. A user's own MEMORY.md lines are matched by the
 * same full host-format shape the kernel uses, anchored at line start, so a prose mention is never removed.
 */
{
  const os = require('os');
  const HANDOFF_MEMORY_FILE = 'respawnpack-handoff.md';
  const encodeProjectDirName = (abs) => String(abs).replace(/[\\/:]/g, '-');
  const readJSONSafe = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
  const resolveAutoMemoryDir = () => {
    const env = process.env.RESPAWNPACK_AUTO_MEMORY_DIR;
    if (env && env.trim()) return path.resolve(env.trim());
    for (const f of [
      path.join(TARGET, '.claude', 'settings.json'),
      path.join(TARGET, '.claude', 'settings.local.json'),
      path.join(os.homedir(), '.claude', 'settings.json'),
    ]) {
      const doc = readJSONSafe(f);
      const v = doc && typeof doc.autoMemoryDirectory === 'string' ? doc.autoMemoryDirectory.trim() : '';
      if (v) return path.resolve(TARGET, v);
    }
    return path.join(os.homedir(), '.claude', 'projects', encodeProjectDirName(TARGET), 'memory');
  };
  const memDir = resolveAutoMemoryDir();
  if (!fs.existsSync(memDir)) {
    notes.push('host auto memory: no directory resolved, so no D3 handoff pointer to remove (NOT_APPLICABLE)');
  } else {
    const memFile = path.join(memDir, HANDOFF_MEMORY_FILE);
    const hadFile = fs.existsSync(memFile);
    const indexPath = path.join(memDir, 'MEMORY.md');
    const packLine = new RegExp(`^- \\[[^\\]]*\\]\\(${HANDOFF_MEMORY_FILE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\) \\u2014 `);
    let existing = null;
    try { existing = fs.readFileSync(indexPath, 'utf8'); } catch { existing = null; }
    let lineRemoved = false;
    if (existing !== null) {
      const eol = existing.includes('\r\n') ? '\r\n' : '\n';
      const all = existing.split(/\r?\n/);
      const kept = all.filter((l) => !packLine.test(l));
      lineRemoved = kept.length !== all.length;
      if (lineRemoved && !DRY_RUN) fs.writeFileSync(indexPath, kept.join(eol));
    }
    if (hadFile && !DRY_RUN) { try { fs.rmSync(memFile, { force: true }); } catch { /* best effort */ } }
    if (hadFile || lineRemoved) {
      notes.push(`host auto memory: ${DRY_RUN ? 'would remove' : 'removed'} the D3 handoff pointer (${hadFile ? HANDOFF_MEMORY_FILE : 'file absent'}${lineRemoved ? ' and its MEMORY.md line' : ''}); a user's own lines are kept`);
    } else {
      notes.push('host auto memory: no D3 handoff pointer present, nothing removed');
    }
  }
}

for (const { rel, src } of REMOVE_IF_UNMODIFIED) {
  if (!exists(rel)) continue;
  judgeManaged(rel, src); // digest-first, source-compare fallback — see judgeManaged above (G1)
}

// .respawnpack/ — pure pack runtime state (push-guard markers, wave ledger, guard toggles,
// onboarding drafts): recursively removed on a full uninstall. An upgrade keeps it — that state
// belongs to the target's ongoing sessions (its wave ledger, its toggles), not to a pack version.
let respawnStateFiles = 0;
if (!FOR_UPGRADE && exists('.respawnpack')) {
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true })
    .reduce((n, e) => n + (e.isDirectory() ? walk(path.join(dir, e.name)) : 1), 0);
  respawnStateFiles = walk(path.join(TARGET, '.respawnpack'));
  if (!DRY_RUN) fs.rmSync(path.join(TARGET, '.respawnpack'), { recursive: true, force: true });
  removed.push(`.respawnpack/ (runtime state, ${respawnStateFiles} file(s), recursive)`);
}

/*
 * settings.json — remove exactly our hook entries, keyed per hook on (command, if), the same
 * identity install.js's merge dedupes on. Everything else in the file (user hooks sharing our
 * matcher groups, user groups, permissions.allow, skillListingBudgetFraction) stays untouched;
 * groups and event arrays are pruned only once genuinely empty.
 *
 * ⛔ AND NOW ALSO WHAT THE RECEIPT SAYS THIS INSTALL PLACED, which is a UNION with the snippet sweep
 * above, never a replacement for it. The two answer different questions and both have to be asked:
 * the snippet answers "what does today's pack wire", the receipt answers "what did THIS target's
 * install actually place" — including a tuple wired by an older snippet that today's no longer names,
 * which is the gap LEGACY_HOOK_ENTRIES exists to plug by hand. Making the receipt the ONLY source
 * would have been the narrower change and the wrong one: every target installed before receipts
 * carried hook tuples has no such record, and its pack hooks would have survived the uninstall
 * entirely.
 *
 * ⛔ A RECEIPT IS DATA — the same rule as the adapter replay above, and it is what "contained to the
 * entries it placed" means here. A tuple can only ever match a hook object already sitting inside
 * settings.hooks[event][group].hooks, matched on the group's own matcher, so a torn or tampered
 * receipt cannot reach a different file, a different key, or a founder hook it does not name
 * exactly. Rows without a string event and command name nothing and are dropped.
 */
let hooksRemoved = 0;
let hooksRemovedByReceiptOnly = 0;
let denyRemoved = 0;
let scopingRemoved = 0; // D1 · claudeMdExcludes + worktree entries removed by the receipt
let settingsNote = null;
if (!FOR_UPGRADE) {
  const settingsPath = path.join(TARGET, '.claude', 'settings.json');
  if (fs.existsSync(settingsPath)) {
    let settings = null;
    try { settings = JSON.parse(read(settingsPath)); } catch { /* handled below */ }
    if (settings === null) {
      settingsNote = '⚠️  .claude/settings.json is not valid JSON — left untouched; remove the RespawnPack hook entries by hand';
    } else if (settings.hooks && typeof settings.hooks === 'object') {
      const snippet = JSON.parse(read(path.join(SRC, 'hooks', 'settings.snippet.json')));
      const ourKey = (h) => [h.command, h.if || ''].join(String.fromCharCode(0)); // NUL separator built at runtime, never as a source literal — a control byte in source reads as binary to grep/diff tooling (the NUL-byte lesson)
      const ours = new Set(
        Object.values(snippet.hooks || {}).flat().flatMap((e) => e.hooks || []).map(ourKey)
          .concat(LEGACY_HOOK_ENTRIES.map(ourKey))
          .concat(DISPATCH_HOOK_ENTRIES.map(ourKey)),
      );
      const tupleKey = (evt, matcher, h) => [evt, matcher || '', h.command, h.if || ''].join(String.fromCharCode(0));
      const tupleSet = (rows) => new Set(
        rows
          .filter((t) => t && typeof t === 'object' && !Array.isArray(t) && typeof t.event === 'string' && t.event && typeof t.command === 'string' && t.command)
          .map((t) => tupleKey(t.event, typeof t.matcher === 'string' ? t.matcher : '', t)),
      );
      const receipted = tupleSet(receiptHooks);
      /*
       * ⛔ A HOOK THE RECEIPT NAMES AS THE FOUNDER'S IS NEVER OURS, even though its command matches the
       * snippet sweep. install.js records under `settingsHooksFounder` a founder's own hook that was
       * byte-identical to one we would place and already present before we placed it; removing it here
       * would delete a line the pack never wrote. Only an exact tuple match spares an entry.
       */
      const founderKept = tupleSet(receiptFounderHooks);
      for (const [evt, entries] of Object.entries(settings.hooks)) {
        if (!Array.isArray(entries)) continue;
        for (const entry of entries) {
          if (!Array.isArray(entry.hooks)) continue;
          const mine = (h) => h && h.command && !founderKept.has(tupleKey(evt, entry.matcher, h))
            && (ours.has(ourKey(h)) || receipted.has(tupleKey(evt, entry.matcher, h)));
          const keep = entry.hooks.filter((h) => !mine(h));
          hooksRemoved += entry.hooks.length - keep.length;
          hooksRemovedByReceiptOnly += entry.hooks.filter((h) => mine(h) && !ours.has(ourKey(h))).length;
          entry.hooks = keep;
        }
        const liveEntries = entries.filter((e) => !Array.isArray(e.hooks) || e.hooks.length);
        if (liveEntries.length) settings.hooks[evt] = liveEntries;
        else delete settings.hooks[evt];
      }
      if (!Object.keys(settings.hooks).length) delete settings.hooks;
      /*
       * ⛔ permissions.deny — remove EXACTLY the rules the receipt says this pack placed (C1), and
       * nothing else. A founder's own deny rule was never recorded as ours, so it is not in
       * `receiptDeny` and survives; an identical string the founder added before we installed was left
       * unclaimed by install.js for the same reason. A torn or absent receipt names nothing and removes
       * nothing. The array is pruned only once genuinely empty, and `permissions` itself is left alone.
       */
      if (receiptDeny.length && settings.permissions && Array.isArray(settings.permissions.deny)) {
        const toRemove = new Set(receiptDeny);
        const keptDeny = settings.permissions.deny.filter((r) => !toRemove.has(r));
        denyRemoved = settings.permissions.deny.length - keptDeny.length;
        if (keptDeny.length) settings.permissions.deny = keptDeny;
        else delete settings.permissions.deny;
      }
      /*
       * ⛔ D1 · claudeMdExcludes and the worktree keys — remove EXACTLY the entries the receipt says the
       * pack placed, by the same rule as the deny rules above. A founder's own exclude or symlink is not
       * in the receipt and survives; an emptied `worktree` object is dropped so no bare `{}` is left.
       */
      const removeOwned = (container, leaf, owned) => {
        if (!owned.length || !container || !Array.isArray(container[leaf])) return 0;
        const drop = new Set(owned);
        const kept = container[leaf].filter((r) => !drop.has(r));
        const n = container[leaf].length - kept.length;
        if (kept.length) container[leaf] = kept; else delete container[leaf];
        return n;
      };
      scopingRemoved += removeOwned(settings, 'claudeMdExcludes', receiptExcludes);
      scopingRemoved += removeOwned(settings.worktree, 'symlinkDirectories', receiptSymlinks);
      scopingRemoved += removeOwned(settings.worktree, 'sparsePaths', receiptSparse);
      if (settings.worktree && typeof settings.worktree === 'object' && !Object.keys(settings.worktree).length) delete settings.worktree;
      if ((hooksRemoved || denyRemoved || scopingRemoved) && !DRY_RUN) fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
    }
  }
}

// CLAUDE.md — strip the managed marker block with install.js's own BLOCK_RE (same anchoring, same
// versioned-opener pin). Text outside the markers is the founder's and survives byte-for-byte
// apart from the join seam; a file that held nothing but our block was created by the installer
// and is removed whole rather than left as an empty husk.
const BLOCK_RE = /^<!-- RESPAWNPACK:BEHAVIOR v[\s\S]*?^<!-- \/RESPAWNPACK:BEHAVIOR -->\r?\n?/m;
let claudeAction = null;
if (!FOR_UPGRADE && exists('CLAUDE.md')) {
  const claudePath = path.join(TARGET, 'CLAUDE.md');
  const cur = read(claudePath);
  if (BLOCK_RE.test(cur)) {
    const stripped = cur.replace(BLOCK_RE, '');
    if (!stripped.trim()) {
      if (!DRY_RUN) fs.unlinkSync(claudePath);
      claudeAction = `${DRY_RUN ? 'would be removed' : 'removed'} (contained only the pack block)`;
    } else {
      if (!DRY_RUN) fs.writeFileSync(claudePath, stripped.replace(/\s+$/, '\n'));
      claudeAction = `pack block ${DRY_RUN ? 'would be stripped' : 'stripped'}, your text kept`;
    }
  } else if (cur.includes('<!-- RESPAWNPACK:BEHAVIOR')) {
    // Same fragment discipline as the installer: half a marker is not ours to guess at.
    claudeAction = 'marker fragment but no complete block — left untouched, remove it by hand';
  }
}

// .gitignore — remove the two installer-managed marker blocks (the re-include self-heal and the
// .respawnpack/ runtime-state rule). Marker presence is the ownership proof: a hand-written bare
// `.respawnpack/` line has no markers, is therefore ambiguous, and stays — exactly the installer's
// "a hand-written rule counts as present" contract read in reverse.
function stripMarkerBlock(lines, open, close) {
  const from = lines.findIndex((l) => l.trim() === open);
  if (from === -1) return null;
  const to = lines.findIndex((l, i) => i > from && l.trim() === close);
  if (to === -1) return null; // fragment: not ours to guess at, same discipline as CLAUDE.md
  const start = from > 0 && lines[from - 1].trim() === '' ? from - 1 : from; // also drop the seam blank line the installer added
  lines.splice(start, to - start + 1);
  return lines;
}
const gitignoreEdits = [];
if (!FOR_UPGRADE && exists('.gitignore')) {
  const giPath = path.join(TARGET, '.gitignore');
  const cur = read(giPath);
  const eol = cur.includes('\r\n') ? '\r\n' : '\n'; // rejoin with the file's own line endings
  const lines = cur.split(/\r?\n/);
  for (const [open, close, label] of [
    ['# --- RespawnPack: re-included install paths (auto-generated, do not hand-edit) ---', '# --- /RespawnPack: re-included install paths ---', 're-include block'],
    ['# --- RespawnPack: runtime state (auto-generated, do not hand-edit) ---', '# --- /RespawnPack: runtime state ---', '.respawnpack/ rule block'],
  ]) {
    if (stripMarkerBlock(lines, open, close)) gitignoreEdits.push(label);
  }
  if (gitignoreEdits.length) {
    const result = lines.join(eol);
    if (!result.trim()) {
      // Both-blocks-only means the installer created the file from nothing; remove it whole.
      if (!DRY_RUN) fs.unlinkSync(giPath);
      gitignoreEdits.push(`the then-empty file ${DRY_RUN ? 'would be' : 'was'} removed with it (held nothing but our blocks)`);
    } else if (!DRY_RUN) fs.writeFileSync(giPath, result);
  }
}

// respawnpack.config.json — founder-edited truth (CODE_TRUTH, opsTargets, extras) and the
// installer protects it for the same reason; only an explicit --purge-config removes it.
let configAction = 'kept (founder-edited; remove with --purge-config)';
if (PURGE_CONFIG) configAction = removeFile('respawnpack.config.json') ? 'removed (--purge-config)' : 'not present';
else if (!exists('respawnpack.config.json')) configAction = 'not present';

// Prune emptied directories bottom-up. rmdirSync refuses non-empty dirs, which is the whole
// safety argument: a stranger file (a user's notes, that target's mcp-routing) keeps its dir alive.
const pruned = [];
if (!DRY_RUN) {
  for (const rel of [...pruneCandidates].sort((a, b) => b.length - a.length)) {
    try { fs.rmdirSync(path.join(TARGET, rel)); pruned.push(rel); } catch { /* not empty (or already gone with .respawnpack/) — keep */ }
  }
}

// ---------------------------------------------------------------------------------------------
// Summary — full listing in every mode; the dry run is the default precisely so this listing is
// what a founder reads BEFORE anything happens.
// ---------------------------------------------------------------------------------------------
let version = ''; try { version = read(path.join(SRC, 'VERSION')).trim(); } catch { /* banner detail only */ }
const mode = FOR_UPGRADE ? 'UPGRADE-SCOPE UNINSTALL' : 'UNINSTALL';
if (DRY_RUN) console.log(`\n🔍 RespawnPack ${version} ${mode} DRY RUN → ${TARGET} (nothing removed)`);
else console.log(`\n🧹 RespawnPack ${version} ${mode} → ${TARGET}`);
if (FORCE && DRY_RUN) console.log('   (--dry-run given alongside --force: dry run wins)');

const verb = DRY_RUN ? 'would remove' : 'removed';
if (removed.length) {
  console.log(`   ${verb} ${removed.length} pack file(s)/tree(s):`);
  for (const rel of removed) console.log(`     - ${rel}`);
} else {
  console.log(`   nothing to remove — no pack files found at this target`);
}
if (keptModified.length) {
  console.log(`   kept ${keptModified.length} file(s) you have edited since install (remove by hand if wanted):`);
  for (const rel of keptModified) console.log(`     - ${rel}`);
}
if (keptNoDigest.length) {
  // Kept by the source-comparison fallback (this install predates the receipt's `placed` digests, or the
  // receipt is torn/absent): the pack cannot tell an upstream change from a local edit here, so it keeps.
  console.log(`   kept ${keptNoDigest.length} file(s) with no digest in the install receipt — compared to the current pack source and they differ (remove by hand if wanted):`);
  for (const rel of keptNoDigest) console.log(`     - ${rel}`);
}
/*
 * ⛔ G1 · THE PER-FILE VERDICT FOR THE CONTENT-MATCHED FILES, NAMING THE RULE THAT DECIDED EACH. Printed
 * in BOTH modes, mode-neutral, so the dry run a founder reads before acting lists the exact verdicts the
 * real run acts on — the preview and the run share one decision (judgeManaged), never two.
 */
if (managedVerdicts.length) {
  console.log(`   shared / adapter / rule files judged against the install receipt:`);
  for (const v of managedVerdicts.sort((a, b) => (a.rel < b.rel ? -1 : 1))) console.log(`     - ${v.rel}: ${v.action} (${v.rule})`);
}
/*
 * ⛔ SEVEN `notes.push(...)` SITES AND, FOR ONE ROUND, ZERO READERS. The living-overlay archive
 * messages — the success line, and the line saying an archive was NOT overwritten — were assembled and
 * dropped on the floor, so the destruction that P0 was about had no user-visible signal at all. A
 * record nobody prints is a record nobody has. The dry run is where this matters most: it is what a
 * founder reads BEFORE anything happens, and it said nothing about their living skills.
 */
/*
 * ⛔ NAME WHAT SURVIVES, NOT ONLY WHAT WENT. The living-skill lifecycle leaves three kinds of file on a
 * FULL uninstall — `SKILL.base.md` (the founder's frozen skill), `.skill-meta.json` (the record of their
 * opt-in) and any `SKILL.superseded*.md` (text the pack replaced). Keeping all three is right: they are
 * founder content, and deleting them would destroy the thing the lifecycle exists to protect. What was
 * wrong is that the summary named NONE of them, so a founder who ran a full uninstall had no way to know
 * their skill directory was not empty. Silence about what is left behind is the same failure as silence
 * about what was destroyed.
 */
/*
 * ⛔ AND THIS SCAN MUST NOT NAME A FILE THE INVENTORY IS ABOUT TO DELETE. The first version matched on
 * FILENAME alone and ran AFTER the removal loop, so in a dry run — where nothing was removed yet — every
 * pack-shipped `SKILL.base.md` under an `mcp-` skill was still on disk and got printed under "KEPT
 * (yours, not the pack's)". The same file appeared twice in one preview: once in "would remove 144 pack
 * file(s)" and once as founder property. A founder who had edited that base, read the preview, and
 * proceeded lost the edit with nothing in the summary naming it.
 *
 * That is closeout finding 1's exact shape — a preview reporting an outcome nobody computed — reappearing
 * inside the fix for closeout finding 2, one report over. The lesson is the same one `planLivingArchive`
 * exists for: a report about what a decision WILL do has to consult that decision, not re-derive it from
 * whatever happens to be on disk at the moment the report runs. `REMOVE` is that decision, so the scan
 * subtracts it — in both modes, from the same set the removal loop reads.
 */
{
  const doomed = new Set(REMOVE.map((r) => r.replace(/\\/g, '/')));
  const survivors = [];
  const skillsRoot = path.join(TARGET, '.claude', 'skills');
  if (fs.existsSync(skillsRoot)) {
    for (const entry of fs.readdirSync(skillsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      for (const f of fs.readdirSync(path.join(skillsRoot, entry.name))) {
        const rel = `.claude/skills/${entry.name}/${f}`;
        if (doomed.has(rel) && !keepLiving.has(rel)) continue; // the inventory owns it — not the founder's
        if (f === 'SKILL.base.md' || f === '.skill-meta.json' || /^SKILL\.superseded(\.\d+)?\.md$/.test(f)) {
          survivors.push(rel);
        }
      }
    }
  }
  if (survivors.length) {
    console.log(`   living-skill lifecycle artifacts KEPT (yours, not the pack's — delete by hand if you want them gone):`);
    for (const rel of survivors.sort()) console.log(`     - ${rel}`);
  }
}

if (notes.length) {
  console.log(`   notes:`);
  for (const n of notes) console.log(`     - ${n}`);
}
if (!FOR_UPGRADE) {
  if (hooksRemoved) console.log(`   .claude/settings.json: ${verb} ${hooksRemoved} pack hook(s) (per (command,if), plus any (event,matcher,command,if) the install receipt names${hooksRemovedByReceiptOnly ? ` — ${hooksRemovedByReceiptOnly} came from the receipt alone` : ''}); empty groups pruned, your hooks/groups untouched`);
  if (denyRemoved) console.log(`   .claude/settings.json: ${verb} ${denyRemoved} pack permissions.deny rule(s) the install receipt names (control-plane Edit/Write/NotebookEdit, and any large-tree Read scoping rules); a deny rule you added yourself is never recorded as ours and is left exactly where you put it`);
  if (scopingRemoved) console.log(`   .claude/settings.json: ${verb} ${scopingRemoved} pack large-tree scoping entr(ies) the install receipt names (claudeMdExcludes, worktree.symlinkDirectories/sparsePaths); an exclude or symlink you added yourself is never recorded as ours and is left exactly where you put it`);
  if (settingsNote) console.log(`   ${settingsNote}`);
  if (claudeAction) console.log(`   CLAUDE.md: ${claudeAction}`);
  if (gitignoreEdits.length) console.log(`   .gitignore: ${verb} ${gitignoreEdits.join(' + ')}`);
  console.log(`   respawnpack.config.json: ${configAction}`);
} else {
  console.log('   upgrade scope: settings.json, CLAUDE.md, respawnpack.config.json, .gitignore, .respawnpack/ all kept — run install.js to re-lay the pack');
}
if (pruned.length) console.log(`   pruned ${pruned.length} emptied dir(s) (dirs with any other content always stay)`);
console.log('   never touched: docs canonical/derived/compliance spine, docs/README.md, memory/**, CLAUDE.md text outside the markers');
if (DRY_RUN) console.log('\n(dry run — nothing was removed; re-run with --force to actually uninstall)');
console.log('');
