/*
 * The license contract. RespawnPack is AGPL-3.0-or-later, and this file is what makes that a fact
 * about the tree rather than an intention someone had once.
 *
 * ⛔ THE FAILURE THIS PREVENTS. A license is not one file. This pack states its own in twelve
 * places: LICENSE, two package manifests, a package-lock root entry, the notice the installer
 * places into every target, and prose in ATTRIBUTION.md, library/README.md, and
 * docs/vision/VISION.md. Change LICENSE alone and the package contradicts
 * itself — a license file saying one thing while the prose beside it says another. A reader who
 * believes the prose and a reader who believes the file walk away with different rights, and the
 * project has no answer for which of them is correct. Every site is asserted below, so a twelfth
 * one added without updating this file fails here rather than in someone's legal review.
 *
 * ⛔ THE SECOND FAILURE, WHICH POINTS THE OTHER WAY. ATTRIBUTION.md credits ~154 upstream sources,
 * a great deal of them MIT and Apache-2.0. Those credits are obligations owed to OTHER PEOPLE under
 * THEIR licenses, and they are not this project's to rewrite. The obvious way to make a licensing
 * sweep "consistent" is to grep for another license name and delete what turns up — which would
 * strip the attribution this pack is required to carry and turn a tidy-up into a violation. So this
 * file asserts in BOTH directions: no conflicting claim about RESPAWNPACK'S OWN license survives,
 * AND the third-party credits are still intact. Neither assertion is safe on its own.
 *
 * The distinction the whole file rests on: RESPAWNPACK'S OWN license is AGPL-3.0-or-later and is
 * stated everywhere. OTHER PEOPLE'S licenses are whatever they chose, are reproduced faithfully,
 * and are none of this project's business to change.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SPDX = 'AGPL-3.0-or-later';

// The SHA-256 of the complete, unmodified SPDX AGPL-3.0 text. Pinned as a digest rather than
// checked for a marker string because the failure worth catching is a TRUNCATED or EDITED license —
// a file that still opens with "GNU AFFERO GENERAL PUBLIC LICENSE" but lost §13 to a bad copy-paste
// is exactly the file a substring check waves through and a digest does not.
const AGPL3_TEXT_SHA256 = 'd8a6cc31abc16b6748c7a21f21611f5a1ec33f67d22ca23d7da1c19b95496bee';

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const json = (rel) => JSON.parse(read(rel));

test('LICENSE is the complete unmodified AGPL-3.0 text', () => {
  const bytes = fs.readFileSync(path.join(ROOT, 'LICENSE'));
  assert.equal(
    crypto.createHash('sha256').update(bytes).digest('hex'), AGPL3_TEXT_SHA256,
    'LICENSE must be the complete unmodified SPDX AGPL-3.0 text',
  );
});

test('every RespawnPack-owned manifest declares the SPDX id', () => {
  // examples/todo-app is deliberately absent: it is a fixture repo demonstrating what an INSTALLED
  // target looks like, not a part of the pack, and it declares no license at all.
  for (const manifest of ['memory/engine/package.json']) {
    assert.equal(json(manifest).license, SPDX, manifest);
  }
  assert.equal(
    json('memory/engine/package-lock.json').packages[''].license, SPDX,
    'memory/engine/package-lock.json root entry drifts from its package.json unless it is written too',
  );
});

test('the notice installed into a target states the license and scopes it correctly', () => {
  /*
   * ⛔ THE FAILURE THIS PREVENTS, WHICH IS THE ONE THAT REACHES OTHER PEOPLE'S REPOSITORIES. The
   * installer places ~114 of this pack's own files under a target's `.claude/`. Without a notice
   * travelling with them, a founder who publishes that repository, or serves it over a network, is
   * carrying AGPL obligations they had no way to discover from their own tree — the only other
   * license-bearing file installed is ATTRIBUTION.md, which credits THIRD PARTIES and is silent on
   * this pack's own terms.
   *
   * The scoping assertions matter as much as the license one, and arguably more. A notice that says
   * "AGPL" without saying what it does NOT cover is worse than none: it invites a founder to
   * conclude their own product is AGPL because a tool they installed is. It is not, and the notice
   * has to say so in as many words.
   */
  const notice = read('templates/LICENSE.respawnpack');
  assert.ok(notice.includes(SPDX), 'the installed notice must state the SPDX id');
  assert.match(notice, /remotely over a network|remotely through a computer network/i,
    'the notice must state the network-use obligation, which is the whole reason this license was chosen');
  assert.match(notice, /Your project is yours/i,
    'the notice must say plainly what it does NOT cover — an unscoped notice reads as a claim on the founder\'s own work');
  assert.match(notice, /under whatever license you choose/i,
    'the notice must leave the founder\'s own licensing to the founder, in as many words');
  assert.match(notice, /ATTRIBUTION\.md/,
    'the notice must point at the third-party credits, whose licenses it does not govern');

  // The installer must actually place it, and the uninstaller must actually take it back: a notice
  // that is never placed protects nobody, and one that outlives the pack it describes is a false
  // statement about a repository that no longer contains the files.
  assert.match(read('install/install.js'), /place\('templates\/LICENSE\.respawnpack',\s*'\.claude\/LICENSE\.respawnpack'\)/);
  assert.match(read('install/uninstall.js'), /rel: '\.claude\/LICENSE\.respawnpack'/);
  // The managed CLAUDE.md block points at it, so the agent reading that block can answer a licensing
  // question correctly instead of guessing from the presence of AGPL files.
  assert.match(read('templates/CLAUDE.md'), /LICENSE\.respawnpack/);
});

test('every document that names the license names the same one', () => {
  for (const doc of ['README.md', 'ATTRIBUTION.md', 'library/README.md', 'docs/vision/VISION.md', 'docs/vision/ARCHITECTURE.md']) {
    assert.ok(read(doc).includes(SPDX), `${doc} must state ${SPDX}`);
  }

  /*
   * ⛔ THE §13 OBLIGATION IS ASSERTED AGAINST THE INSTALLED NOTICE, NOT THE README — a relocation,
   * not a relaxation. An earlier version of this fence made the README summarise the network clause,
   * reasoning that "AGPL" alone does not tell a reader what AGPL costs them. Right about who needs
   * telling, wrong about where: the person who incurs the obligation is whoever ends up with this
   * code in their repository, and `.claude/LICENSE.respawnpack` is what reaches them. It travels
   * with every install, and the notice test above requires it to state the network term in as many
   * words — so the disclosure is enforced closer to the reader than it was here, not dropped.
   *
   * The README is the shop window, and what it summarises is presentation. The LICENSE file governs
   * either way. This fence keeps the SPDX id, which is a factual claim about the project, and stops
   * legislating prose that is the author's to write.
   */
  assert.ok(read('templates/LICENSE.respawnpack').includes(SPDX),
    'the notice that actually reaches an installed repository must name the license too');
});

test('no conflicting claim about RespawnPack\'s own license survives', () => {
  /*
   * Written to catch ANY self-referential license claim that is not the SPDX id, rather than to
   * hunt for one specific license name. Two reasons, and the second is the load-bearing one:
   *
   *   • A named-license search goes stale the moment a different wrong name appears. This shape
   *     catches whatever is actually written there.
   *   • A bare search for a license NAME cannot tell "RespawnPack is X" from "upstream is X, and we
   *     credit them for it" — and this repo is full of the second kind, legitimately. Anchoring on
   *     the SELF-REFERENTIAL phrasings is what keeps the two apart, so the check can be strict
   *     without threatening a single line of third-party attribution.
   */
  const SELF_CLAIM = [
    /RespawnPack-original,\s*\*{0,2}([A-Za-z0-9.+-]+)/g,
    /([A-Za-z0-9.+-]+)-licensed (?:with|like) the rest of the (?:pack|framework)/g,
    /RespawnPack is ([A-Za-z0-9.+-]+)-licensed/g,
    // Catches the ARCHITECTURE.md-shaped self-claim: the pack naming its own `LICENSE` file (backticked,
    // as a filename) immediately followed by a parenthetical license name, e.g. "`LICENSE` (MIT)". This
    // is anchored on the literal backticked word LICENSE so it cannot fire on a third-party credit like
    // "(agency-agents, MIT)" or "MIT (`LICENSE`, copyright ...)", where the parenthesis does not directly
    // follow this pack's own LICENSE file reference.
    /`LICENSE`\s*\(([A-Za-z0-9.+-]+)\)/g,
  ];
  // The capture group takes whatever word sits in the license slot, which is not always a license:
  // "RespawnPack-original, authored by …" is ordinary prose and putting it in the same bucket as a
  // wrong license name would make this test cry wolf until someone loosened it. Only a token that
  // actually looks like a license identifier is judged; anything else is prose and is left alone.
  const LICENSE_LIKE = /^(?:MIT|ISC|BSD|Apache|GPL|LGPL|AGPL|MPL|EPL|CDDL|Zlib|Unlicense|CC0?|WTFPL|Proprietary)(?:[-.\w]*)$/i;
  const ACCEPTABLE = new Set([SPDX, 'AGPL', 'AGPLv3', 'AGPL-3.0']);

  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      // `.claude/` holds untracked local state: builder worktrees under .claude/worktrees/ carry
      // OLDER copies of this tree, so scanning them reports claims this commit already fixed.
      if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.claude') continue;
      // docs/dev/ is dev-only (release/build-public.sh strips it) and its audit records quote retired
      // claims as EVIDENCE, so the walk that guards the shipped package stops at that directory.
      if (entry.name === 'dev' && path.relative(ROOT, dir) === 'docs') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.(md|json|mjs|js|ya?ml)$/.test(entry.name)) continue;
      if (full === fileURLToPath(import.meta.url)) continue; // this file names the shapes it hunts
      const text = fs.readFileSync(full, 'utf8');
      for (const pattern of SELF_CLAIM) {
        for (const m of text.matchAll(pattern)) {
          if (LICENSE_LIKE.test(m[1]) && !ACCEPTABLE.has(m[1])) {
            offenders.push(`${path.relative(ROOT, full)} :: "${m[0].trim()}"`);
          }
        }
      }
    }
  };
  walk(ROOT);
  assert.deepEqual(offenders, [], `license claims conflicting with ${SPDX}:\n${offenders.join('\n')}`);
});

test('third-party attribution is intact and was not collateral damage', () => {
  // The counterweight to the test above. These upstreams are credited under licenses this project
  // does not own and cannot change; if a future sweep takes them out, the pack is redistributing
  // other people's work with the credit stripped off it.
  const attribution = read('ATTRIBUTION.md');
  for (const upstream of [
    'msitarzewski/agency-agents',            // the ~134-skill persona bulk
    'cloudflare/skills',                     // Apache-2.0
    'vercel-labs/web-interface-guidelines',  // the design-standard source
  ]) {
    assert.ok(attribution.includes(upstream), `ATTRIBUTION.md must still credit ${upstream}`);
  }

  const mitCredits = (attribution.match(/MIT/g) ?? []).length;
  assert.ok(
    mitCredits >= 15,
    `ATTRIBUTION.md carries only ${mitCredits} MIT references; the third-party credits appear to ` +
    'have been stripped by an over-broad sweep',
  );

  // Apache-2.0 §4 requires retaining attribution on redistribution. The pack references rather than
  // vendors these, but the credit is what discharges the obligation either way.
  assert.ok(attribution.includes('Apache-2.0'), 'ATTRIBUTION.md must still record Apache-2.0 upstreams');
});

test('the package states its license without narrating a licensing history', () => {
  // A deliberate product decision, recorded here so it cannot be undone by accident: this package
  // says what it is licensed under and does not discuss its own licensing as a story with earlier
  // chapters. Silence is not a false statement — an affirmative claim about the past would be one,
  // in either direction, so none is permitted here.
  const HISTORY_TALK = [
    /(?:formerly|previously|originally|used to be|no longer)\s+[A-Za-z0-9.+-]*\s*licen[cs]/i,
    /relicens/i,
    /license\s+(?:change|migration|switch)/i,
  ];
  for (const doc of ['README.md', 'ATTRIBUTION.md', 'library/README.md', 'docs/vision/VISION.md']) {
    const text = read(doc);
    for (const pattern of HISTORY_TALK) {
      assert.ok(!pattern.test(text), `${doc} narrates a licensing history (${pattern}); it must not`);
    }
  }
});
