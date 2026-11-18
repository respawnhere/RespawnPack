// install/_scoping.test.mjs — the large-tree scoping detector (D1), exercised in isolation. Three states
// for the two-signal rule: a qualifying directory IS named (the fix), and every nearest bypass is not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scoping = createRequire(import.meta.url)(path.join(__dirname, '_scoping.js'));

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rp-scoping-'));
}
// Make a directory holding `n` files named with `ext`, each `bytes` long; returns the dir path.
function dirWith(root, rel, n, ext, bytes = 1) {
  const d = path.join(root, rel);
  fs.mkdirSync(d, { recursive: true });
  const blob = Buffer.alloc(bytes, 0x61);
  for (let i = 0; i < n; i++) fs.writeFileSync(path.join(d, `f${i}.${ext}`), blob);
  return d;
}
function packageDirs(root, rel, n) {
  for (let i = 0; i < n; i++) {
    const d = path.join(root, rel, `pkg${i}`);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'package.json'), '{}');
  }
}

test('CORRECTED: a 300-entry dist/ of .png and a 250-dir node_modules/ are named, with the right denies, excludes, symlink and LSP', (t) => {
  const root = tmp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  dirWith(root, 'dist', 300, 'png');
  packageDirs(root, 'node_modules', 250);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'x', dependencies: { next: '1' } }));

  const r = scoping.detect(root);
  assert.equal(r.applies, true);
  assert.deepEqual(r.directories, ['dist', 'node_modules'], 'both qualify; stable sorted order');
  assert.deepEqual(r.denyRules, ['Read(dist/**)', 'Read(node_modules/**)']);
  // Two excludes per directory: a CLAUDE.md DIRECTLY inside, and one NESTED any depth below (the pair
  // covers both regardless of whether the host's `**` matches zero segments), both `**/`-prefixed for the
  // host's absolute-path matching.
  assert.deepEqual(r.excludes, [
    '**/dist/CLAUDE.md', '**/dist/**/CLAUDE.md',
    '**/node_modules/CLAUDE.md', '**/node_modules/**/CLAUDE.md',
  ]);
  assert.deepEqual(r.symlinkDirectories, ['node_modules'], 'only the dependency dir is symlinked, not dist');
  assert.deepEqual(r.lsp, [{ language: 'TypeScript or JavaScript', plugin: 'typescript-lsp' }]);
  // The deny rule is an explicit Read(<dir>/**), never a bare dotfile glob.
  for (const rule of r.denyRules) assert.match(rule, /^Read\([^.][^(]*\/\*\*\)$/);
});

test('BYPASS: a dotfile secrets pattern is never emitted, even when a .env directory qualifies by size and binary', (t) => {
  const root = tmp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  dirWith(root, '.env', 300, 'png');                    // huge AND binary AND gitignored
  fs.writeFileSync(path.join(root, '.gitignore'), '.env\n');
  const r = scoping.detect(root);
  assert.deepEqual(r.directories, [], 'a .env directory is refused by name');
  assert.ok(!r.denyRules.some((x) => /\.env/.test(x)), 'no rule mentions .env');
  assert.ok(!r.denyRules.some((x) => /\.env\*/.test(x)), 'never the gsd-core Read(.env*) shape');
  assert.equal(scoping.DOTFILE_BAN.test('.env'), true);
  assert.equal(scoping.DOTFILE_BAN.test('.env.local'), true);
  assert.equal(scoping.DOTFILE_BAN.test('.venv'), false, '.venv is a vetted conventional dotdir, not the .env family');
});

test('BYPASS: an empty dist/ is not named (conventional name, no second signal)', (t) => {
  const root = tmp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'dist'));
  assert.deepEqual(scoping.detect(root).directories, []);
});

test('BYPASS: a non-conventional dir of 300 .md files is not named (signal 1 fails, even though count would hold)', (t) => {
  const root = tmp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  dirWith(root, 'notes', 300, 'md');                    // text, not conventional, not gitignored
  assert.deepEqual(scoping.detect(root).directories, []);
});

test('BYPASS: a conventional dir of markdown below the count/size signals is not named (.md is not binary)', (t) => {
  const root = tmp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  dirWith(root, 'coverage', 50, 'md');                  // conventional name, but 50 small text files
  assert.deepEqual(scoping.detect(root).directories, [], 'markdown carries no binary extension and 50 < 200 entries');
});

test('BYPASS: a 60 MB directory of SOURCE files is not named unless it is a conventional or gitignored name', (t) => {
  const root = tmp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  dirWith(root, 'bigsrc', 1, 'ts', 60 * 1024 * 1024);   // 60 MB, but not a conventional/gitignored name
  assert.deepEqual(scoping.detect(root).directories, [], 'size alone cannot name a dir signal 1 does not hold for');
});

test('BYPASS: a gitignored docs/ of text is not denied unless the size or binary signal also holds (count alone does not qualify a gitignored-only name)', (t) => {
  const root = tmp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  dirWith(root, 'docs', 300, 'md');                     // gitignored, 300 entries, but text
  fs.writeFileSync(path.join(root, '.gitignore'), 'docs/\n');
  assert.deepEqual(scoping.detect(root).directories, [], 'gitignored + count only is not enough');

  // but a gitignored dir that IS binary-heavy does qualify (the size/binary half of the bypass)
  const root2 = tmp();
  t.after(() => fs.rmSync(root2, { recursive: true, force: true }));
  dirWith(root2, 'exported', 300, 'jpg');               // gitignored AND binary-majority
  fs.writeFileSync(path.join(root2, '.gitignore'), 'exported/\n');
  assert.deepEqual(scoping.detect(root2).directories, ['exported'], 'gitignored + binary qualifies');
});

test('LSP: Python maps to pyright-lsp, Go to gopls-lsp, and Elixir has no official plugin', (t) => {
  const root = tmp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  dirWith(root, 'dist', 300, 'png');                    // a tree so scoping applies at all
  fs.writeFileSync(path.join(root, 'pyproject.toml'), '');
  fs.writeFileSync(path.join(root, 'go.mod'), 'module x');
  fs.writeFileSync(path.join(root, 'mix.exs'), '');
  const r = scoping.detect(root);
  const byLang = Object.fromEntries(r.lsp.map((l) => [l.language, l.plugin]));
  assert.equal(byLang.Python, 'pyright-lsp');
  assert.equal(byLang.Go, 'gopls-lsp');
  assert.ok('Elixir' in byLang, 'Elixir is detected');
  assert.equal(byLang.Elixir, null, 'Elixir has no official LSP plugin on the host marketplace');
});

test('SPARSE: sparsePaths is applicable and is the COMPLEMENT only when the named set dominates the tree by size', (t) => {
  // named set dominates: a vendor/ with a 60 MB blob, plus a small src/ to keep.
  const root = tmp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  dirWith(root, 'vendor', 1, 'bin', 60 * 1024 * 1024);
  dirWith(root, 'src', 3, 'ts');
  const r = scoping.detect(root);
  assert.deepEqual(r.directories, ['vendor']);
  assert.equal(r.sparseApplicable, true, 'vendor dominates by size');
  assert.deepEqual(r.sparsePaths, ['src'], 'the complement is the dirs NOT named, so no needed dir is omitted');
  assert.deepEqual(r.symlinkDirectories, ['vendor'], 'vendor is a dependency dir');

  // named set does NOT dominate: a small dist/ beside a big src/.
  const root2 = tmp();
  t.after(() => fs.rmSync(root2, { recursive: true, force: true }));
  dirWith(root2, 'dist', 300, 'png', 1);                // many tiny files
  dirWith(root2, 'src', 1, 'ts', 10 * 1024 * 1024);     // 10 MB of source
  const r2 = scoping.detect(root2);
  assert.deepEqual(r2.directories, ['dist']);
  assert.equal(r2.sparseApplicable, false, 'dist does not dominate the tree by size');
});

test('SPARSE: a WHOLE named top-level dir leaves the complement; a NESTED named path keeps its parent (so public/index.html is not silently omitted)', (t) => {
  // Only a NESTED named path (public/assets): public itself is NOT named, so it must stay in the sparse
  // complement — otherwise a sparse checkout would drop public/index.html, the silent omission the
  // complement exists to prevent. The Read(public/assets/**) deny covers the heavy subdirectory instead.
  const root = tmp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  dirWith(root, 'public/assets', 1, 'bin', 60 * 1024 * 1024); // heavy nested dir → qualifies by size, dominates
  fs.writeFileSync(path.join(root, 'public', 'index.html'), '<html>');
  dirWith(root, 'src', 2, 'ts');
  const r = scoping.detect(root);
  assert.deepEqual(r.directories, ['public/assets'], 'only the nested asset dir is named');
  assert.equal(r.sparseApplicable, true, 'the heavy nested dir dominates the tree by size');
  assert.ok(r.sparsePaths.includes('public'), 'public STAYS in the complement — public/index.html must survive a sparse checkout');
  assert.ok(r.sparsePaths.includes('src'), 'src stays too');
  assert.deepEqual(r.denyRules, ['Read(public/assets/**)'], 'the deny covers the heavy subdirectory');

  // A WHOLE named top-level dir (vendor) is dropped from the complement, as before.
  const root2 = tmp();
  t.after(() => fs.rmSync(root2, { recursive: true, force: true }));
  dirWith(root2, 'vendor', 1, 'bin', 60 * 1024 * 1024);
  dirWith(root2, 'src', 2, 'ts');
  const r2 = scoping.detect(root2);
  assert.deepEqual(r2.directories, ['vendor']);
  assert.ok(!r2.sparsePaths.includes('vendor'), 'a whole-named dir is excluded from the complement');
  assert.ok(r2.sparsePaths.includes('src'));
});

test('a document project with no large tree emits nothing even when it has a language', (t) => {
  const root = tmp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'docs' }));
  fs.mkdirSync(path.join(root, 'docs'));
  fs.writeFileSync(path.join(root, 'docs', 'a.md'), 'hello');
  const r = scoping.detect(root);
  assert.equal(r.applies, false, 'no directory qualified, so scoping does not apply');
  assert.deepEqual(r.denyRules, []);
  assert.deepEqual(r.lsp, [], 'the LSP recommendation rides the scoping block and is withheld when nothing applies');
});

test('the preview block body is deterministic and renders every family (the pin anchor)', (t) => {
  const root = tmp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  dirWith(root, 'dist', 300, 'png');
  packageDirs(root, 'node_modules', 250);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'x' }));
  const r = scoping.detect(root);
  const a = scoping.renderBlock(r, { sparse: true });
  const b = scoping.renderBlock(r, { sparse: true });
  assert.equal(a, b, 'renderBlock is pure');
  assert.match(a, /Read\(dist\/\*\*\)/);
  assert.match(a, /claudeMdExcludes/);
  assert.match(a, /symlinkDirectories/);
  assert.match(a, /typescript-lsp/);
});
