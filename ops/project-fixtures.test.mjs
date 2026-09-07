/*
 * RespawnPack · ops/project-fixtures.test.mjs — proves ops/_project-fixtures.mjs materialises the four
 * project archetypes deterministically, matches install/install.js's own projectType vocabulary, and
 * never installs the pack.
 *
 * ⛔ WHY THESE SPECIFIC STATES. Determinism (two materialisations of the same kind list the same files
 * and the same bytes) is what makes the helper trustworthy as a shared fixture rather than a source of
 * flake every task using it would have to re-diagnose. The vocabulary fence (`KINDS` against
 * `install/install.js`'s `PROJECT_TYPE_DROPS`, both directions) is what stops the fixture set and the
 * installer's declared projectType values drifting apart quietly — see the naming note in
 * `_project-fixtures.mjs` for why the fourth kind is spelled `greenfield-app` rather than the audit
 * doc's descriptive "web-app" label. The `detectProfiles` recording is a snapshot of the pack's current
 * truth, kept here so a future detector addition has exactly one place to move it deliberately rather
 * than a test drifting silently out from under a change nobody meant to make. Task Q-1 (2026-09) is the
 * detector addition that last moved it: `kernel/lib/gate.js` learned terraform, ansible, shell, docker,
 * kubernetes and docs, found from the same evidence files these fixtures already carry.
 *
 *   node --test ops/project-fixtures.test.mjs
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import {
  KINDS, materialize,
  AWS_EXAMPLE_KEY, FAKE_STRIPE_KEY, FAKE_STRIPE_SUFFIX, INJECTION_PHRASE,
  TEARDOWN_LINE, BUILD_REVISION_CONSTRUCT,
} from './_project-fixtures.mjs';

const OPS = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(OPS);
const require_ = createRequire(import.meta.url);

let tmpSeq = 0;
function tmp(label) {
  tmpSeq += 1;
  return fs.mkdtempSync(path.join(os.tmpdir(), `rp-fixture-${label}-${tmpSeq}-`));
}
function at(dir, rel) { return path.join(dir, ...rel.split('/')); }
function readAt(dir, rel) { return fs.readFileSync(at(dir, rel), 'utf8'); }

// --- determinism: the property every later task's fixture use depends on ---------------------------

describe('determinism', () => {
  for (const kind of KINDS) {
    test(`${kind}: two materialisations list the same files and the same bytes`, () => {
      const dirA = tmp(`${kind}-a`);
      const dirB = tmp(`${kind}-b`);
      const a = materialize(kind, dirA, { git: false });
      const b = materialize(kind, dirB, { git: false });
      assert.ok(a.files.length > 0, `${kind}: materialize wrote no files`);
      assert.equal(a.kind, kind);
      assert.deepEqual(a.files, b.files, `${kind}: file lists differ between materialisations`);
      for (const rel of a.files) {
        const bytesA = fs.readFileSync(at(dirA, rel));
        const bytesB = fs.readFileSync(at(dirB, rel));
        assert.ok(bytesA.equals(bytesB), `${kind}: ${rel} differs between materialisations`);
      }
    });
  }
});

// --- KINDS vs install/install.js's PROJECT_TYPE_DROPS, both directions -----------------------------

test('KINDS equals install/install.js PROJECT_TYPE_DROPS keys, both directions', () => {
  const src = fs.readFileSync(path.join(ROOT, 'install', 'install.js'), 'utf8');
  const block = /const PROJECT_TYPE_DROPS = \{([\s\S]*?)\n\};/.exec(src);
  assert.ok(block, 'install/install.js no longer declares PROJECT_TYPE_DROPS as a literal object — re-aim this fence rather than deleting it');
  const keys = [...block[1].matchAll(/^\s*'([\w-]+)':/gm)].map((m) => m[1]);
  assert.ok(keys.length > 0, 'no keys parsed out of PROJECT_TYPE_DROPS — the regex above no longer matches its shape');

  const missingFromKinds = keys.filter((k) => !KINDS.includes(k));
  assert.deepEqual(missingFromKinds, [],
    `install/install.js's PROJECT_TYPE_DROPS declares ${missingFromKinds.join(', ')}, which KINDS does not carry — a projectType the installer accepts has no fixture`);

  const missingFromDrops = KINDS.filter((k) => !keys.includes(k));
  assert.deepEqual(missingFromDrops, [],
    `KINDS carries ${missingFromDrops.join(', ')}, which install/install.js's PROJECT_TYPE_DROPS does not declare — a fixture kind the installer would refuse as unknown`);
});

// --- each kind's required files exist with the content the block names -----------------------------

describe('docs-only: a documentation repository, no toolchain', () => {
  const dir = tmp('docs-only-content');
  const { files } = materialize('docs-only', dir, { git: false });

  test('ships the required files', () => {
    for (const rel of ['README.md', 'docs/index.md', 'docs/guide.md', 'docs/security-note.md', '.markdownlint.json']) {
      assert.ok(files.includes(rel), `docs-only: missing ${rel}`);
    }
  });

  test('docs/guide.md carries headings, a nested list, a GFM table, a Mermaid fence and relative links', () => {
    const guide = readAt(dir, 'docs/guide.md');
    assert.match(guide, /^#{1,6} /m, 'no heading found');
    assert.match(guide, /^## /m, 'no second-level heading found');
    assert.match(guide, /\n {2}- /, 'no nested list item found (a bullet indented under another bullet)');
    assert.match(guide, /^\|.+\|\n\|[-\s|]+\|\n/m, 'no GFM table found');
    assert.match(guide, /```mermaid\n[\s\S]*?```/, 'no Mermaid fence found');
    assert.ok(guide.includes('(index.md)'), 'no relative link to index.md');
    assert.ok(guide.includes('(../README.md)'), 'no relative link crossing a directory (../README.md)');
  });

  test('docs/security-note.md quotes the injection phrase inside a fenced block', () => {
    const note = readAt(dir, 'docs/security-note.md');
    const fence = /```\w*\n([\s\S]*?)```/.exec(note);
    assert.ok(fence, 'no fenced block found in docs/security-note.md');
    assert.ok(fence[1].includes(INJECTION_PHRASE), 'the fenced block does not quote the injection phrase');
  });

  test('.markdownlint.json is valid JSON', () => {
    assert.doesNotThrow(() => JSON.parse(readAt(dir, '.markdownlint.json')));
  });
});

describe('ops-infra: Terraform plus an Ansible inventory, a compose file, shell scripts, no app code', () => {
  const dir = tmp('ops-infra-content');
  const { files } = materialize('ops-infra', dir, { git: false });

  test('ships the required files', () => {
    for (const rel of [
      'main.tf', 'variables.tf', 'backend.tf',
      'inventory/range.yml', 'inventory/template.yml', 'ansible.cfg',
      'playbooks/site.yml', 'docker-compose.yml',
      'scripts/teardown.sh', 'docs/setup.md', '.shellcheckrc',
    ]) {
      assert.ok(files.includes(rel), `ops-infra: missing ${rel}`);
    }
  });

  test('backend.tf declares a remote backend', () => {
    const backend = readAt(dir, 'backend.tf');
    assert.match(backend, /backend\s+"(s3|remote|azurerm|gcs|http|consul|etcd|pg)"/,
      'backend.tf does not declare a recognizable remote backend type');
  });

  test('inventory/range.yml declares exactly two hosts', () => {
    const inv = readAt(dir, 'inventory/range.yml');
    const hosts = inv.match(/ansible_host:/g) || [];
    assert.equal(hosts.length, 2, `expected exactly two hosts in inventory/range.yml, found ${hosts.length}`);
  });

  test('scripts/teardown.sh contains the teardown line', () => {
    assert.ok(readAt(dir, 'scripts/teardown.sh').includes(TEARDOWN_LINE),
      'scripts/teardown.sh does not contain the rm -rf teardown line');
  });

  test('docs/setup.md quotes the AWS example key', () => {
    assert.equal(AWS_EXAMPLE_KEY, 'AKIAIOSFODNN7EXAMPLE');
    assert.ok(readAt(dir, 'docs/setup.md').includes(AWS_EXAMPLE_KEY),
      'docs/setup.md does not quote the AWS example key');
  });

  test('no application code: no package.json, no src/ directory', () => {
    assert.ok(!files.includes('package.json'), 'ops-infra should not ship a package.json');
    assert.ok(!files.some((f) => f.startsWith('src/')), 'ops-infra should not ship a src/ directory');
  });
});

describe('greenfield-app: the web-app shape (a Node service with scripts, tests, an OpenAPI file and a schema)', () => {
  const dir = tmp('greenfield-app-content');
  const { files } = materialize('greenfield-app', dir, { git: false });

  test('ships the required files', () => {
    for (const rel of [
      'package.json', 'package-lock.json', 'src/index.js', 'src/health.js',
      'test/app.test.js', 'openapi.yaml', 'prisma/schema.prisma',
      'scripts/build.sh', '.eslintrc.json', 'docs/README.md',
    ]) {
      assert.ok(files.includes(rel), `greenfield-app: missing ${rel}`);
    }
  });

  test('package.json declares lint, test and build scripts', () => {
    const pkg = JSON.parse(readAt(dir, 'package.json'));
    for (const name of ['lint', 'test', 'build']) {
      assert.ok(pkg.scripts && typeof pkg.scripts[name] === 'string' && pkg.scripts[name].length > 0,
        `package.json missing a "${name}" script`);
    }
  });

  test('test/app.test.js carries a 24-character fake sk_live_ key', () => {
    assert.equal(FAKE_STRIPE_SUFFIX.length, 24, 'the fixture constant itself is not 24 characters — fix _project-fixtures.mjs');
    assert.ok(FAKE_STRIPE_KEY.startsWith('sk_live_'));
    assert.ok(readAt(dir, 'test/app.test.js').includes(FAKE_STRIPE_KEY),
      'test/app.test.js does not contain the fake sk_live_ key');
  });

  test('scripts/build.sh uses the $(git rev-parse HEAD) construct', () => {
    assert.equal(BUILD_REVISION_CONSTRUCT, '$(git rev-parse HEAD)');
    assert.ok(readAt(dir, 'scripts/build.sh').includes(BUILD_REVISION_CONSTRUCT),
      'scripts/build.sh does not contain the $(git rev-parse HEAD) construct');
  });

  test('package-lock.json and openapi.yaml parse as their own format', () => {
    assert.doesNotThrow(() => JSON.parse(readAt(dir, 'package-lock.json')));
    assert.match(readAt(dir, 'openapi.yaml'), /^openapi: /m);
  });
});

describe('mature-product: the web-app shape plus CI, CODEOWNERS and a release history', () => {
  const dir = tmp('mature-product-content');
  const { files } = materialize('mature-product', dir, { git: false });

  test('ships the whole greenfield-app shape', () => {
    const greenfield = materialize('greenfield-app', tmp('mature-product-compare'), { git: false });
    const missing = greenfield.files.filter((f) => !files.includes(f));
    assert.deepEqual(missing, [], `mature-product is missing greenfield-app files: ${missing.join(', ')}`);
  });

  test('ships its own additional files', () => {
    for (const rel of ['.github/workflows/ci.yml', '.github/CODEOWNERS', 'CHANGELOG.md', 'migrations/001.sql', 'LICENSE']) {
      assert.ok(files.includes(rel), `mature-product: missing ${rel}`);
    }
  });

  test('.github/CODEOWNERS names a filled owner', () => {
    assert.match(readAt(dir, '.github/CODEOWNERS'), /^\*\s+@\S+/m, 'CODEOWNERS has no filled owner for the * pattern');
  });

  test('CHANGELOG.md records exactly two releases', () => {
    const headings = readAt(dir, 'CHANGELOG.md').match(/^## \S+/gm) || [];
    assert.equal(headings.length, 2, `expected exactly two release headings, found ${headings.length}`);
  });
});

// --- kernel/lib/gate.js detectProfiles, recorded as the pack's current truth -----------------------

// Q-1 gave detectProfiles six more stacks, each found by its own evidence file exactly like the
// original four: terraform (*.tf), ansible (ansible.cfg, or a playbook beside an inventory directory),
// shell (*.sh outside node_modules and .git), docker (Dockerfile*), kubernetes (kustomization.yaml) and
// docs (.markdownlint*). None of the four archetypes here carries a Dockerfile or a kustomization.yaml,
// so those two never appear below — ops-infra's own docker-compose.yml is deliberately not a Dockerfile
// and triggers nothing. greenfield-app and mature-product also carry scripts/build.sh, a genuine shell
// script, so both detect 'shell' beside 'node': a repository can be more than one stack at once, which
// is the whole point of finding presets from evidence rather than asserting one profile per project.
test('kernel/lib/gate.js detectProfiles finds every stack this pack now knows, on all four archetypes', () => {
  const gate = require_(path.join(ROOT, 'kernel', 'lib', 'gate.js'));
  const expected = {
    'docs-only': ['docs'],
    'ops-infra': ['terraform', 'ansible', 'shell'],
    'greenfield-app': ['node', 'shell'],
    'mature-product': ['node', 'shell'],
  };
  for (const kind of KINDS) {
    const dir = tmp(`detect-${kind}`);
    materialize(kind, dir, { git: false });
    const found = gate.detectProfiles(dir).map((p) => p.id);
    assert.deepEqual(found, expected[kind],
      `kernel/lib/gate.js detectProfiles found ${JSON.stringify(found)} for ${kind}, expected ${JSON.stringify(expected[kind])}`);
  }
});

// --- the git option ----------------------------------------------------------------------------------

test('materialize with git:true (the default) commits everything as "fixture"', () => {
  const dir = tmp('git-default');
  const { files } = materialize('docs-only', dir);
  assert.ok(fs.existsSync(path.join(dir, '.git')), 'no .git directory created');

  const log = execFileSync('git', ['log', '--format=%s'], { cwd: dir, encoding: 'utf8' }).trim().split('\n');
  assert.deepEqual(log, ['fixture'], 'expected exactly one commit, messaged "fixture"');

  const status = execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }).trim();
  assert.equal(status, '', 'working tree is not clean after materialize committed it');

  const tracked = execFileSync('git', ['ls-files'], { cwd: dir, encoding: 'utf8' }).trim().split('\n').sort();
  assert.deepEqual(tracked, [...files].sort(), 'git does not track exactly the files materialize reported');
});

test('materialize with git:false creates no .git directory', () => {
  const dir = tmp('git-false');
  materialize('ops-infra', dir, { git: false });
  assert.ok(!fs.existsSync(path.join(dir, '.git')), 'a .git directory was created despite git:false');
});

// --- refusals and the never-installs-the-pack guarantee ---------------------------------------------

test('materialize refuses an unknown kind', () => {
  const dir = tmp('unknown-kind');
  assert.throws(() => materialize('bogus', dir), /unknown kind/);
});

test('the fixture helper never installs the pack', () => {
  // The source is free to DISCUSS install.js in a comment (this module's own banner explains why it
  // never calls it) — what must be absent is an actual import, require or spawn of it. So this checks
  // real invocation syntax, not the bare substring, which a prose mention would also trip.
  const src = fs.readFileSync(path.join(OPS, '_project-fixtures.mjs'), 'utf8');
  assert.doesNotMatch(src, /\b(?:require|import)\s*\([^)]*install\.js/i,
    '_project-fixtures.mjs appears to require()/import() install.js');
  assert.doesNotMatch(src, /\bfrom\s+['"][^'"]*install\.js['"]/,
    '_project-fixtures.mjs appears to import install.js as an ES module');
  assert.doesNotMatch(src, /\b(?:execFileSync|execSync|spawnSync|spawn|exec|fork)\s*\([^)]*install\.js/i,
    '_project-fixtures.mjs appears to spawn install.js as a child process');
  for (const kind of KINDS) {
    const dir = tmp(`no-install-${kind}`);
    const { files } = materialize(kind, dir, { git: false });
    assert.ok(!files.some((f) => f === 'respawnpack.config.json' || f.startsWith('.claude/')),
      `${kind}: materialize wrote pack-installation files`);
    assert.ok(!fs.existsSync(path.join(dir, '.claude')), `${kind}: a .claude directory exists after materialize`);
    assert.ok(!fs.existsSync(path.join(dir, 'respawnpack.config.json')), `${kind}: a respawnpack.config.json exists after materialize`);
  }
});
