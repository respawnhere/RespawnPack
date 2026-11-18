/*
 * RespawnPack · install/_scoping.js — THE LARGE-TREE SCOPING DETECTOR AND ITS HOST-SETTINGS PROJECTION (D1).
 *
 * NOT AN INSTALLED FILE, AND NOT A HOOK (leading underscore). It is required by `install/install.js`,
 * whose §2b-bis runs the detector and whose summary prints or writes what it emits, and by
 * `install/_scoping.test.mjs`, which exercises the two-signal rule in isolation. It has NO side effects at
 * require time (no process exit, no write), so it is a pure module the way `hooks/_posture.js` is — which
 * is why the installer may require it. `kernel/respawnpack.js` does NOT require it: on an installed target
 * `install/` is pack source that never travels, so doctor restates the two-signal rule in prose and reads
 * the receipt instead (the same reason doctor restates install.js's PROJECT_TYPE_DROPS rather than
 * requiring it).
 *
 * ═══ THE TWO-SIGNAL RULE, STATED ONCE HERE SO THE INSTALLER AND THE TESTS CANNOT DISAGREE ═════════════
 *
 * A directory is NAMED (gets a `Read` deny, a `claudeMdExcludes` pattern, and — if it is a dependency
 * directory — a worktree symlink) only when BOTH signals hold:
 *
 *   SIGNAL 1 · it is a CONVENTIONAL asset/generated name (CONVENTIONAL_NAMES / CONVENTIONAL_PATHS /
 *              the `*.xcassets` glob) OR a directory the target's `.gitignore` ignores as a whole
 *              single-segment directory (top level or one level down, read with the same bounded probe
 *              the stack detector uses). A name alone is signal 1, never the verdict.
 *   SIGNAL 2 · it is LARGE OR BINARY by a cheap measure: more than ENTRY_COUNT_SIGNAL entries at one
 *              level, OR more than SIZE_SIGNAL_BYTES of top-of-directory files, OR more than half of its
 *              sampled files by count carry a binary extension (BINARY_EXTENSIONS). At most SAMPLE_CAP
 *              entries are read per directory and the directory is NEVER walked.
 *
 * ⛔ THE ENTRY-COUNT SIGNAL QUALIFIES A CONVENTIONAL NAME, NOT A GITIGNORED-ONLY ONE. A conventional name
 * (`dist`, `node_modules`) is already a strong prior that the directory is generated, so many entries
 * confirms it; a `.gitignore` entry is arbitrary and may name a `docs/` of 300 markdown files, which a
 * `Read` deny would wrongly block. So a directory held by signal 1 ONLY through `.gitignore` must meet
 * the stronger SIZE or BINARY signal — the brief's own nearest bypass: "a target whose `.gitignore`
 * ignores `docs/` does not get `docs/` denied unless the size or binary signal also holds". The field's
 * pain was 8.8 GB of binary directories, which the size and binary signals catch.
 *
 * An empty `dist/` matches signal 1 only and is not named. A `notes/` of 300 markdown files matches
 * neither a conventional name nor `.gitignore`, so signal 1 fails and it is not named even though it is
 * large by count. A gitignored `docs/` of text fails the size and binary signals, so it is not named.
 * Both signals, every time.
 *
 * ⛔ A DOTFILE SECRETS PATTERN IS NEVER EMITTED. On host 2.1.259 and later a `Read(.env*)` deny made every
 * `cd DIR && grep` prompt for approval (the review's evidence, gsd-core PR #4236), because a bare dotfile
 * glob interacts with the Bash redirection and cd-relative checks. This module only ever builds an
 * explicit `Read(<dir>/**)` glob with a named directory segment, never a bare `*.env`/`.env*` pattern; and
 * any candidate whose top segment is in the `.env` family (DOTFILE_BAN) is refused BY NAME even if it
 * qualifies by size. `.next`/`.nuxt`/`.svelte-kit`/`.venv`/`.tox` are vetted conventional dotdirs and are
 * allowed; a gitignored dotdir the detector does not already vet is skipped, so an unknown `.secrets/`
 * cannot become a rule.
 */
'use strict';
const fs = require('fs');
const path = require('path');

// Signal-2 thresholds — a cheap measure, never a walk.
const ENTRY_COUNT_SIGNAL = 200;              // more than this many entries at one level
const SIZE_SIGNAL_BYTES = 50 * 1024 * 1024;  // or more than 50 MB of top-of-directory files
const SAMPLE_CAP = 500;                       // read at most this many entries per directory

// Conventional asset/generated directory names (exact single segment). A name is signal 1, not a verdict.
const CONVENTIONAL_NAMES = new Set([
  'node_modules', 'dist', 'build', 'out', '.next', '.nuxt', '.svelte-kit', 'coverage',
  'target', 'vendor', '__pycache__', '.venv', 'venv', '.tox', 'bin', 'obj',
]);
// Conventional asset/generated paths one level deep (matched as a whole relative path).
const CONVENTIONAL_PATHS = new Set([
  'public/assets', 'public/static', 'static/media', 'assets/media',
]);
// Dependency directories, the subset of the named set a writer's worktree should SHARE rather than
// re-install — these become `worktree.symlinkDirectories`.
const DEPENDENCY_NAMES = new Set(['node_modules', 'vendor', '.venv', 'venv', 'target']);

// Binary extensions (no leading dot), a fixed list: images, audio, video, archives, fonts, compiled
// objects, model weights. SVG is text and is deliberately absent.
const BINARY_EXTENSIONS = new Set([
  // images
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'tif', 'tiff', 'heic', 'avif', 'psd',
  // audio
  'mp3', 'wav', 'flac', 'ogg', 'aac', 'm4a', 'opus',
  // video
  'mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v', 'wmv',
  // archives
  'zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'jar', 'war',
  // fonts
  'ttf', 'otf', 'woff', 'woff2', 'eot',
  // compiled objects
  'o', 'obj', 'a', 'lib', 'so', 'dll', 'dylib', 'class', 'pyc', 'pyo', 'wasm', 'node',
  // model weights
  'pt', 'pth', 'onnx', 'safetensors', 'gguf', 'ggml', 'h5', 'pb', 'ckpt', 'bin',
]);

// The `.env` secrets family. A candidate whose top path segment matches is refused by name.
const DOTFILE_BAN = /^\.env($|\.)/i;

/*
 * The languages the detector recognises, each by a marker at the root or one level down, mapped to the
 * host's OFFICIAL code-intelligence (LSP) plugin as the plugin table lists it
 * (https://code.claude.com/docs/en/plugins/code-intelligence, read 2026-10-10 as data; thirteen official
 * plugins). A language with no official plugin carries `plugin: null`, which the summary reports as "no
 * official plugin". The pack never installs a plugin and never writes `enabledPlugins`: plugin enablement
 * is the user's own marketplace action, and a wrong write there is a settings fault the pack cannot
 * verify. The recommendation is printed and recorded only.
 */
const LANGUAGE_MARKERS = [
  { language: 'TypeScript or JavaScript', plugin: 'typescript-lsp', markers: ['package.json', 'tsconfig.json'] },
  { language: 'Python', plugin: 'pyright-lsp', markers: ['pyproject.toml', 'setup.py', 'requirements.txt'] },
  { language: 'Go', plugin: 'gopls-lsp', markers: ['go.mod'] },
  { language: 'Rust', plugin: 'rust-analyzer-lsp', markers: ['Cargo.toml'] },
  { language: 'Java or Kotlin', plugin: 'jdtls-lsp', markers: ['pom.xml'], markerGlobs: [/^build\.gradle/] },
  { language: 'C#', plugin: 'csharp-lsp', markerGlobs: [/\.csproj$/, /\.sln$/] },
  { language: 'Ruby', plugin: 'ruby-lsp', markers: ['Gemfile'] },
  { language: 'PHP', plugin: 'php-lsp', markers: ['composer.json'] },
  { language: 'Swift', plugin: 'swift-lsp', markers: ['Package.swift'] },
  { language: 'Elixir', plugin: null, markers: ['mix.exs'] },
  // C or C++: a build file AND a C/C++ source at the root, so a bare Makefile in a non-C project does not
  // claim the language.
  { language: 'C or C++', plugin: 'clangd-lsp', markers: ['CMakeLists.txt'], needsCSource: true },
];

const posix = (p) => String(p).replace(/\\/g, '/');

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

// The bounded one-level probe the stack detector uses: fixed `backend`/`frontend`, plus each immediate
// child of `apps`/`services`/`packages`. Returns target-relative posix prefixes, '' for the root first.
function probePrefixes(targetDir) {
  const out = [''];
  for (const name of ['backend', 'frontend']) if (isDir(path.join(targetDir, name))) out.push(name);
  for (const parent of ['apps', 'services', 'packages']) {
    let kids = [];
    try { kids = fs.readdirSync(path.join(targetDir, parent), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => `${parent}/${e.name}`); }
    catch { /* parent absent */ }
    out.push(...kids);
  }
  return out;
}

/*
 * The single-segment directory names the target's top-level `.gitignore` ignores whole. Deliberately
 * narrow: a line is read as a directory name only when it is one path segment, with no wildcard and no
 * negation. That is enough for the conventional `dist/`, `node_modules/`, `docs/` forms the field carries,
 * and it never guesses at a glob. Returned as a lowercased set of names, checked per probe prefix below.
 */
function gitignoredNames(targetDir) {
  const names = new Set();
  let text;
  try { text = fs.readFileSync(path.join(targetDir, '.gitignore'), 'utf8'); } catch { return names; }
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    line = line.replace(/^\/+/, '').replace(/\/+$/, '');
    if (!line || line.includes('/') || /[*?\[\]]/.test(line)) continue; // one plain segment only
    names.add(line);
  }
  return names;
}

const ext = (name) => { const i = name.lastIndexOf('.'); return i > 0 ? name.slice(i + 1).toLowerCase() : ''; };

/*
 * Signal 2, by a cheap measure that never walks. Reads the directory once (at most SAMPLE_CAP entries),
 * counts entries for the count signal, sums top-of-directory FILE sizes for the size signal, and tallies
 * binary extensions among sampled files for the binary-majority signal. Returns each signal as a boolean
 * plus a per-signal reason string; the caller decides which signals apply (count is only honoured for a
 * conventional name — see detect()).
 */
function measureDir(dirAbs) {
  let entries;
  try { entries = fs.readdirSync(dirAbs, { withFileTypes: true }); } catch { return { count: false, size: false, binary: false, reason: {}, bytes: 0, entries: 0 }; }
  const entryCount = entries.length;
  const sample = entries.slice(0, SAMPLE_CAP);
  let bytes = 0;
  let fileCount = 0;
  let binaryCount = 0;
  for (const e of sample) {
    if (!e.isFile()) continue;
    fileCount++;
    if (BINARY_EXTENSIONS.has(ext(e.name))) binaryCount++;
    try { bytes += fs.statSync(path.join(dirAbs, e.name)).size; } catch { /* vanished mid-read */ }
  }
  const count = entryCount > ENTRY_COUNT_SIGNAL;
  const size = bytes > SIZE_SIGNAL_BYTES;
  const binary = fileCount > 0 && binaryCount > fileCount / 2;
  return {
    count, size, binary, bytes, entries: entryCount,
    reason: {
      count: `${entryCount} entries`,
      size: `${Math.round(bytes / (1024 * 1024))} MB`,
      binary: `${binaryCount}/${fileCount} binary`,
    },
  };
}

// Conventional-name signal 1 for a single segment (exact name or the *.xcassets glob).
function isConventionalName(name) {
  return CONVENTIONAL_NAMES.has(name) || /\.xcassets$/.test(name);
}

/*
 * Enumerate the candidate directories (signal 1 holders) under one probe prefix, as target-relative posix
 * paths. Conventional single names, the `*.xcassets` glob, the conventional one-deep paths, and any
 * gitignored single-segment directory that exists here.
 */
function candidatesUnder(targetDir, prefix, giNames) {
  const base = prefix ? path.join(targetDir, prefix) : targetDir;
  const rel = (name) => (prefix ? `${prefix}/${name}` : name);
  const found = new Map(); // relPath -> reason tag ('conventional' | 'gitignore')
  let entries = [];
  try { entries = fs.readdirSync(base, { withFileTypes: true }); } catch { return found; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (isConventionalName(e.name)) found.set(rel(e.name), 'conventional');
    else if (giNames.has(e.name)) found.set(rel(e.name), 'gitignore');
  }
  // Conventional one-deep paths (e.g. public/assets) are checked as whole paths under this prefix.
  for (const cp of CONVENTIONAL_PATHS) {
    if (isDir(path.join(base, cp))) found.set(rel(cp), 'conventional');
  }
  return found;
}

// Detect the languages present (root or one level down), mapped to their LSP plugin.
function detectLanguages(targetDir, prefixes) {
  const seen = new Set();
  const out = [];
  const here = (prefix, name) => fs.existsSync(path.join(prefix ? path.join(targetDir, prefix) : targetDir, name));
  const listing = (prefix) => { try { return fs.readdirSync(prefix ? path.join(targetDir, prefix) : targetDir); } catch { return []; } };
  for (const prefix of prefixes) {
    const names = listing(prefix);
    for (const def of LANGUAGE_MARKERS) {
      if (seen.has(def.language)) continue;
      let hit = (def.markers || []).some((m) => here(prefix, m));
      if (!hit && def.markerGlobs) hit = names.some((n) => def.markerGlobs.some((re) => re.test(n)));
      if (hit && def.needsCSource) hit = names.some((n) => /\.(c|cc|cpp|cxx|h|hpp)$/i.test(n));
      if (hit) { seen.add(def.language); out.push({ language: def.language, plugin: def.plugin }); }
    }
  }
  return out;
}

/*
 * Run the whole detection against a target. Returns the structured result the installer prints or writes.
 * `applies` is the gate: when no directory is named, NOTHING is emitted — no deny rule, no exclude, no
 * worktree key, and no LSP line (the LSP recommendation rides the large-tree scoping block, so a project
 * with a language but no large tree emits nothing, which is why `examples/todo-app` emits nothing).
 */
function detect(targetDir) {
  const prefixes = probePrefixes(targetDir);
  const giNames = gitignoredNames(targetDir);
  const named = []; // { dir, bytes, reasons }
  const seen = new Set();
  for (const prefix of prefixes) {
    for (const [relPath, signal1] of candidatesUnder(targetDir, prefix, giNames)) {
      if (seen.has(relPath)) continue;
      seen.add(relPath);
      const topSeg = relPath.split('/')[0];
      if (DOTFILE_BAN.test(topSeg)) continue;        // never a dotfile secrets pattern
      if (signal1 === 'gitignore' && topSeg.startsWith('.')) continue; // an unvetted gitignored dotdir is skipped
      const m = measureDir(path.join(targetDir, relPath));
      // Count qualifies a conventional name; a gitignored-only name needs size or binary (see the header).
      const signals = [];
      if (signal1 === 'conventional' && m.count) signals.push(m.reason.count);
      if (m.size) signals.push(m.reason.size);
      if (m.binary) signals.push(m.reason.binary);
      if (!signals.length) continue;                 // signal 1 held, signal 2 did not
      named.push({ dir: relPath, bytes: m.bytes, reasons: signals });
    }
  }
  named.sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0)); // stable order for the deny list
  const directories = named.map((n) => n.dir);
  const denyRules = directories.map((d) => `Read(${d}/**)`);
  // Two excludes per directory: a CLAUDE.md DIRECTLY inside it (`**/<dir>/CLAUDE.md`) and one NESTED any
  // depth below (`**/<dir>/**/CLAUDE.md`). The nested form relies on `**` matching zero segments to catch
  // the direct child, which not every glob engine does, so the direct form is emitted beside it. Both
  // carry the `**/` prefix because the host matches claudeMdExcludes against ABSOLUTE paths (settings
  // reference), so a bare `<dir>/CLAUDE.md` would never match.
  const excludes = directories.flatMap((d) => [`**/${d}/CLAUDE.md`, `**/${d}/**/CLAUDE.md`]);
  const symlinkDirectories = directories.filter((d) => !d.includes('/') && DEPENDENCY_NAMES.has(d));
  // The LSP recommendation rides the large-tree scoping block: a project with a language but no large
  // tree emits nothing (so `examples/todo-app` emits nothing), which is why it is gated on `applies`.
  const lsp = directories.length ? detectLanguages(targetDir, prefixes) : [];
  const sparse = computeSparse(targetDir, directories);
  return {
    applies: directories.length > 0,
    directories,
    named,
    denyRules,
    excludes,
    symlinkDirectories,
    sparsePaths: sparse.complement,
    sparseApplicable: sparse.applicable,
    lsp,
  };
}

/*
 * `worktree.sparsePaths` — emitted (as a preview, and written only with `--write-settings --sparse`) when
 * the named set dominates the top-level tree by size, and then as the COMPLEMENT: the top-level
 * directories the detector did NOT name, because a sparse checkout that omits a directory a test needs
 * breaks the writer silently. Size is the same cheap one-level measure as signal 2, never a walk; a
 * top-level directory's size is the sum of its top-of-directory files (a dependency directory of nested
 * packages measures near zero, which is deliberate — its weight is depth the sparse list cannot cheaply
 * see, and erring small keeps the complement generous).
 */
function computeSparse(targetDir, directories) {
  /*
   * ⛔ A TOP-LEVEL DIRECTORY IS DROPPED FROM THE COMPLEMENT ONLY WHEN ITS WHOLE SINGLE SEGMENT IS NAMED.
   * A nested named path like `public/assets` does NOT mark `public` as named: `public` stays in the
   * complement, so a sparse checkout keeps `public/index.html` (the silent omission the complement exists
   * to prevent), and the `Read(public/assets/**)` deny covers the heavy subdirectory instead. The size
   * dominance still counts a nested named directory's own one-level bytes, so a heavy nested directory can
   * still trigger sparse without dragging its light parent out of the checkout.
   */
  const wholeNamedTop = new Set(directories.filter((d) => !d.includes('/')));
  const nestedNamed = directories.filter((d) => d.includes('/'));
  let topDirs = [];
  try { topDirs = fs.readdirSync(targetDir, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name !== '.git').map((e) => e.name); }
  catch { return { applicable: false, complement: [] }; }
  const sizeOf = (rel) => measureDir(path.join(targetDir, rel)).bytes;
  let namedBytes = 0;
  let totalBytes = 0;
  for (const name of topDirs) {
    const b = sizeOf(name);
    totalBytes += b;
    if (wholeNamedTop.has(name)) namedBytes += b;
  }
  // A nested named directory's one-level bytes join BOTH sums (its parent top dir measured only its own
  // direct files, disjoint from the nested dir's), so the heavy nested set still counts toward dominance.
  for (const rel of nestedNamed) { const b = sizeOf(rel); namedBytes += b; totalBytes += b; }
  const applicable = totalBytes > 0 && namedBytes > totalBytes / 2;
  const complement = topDirs.filter((d) => !wholeNamedTop.has(d)).sort();
  return { applicable, complement };
}

/*
 * Render the human-readable block the installer prints. The BODY (everything the array returns) is
 * identical in a preview and in a `--write-settings --sparse` run; only the installer's heading differs,
 * which is the "same bytes modulo the heading" the pin rests on. `sparse` decides whether the
 * sparsePaths lines appear, so a preview (which shows the full potential) and a `--sparse` write render
 * the same body.
 */
function renderBlock(result, { sparse } = {}) {
  const showSparse = sparse && result.sparseApplicable && result.sparsePaths.length;
  const lines = [];
  lines.push(`${result.directories.length} director(ies) named by the two-signal rule (conventional-or-gitignored AND large-or-binary):`);
  for (const n of result.named) lines.push(`  ${n.dir}  (${n.reasons.join(', ')})`);
  lines.push('permissions.deny (Read; a Read deny also blocks Edit and Write, so a generated dir you edit by hand is blocked — this is why it is a preview first):');
  for (const r of result.denyRules) lines.push(`  ${r}`);
  lines.push('claudeMdExcludes:');
  for (const e of result.excludes) lines.push(`  ${e}`);
  if (result.symlinkDirectories.length) {
    lines.push('worktree.symlinkDirectories:');
    for (const d of result.symlinkDirectories) lines.push(`  ${d}`);
  }
  if (showSparse) {
    lines.push('worktree.sparsePaths (the named set covers more than half the tree by size; the COMPLEMENT, so no needed dir is omitted; written only with --write-settings --sparse):');
    for (const p of result.sparsePaths) lines.push(`  ${p}`);
  }
  if (result.lsp.length) {
    lines.push('LSP code-intelligence plugin (recommendation only — the pack never installs a plugin or writes enabledPlugins):');
    for (const l of result.lsp) lines.push(`  ${l.language} -> ${l.plugin || 'no official plugin'}`);
  }
  return lines.join('\n');
}

module.exports = {
  ENTRY_COUNT_SIGNAL, SIZE_SIGNAL_BYTES, SAMPLE_CAP,
  CONVENTIONAL_NAMES, CONVENTIONAL_PATHS, DEPENDENCY_NAMES, BINARY_EXTENSIONS, DOTFILE_BAN, LANGUAGE_MARKERS,
  posix, probePrefixes, gitignoredNames, measureDir, isConventionalName, detectLanguages,
  detect, computeSparse, renderBlock,
};
