/*
 * RespawnPack · kernel/site.test.mjs — the markdown renderer, fenced by goldens from every archetype.
 *
 * ⛔ WHY GOLDENS AND NOT ASSERTIONS ABOUT SUBSTRINGS. `kernel/lib/site.js` is a renderer written in this
 * pack rather than a dependency (owner decision 20), so nothing upstream is going to notice when it
 * starts producing subtly different HTML. A suite that only asserted "the output contains `<table>`"
 * would stay green through a change that dropped every alignment, reordered an attribute, or lost the
 * trailing newline inside a `<pre>` — and O-4b's "a rebuild is byte-identical" claim rests on exactly
 * those bytes. So every fixture document has a committed `.html` beside it and the comparison is on the
 * whole file.
 *
 * ⛔ A GOLDEN CHANGE IS A REVIEWED CHANGE. The goldens in `kernel/site-fixtures/` are the specification
 * of what this renderer emits. When a diff appears there in a pull request it is the change under
 * review, not noise to be re-blessed: read it, decide the new bytes are the ones you meant, and say so
 * in the commit. To regenerate them after a deliberate change:
 *
 *     RESPAWNPACK_SITE_GOLDENS=update node --test kernel/site.test.mjs
 *
 * That mode rewrites every `.html` golden and the two generated-document `.md` inputs, prints each file
 * it wrote, and asserts nothing. Never run it to make a red suite go green without reading the diff.
 *
 * ⛔ THE ARCHETYPES ARE THE POINT. The class this task belongs to is "output shaped for a human": the
 * tracked documents of ANY repository rendered the way they were meant to be read. So the goldens are
 * not a private vocabulary of test documents. They are the real markdown that `ops/_project-fixtures.mjs`
 * materialises for `docs-only`, `ops-infra` and `greenfield-app`, this pack's own `spine/derived/`
 * templates, real generated documents produced by `kernel/lib/render.js` itself, and a set of
 * hand-written edge cases for the constructs no archetype happens to contain.
 *
 * ⛔ ONE FIXTURE IS HERE BECAUSE THE HELPER IS OUT OF SCOPE. The audit's ops-infra archetype is described
 * as carrying runbooks with shell fences and an inventory table; `ops/_project-fixtures.mjs`'s ops-infra
 * kind ships `docs/setup.md`, whose only fence is a `text` block holding an example key. Widening that
 * helper belongs to whoever owns it, not to this task, so the runbook SHAPE is fixtured here as
 * `runbook.md` and the archetype's real document is rendered as well. Both are goldens.
 *
 *   node --test kernel/site.test.mjs
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import { materialize } from '../ops/_project-fixtures.mjs';

const KERNEL = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(KERNEL);
const FIXTURES = path.join(KERNEL, 'site-fixtures');
const require_ = createRequire(import.meta.url);

const SITE = path.join(KERNEL, 'lib', 'site.js');
const { renderMarkdown } = require_(SITE);
const render = require_(path.join(KERNEL, 'lib', 'render.js'));

const UPDATE = process.env.RESPAWNPACK_SITE_GOLDENS === 'update';

// --- golden machinery ---------------------------------------------------------------------------------

/*
 * A unified diff, small enough to read in a test failure. Trimming the common prefix and suffix is what
 * turns "two 400-line files differ" into "line 217 lost its alignment attribute", which is the whole
 * reason a golden suite is usable at all.
 */
function unifiedDiff(expected, actual, label) {
  const a = expected.split('\n');
  const b = actual.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) { endA -= 1; endB -= 1; }
  const context = 3;
  const from = Math.max(0, start - context);
  const out = [`--- ${label} (golden)`, `+++ ${label} (rendered)`, `@@ line ${start + 1} @@`];
  for (let i = from; i < start; i += 1) out.push(` ${a[i]}`);
  for (let i = start; i <= endA; i += 1) out.push(`-${a[i]}`);
  for (let i = start; i <= endB; i += 1) out.push(`+${b[i]}`);
  for (let i = endA + 1; i <= Math.min(a.length - 1, endA + context); i += 1) out.push(` ${a[i]}`);
  return out.join('\n');
}

/** Compare `actual` to the committed golden `name`, or rewrite it under the update mode. */
function golden(name, actual) {
  const file = path.join(FIXTURES, name);
  if (UPDATE) {
    fs.mkdirSync(FIXTURES, { recursive: true });
    fs.writeFileSync(file, actual);
    process.stderr.write(`RESPAWNPACK_SITE_GOLDENS=update: wrote kernel/site-fixtures/${name}\n`);
    return;
  }
  assert.ok(fs.existsSync(file),
    `kernel/site-fixtures/${name} does not exist. Every fixture document is committed beside its golden; `
    + 'run RESPAWNPACK_SITE_GOLDENS=update to create it, then READ the file before committing it.');
  const expected = fs.readFileSync(file, 'utf8');
  if (expected === actual) return;
  assert.fail(`kernel/site-fixtures/${name} does not match what the renderer produces. A golden change is a `
    + 'reviewed change: read the diff, decide these are the bytes you meant, then re-run with '
    + `RESPAWNPACK_SITE_GOLDENS=update.\n${unifiedDiff(expected, actual, name)}`);
}

const readFixture = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');
const listFixtures = (suffix) => fs.readdirSync(FIXTURES).filter((f) => f.endsWith(suffix)).sort();

let tmpSeq = 0;
function tmp(label) {
  tmpSeq += 1;
  return fs.mkdtempSync(path.join(os.tmpdir(), `rp-site-${label}-${tmpSeq}-`));
}

/** The renderer's own escaping rule, restated here so a test can predict a fence's rendered bytes. */
const escapeLike = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// --- the goldens: every fixture document in kernel/site-fixtures/ --------------------------------------

describe('goldens: every committed fixture document', () => {
  const documents = listFixtures('.md');

  test('the fixture directory holds documents to render', () => {
    assert.ok(documents.length >= 8,
      `expected the hand-written and generated fixture set, found ${documents.length} documents`);
  });

  for (const doc of documents) {
    test(`${doc} renders to its committed golden`, () => {
      const out = renderMarkdown(readFixture(doc));
      golden(doc.replace(/\.md$/, '.html'), out.html);
    });
  }
});

// --- the goldens: the project archetypes --------------------------------------------------------------

/*
 * The archetypes' documents are not committed here: they are produced by `ops/_project-fixtures.mjs`,
 * which is itself committed and proved deterministic (bytes and file list) by
 * `ops/project-fixtures.test.mjs`. So the input to each golden below is a tracked source file, exactly
 * as it is for the hand-written fixtures, and a change to an archetype's markdown shows up here as a
 * golden diff rather than as a silent difference in what the pack claims it can render.
 */
const ARCHETYPES = ['docs-only', 'ops-infra', 'greenfield-app'];

describe('goldens: the documents of every project archetype', () => {
  for (const kind of ARCHETYPES) {
    const dir = tmp(kind);
    const { files } = materialize(kind, dir, { git: false });
    const documents = files.filter((f) => f.endsWith('.md'));

    test(`${kind} materialises at least one document to render`, () => {
      assert.ok(documents.length > 0, `${kind}: the archetype carries no markdown at all`);
    });

    for (const rel of documents) {
      test(`${kind}: ${rel} renders to its committed golden`, () => {
        const out = renderMarkdown(fs.readFileSync(path.join(dir, ...rel.split('/')), 'utf8'));
        golden(`archetype-${kind}-${rel.replace(/\//g, '-').replace(/\.md$/, '')}.html`, out.html);
      });
    }
  }

  test('docs-only guide keeps its diagram, its table and its relative links', () => {
    const dir = tmp('docs-only-guide');
    materialize('docs-only', dir, { git: false });
    const out = renderMarkdown(fs.readFileSync(path.join(dir, 'docs', 'guide.md'), 'utf8'));
    assert.match(out.html, /<pre class="mermaid">flowchart TD/, 'the Mermaid fence did not become a diagram');
    assert.match(out.html, /<details><summary>diagram source<\/summary>/, 'the diagram lost its offline source');
    assert.match(out.html, /<table>/, 'the GFM table did not render');
    assert.ok(out.html.includes('href="index.html"'), 'a relative .md link was not rewritten to .html');
    assert.ok(out.html.includes('href="../README.html"'), 'a relative link crossing a directory was not rewritten');
    assert.equal(out.title, 'Guide');
  });

  test('ops-infra setup keeps its fenced block and escapes what is inside it', () => {
    const dir = tmp('ops-infra-setup');
    materialize('ops-infra', dir, { git: false });
    const out = renderMarkdown(fs.readFileSync(path.join(dir, 'docs', 'setup.md'), 'utf8'));
    assert.match(out.html, /<pre><code class="language-text">/, 'the text fence lost its language class');
    assert.equal(out.title, 'Setup');
  });

  test('greenfield-app docs render with a title and no markup from the source', () => {
    const dir = tmp('greenfield-docs');
    materialize('greenfield-app', dir, { git: false });
    const out = renderMarkdown(fs.readFileSync(path.join(dir, 'docs', 'README.md'), 'utf8'));
    assert.equal(out.title, 'Fixture app docs');
    assert.ok(!/<(?!\/?(h1|h2|h3|p|a|code|em|strong|ul|ol|li|pre|table|thead|tbody|tr|th|td|hr|br|img|div|details|summary|section|blockquote|input)\b)/.test(out.html),
      'the render emitted a tag outside the set this renderer produces');
  });
});

// --- the goldens: this pack's own documents -----------------------------------------------------------

const SPINE = ['CONTINUITY.md', 'GAPS.md'];

describe('goldens: the pack\'s own spine/derived templates', () => {
  for (const name of SPINE) {
    test(`spine/derived/${name} renders to its committed golden`, () => {
      const src = fs.readFileSync(path.join(ROOT, 'spine', 'derived', name), 'utf8');
      golden(`spine-${name.replace(/\.md$/, '')}.html`, renderMarkdown(src).html);
    });
  }

  test('the templates\' angle-bracket placeholders reach the page as text', () => {
    const src = fs.readFileSync(path.join(ROOT, 'spine', 'derived', 'GAPS.md'), 'utf8');
    const html = renderMarkdown(src).html;
    assert.ok(html.includes('&lt;N&gt;'), 'the open-count placeholder was not escaped');
    assert.ok(html.includes('&lt;id&gt;'), 'the row id placeholder was not escaped');
    assert.ok(!/<N>|<id>/.test(html), 'a placeholder reached the page as a tag');
  });
});

// --- the goldens: a real generated document, markers and all -------------------------------------------

/*
 * ⛔ THE GENERATED-BLOCK CASE USES A REAL GENERATED BLOCK. `spine/derived/CONTINUITY.md` and `GAPS.md`
 * above are the seeded TEMPLATES a target starts from; they carry no `RESPAWNPACK:GENERATED` markers,
 * because the markers appear only once the state compiler has rendered the document. So the two inputs
 * below are produced by `kernel/lib/render.js` itself from a frozen state, committed as `.md` so a
 * reviewer can read the input beside its golden, and fenced against a fresh render so the committed copy
 * can never drift from what render.js actually emits.
 */
const FROZEN_STATE = Object.freeze({
  generatedAt: '2026-09-03T00:00:00.000Z',
  sourceRevision: '0'.repeat(40),
  goal: 'A browsable record of the project',
  goalComplete: false,
  milestone: 'Phase 3',
  milestoneComplete: false,
  projectBlocked: false,
  tracksRequirements: true,
  constraints: ['No network access while a run is unattended'],
  killedFeatures: [{ id: 'R-900', feature: 'a fixture-only entry that names nothing real' }],
  counts: {
    mandatory: 4, conformant: 2, candidate: 1, unevidenced: 1, waived: 0, blocked: 0,
    total: 6, staleEvidence: 0,
  },
  openP0P1: [{ id: 'REQ-3' }],
  nextUnblockedWork: [{ id: 'REQ-3', title: 'Render the record for a reader', status: 'unevidenced' }],
  blockers: [{ id: 'REQ-5', blockedBy: ['REQ-3'], missingAuthority: 'an owner decision' }],
  cannotDetermine: ['whether the diagram script is reachable offline'],
  requirements: [
    { id: 'REQ-1', status: 'conformant', risk: 'low', gate: 'suite', why: 'covered by a suite | and a golden' },
    { id: 'REQ-3', status: 'unevidenced', risk: 'high', gate: null, why: 'no evidence recorded yet' },
  ],
  gates: [{ id: 'suite', conformant: 2, denominator: 4, status: 'partial', note: 'two still open' }],
  evidence: { rejected: [{ file: 'docs/derived/evidence/example.json', reason: 'bound to a superseded revision' }] },
});

const EXISTING_WITH_NOTE = [
  render.NOTE_OPEN,
  'A human note that survives regeneration, with a [relative link](../GAPS.md) in it.',
  render.NOTE_CLOSE,
  '',
].join('\n');

const GENERATED = [
  { name: 'derived-continuity.md', build: () => render.renderContinuity(FROZEN_STATE, EXISTING_WITH_NOTE) },
  { name: 'derived-gaps.md', build: () => render.renderGaps(FROZEN_STATE, EXISTING_WITH_NOTE) },
];

describe('goldens: a document carrying real generated and note blocks', () => {
  for (const { name, build } of GENERATED) {
    test(`${name} is byte-identical to a fresh render.js render`, () => {
      const fresh = build();
      if (UPDATE) {
        fs.writeFileSync(path.join(FIXTURES, name), fresh);
        process.stderr.write(`RESPAWNPACK_SITE_GOLDENS=update: wrote kernel/site-fixtures/${name}\n`);
        return;
      }
      const committed = readFixture(name);
      if (committed === fresh) return;
      assert.fail(`kernel/site-fixtures/${name} is no longer what kernel/lib/render.js produces from the `
        + 'frozen state in this suite. render.js changed its output: read the diff, confirm the change was '
        + `intended, then re-run with RESPAWNPACK_SITE_GOLDENS=update.\n${unifiedDiff(committed, fresh, name)}`);
    });
  }

  test('the generated block becomes a labelled section, and its marker comments are gone', () => {
    const html = renderMarkdown(readFixture('derived-continuity.md')).html;
    assert.ok(html.includes('<section class="generated" data-marker="RESPAWNPACK:GENERATED">'),
      'the generated block did not become a labelled section');
    assert.ok(html.includes('<section class="note" data-marker="RESPAWNPACK:NOTE">'),
      'the note block did not become a labelled section');
    assert.ok(!html.includes('RESPAWNPACK:GENERATED --&gt;'), 'the marker comment itself reached the page');
    assert.ok(!html.includes('&lt;!--'), 'a marker comment was escaped onto the page instead of consumed');
  });

  test('the generated table keeps a cell whose pipe render.js escaped', () => {
    const html = renderMarkdown(readFixture('derived-gaps.md')).html;
    assert.ok(html.includes('covered by a suite | and a golden'),
      'the escaped pipe in a generated table cell did not survive as a literal pipe inside its cell');
  });

  test('the marker strings this renderer recognises are render.js\'s own constants', () => {
    // Anti-drift item 7: the contract is render.js's spelling, so the fixture is checked against the
    // constant rather than against a second copy of the text living in this suite.
    const md = readFixture('markers.md');
    for (const marker of [render.GEN_OPEN, render.GEN_CLOSE, render.NOTE_OPEN, render.NOTE_CLOSE]) {
      assert.ok(md.includes(marker),
        `kernel/site-fixtures/markers.md no longer contains ${JSON.stringify(marker)} as kernel/lib/render.js `
        + 'spells it, so the marker fixture is testing a marker the pack does not emit');
    }
    const src = fs.readFileSync(SITE, 'utf8');
    assert.ok(/require\('\.\/render\.js'\)/.test(src),
      'kernel/lib/site.js no longer imports its markers from kernel/lib/render.js - anti-drift item 7 '
      + 'requires the constants, never a retyped copy');
    assert.ok(!src.includes('RESPAWNPACK:GENERATED --'),
      'kernel/lib/site.js appears to spell a marker out rather than importing it');
  });

  test('a marker inside a fenced block stays literal text', () => {
    const html = renderMarkdown(readFixture('markers.md')).html;
    assert.ok(html.includes('<pre><code class="language-markdown">&lt;!-- RESPAWNPACK:GENERATED'),
      'a marker quoted inside a code fence was consumed as a real marker');
  });
});

// --- the constructs, each with its escape or negative case ---------------------------------------------

const html = (md, opts) => renderMarkdown(md, opts).html;

describe('headings', () => {
  test('six levels, each with a slug anchor', () => {
    const out = renderMarkdown('# One\n\n## Two\n\n### Three\n\n#### Four\n\n##### Five\n\n###### Six\n');
    for (let level = 1; level <= 6; level += 1) assert.match(out.html, new RegExp(`<h${level} id="[a-z]+">`));
    assert.deepEqual(out.headings.map((h) => h.level), [1, 2, 3, 4, 5, 6]);
  });

  test('a repeated heading gets a distinct anchor, in document order', () => {
    const out = renderMarkdown('## Notes\n\n## Notes\n\n## Notes\n');
    assert.deepEqual(out.headings.map((h) => h.id), ['notes', 'notes-1', 'notes-2']);
  });

  test('a heading with inline code keeps the code and slugs the plain text', () => {
    const out = renderMarkdown('## The `render` module\n');
    assert.equal(out.html, '<h2 id="the-render-module">The <code>render</code> module</h2>\n');
    assert.equal(out.headings[0].text, 'The render module');
  });

  test('a seventh hash is not a heading, and neither is a hash with no space', () => {
    assert.match(html('####### Seven\n'), /^<p>/);
    assert.match(html('#NoSpace\n'), /^<p>#NoSpace<\/p>/);
  });
});

describe('paragraphs and hard breaks', () => {
  test('two trailing spaces are a hard break', () => {
    // Proved from a string rather than a fixture: a committed file may not carry trailing whitespace,
    // which `git diff --check` rejects, so this construct cannot be a golden.
    assert.equal(html('one  \ntwo\n'), '<p>one<br />\ntwo</p>\n');
  });

  test('a trailing backslash is a hard break, and the backslash does not survive', () => {
    assert.equal(html('one\\\ntwo\n'), '<p>one<br />\ntwo</p>\n');
  });

  test('a single trailing space is not a hard break', () => {
    assert.equal(html('one \ntwo\n'), '<p>one\ntwo</p>\n');
  });
});

describe('emphasis', () => {
  test('all four delimiters', () => {
    assert.equal(html('*a* _b_ **c** __d__\n'),
      '<p><em>a</em> <em>b</em> <strong>c</strong> <strong>d</strong></p>\n');
  });

  test('strong nested inside emphasis', () => {
    assert.equal(html('*a **b** c*\n'), '<p><em>a <strong>b</strong> c</em></p>\n');
  });

  test('an underscore inside a word is not emphasis', () => {
    assert.equal(html('snake_case_name\n'), '<p>snake_case_name</p>\n');
  });

  test('a delimiter that never closes is text', () => {
    assert.equal(html('a *b c\n'), '<p>a *b c</p>\n');
  });
});

describe('inline code', () => {
  test('a span escapes its contents', () => {
    assert.equal(html('`<b> & "x"`\n'), '<p><code>&lt;b&gt; &amp; &quot;x&quot;</code></p>\n');
  });

  test('a double run holds a single backtick', () => {
    assert.equal(html('``a ` b``\n'), '<p><code>a ` b</code></p>\n');
  });

  test('an unclosed run is text', () => {
    assert.equal(html('a `b c\n'), '<p>a `b c</p>\n');
  });
});

describe('links, images and autolinks', () => {
  test('a relative .md link is rewritten and an absolute URL is not', () => {
    assert.equal(html('[a](b.md) [c](https://x.test/y.md)\n'),
      '<p><a href="b.html">a</a> <a href="https://x.test/y.md">c</a></p>\n');
  });

  test('linkRewrite: false leaves a .md link exactly as written', () => {
    assert.equal(html('[a](b.md#frag)\n', { linkRewrite: false }),
      '<p><a href="b.md#frag">a</a></p>\n');
  });

  test('the query and fragment survive the rewrite', () => {
    assert.equal(html('[a](docs/b.md?raw=1#top)\n'), '<p><a href="docs/b.html?raw=1#top">a</a></p>\n');
  });

  test('a destination with balanced parentheses stays whole', () => {
    assert.equal(html('[w](https://en.wikipedia.org/wiki/Foo_(bar))\n'),
      '<p><a href="https://en.wikipedia.org/wiki/Foo_(bar)">w</a></p>\n');
  });

  test('a title becomes a title attribute, escaped', () => {
    assert.equal(html('[a](b.md "a \\" quote")\n'),
      '<p><a href="b.html" title="a &quot; quote">a</a></p>\n');
  });

  test('an image carries src, alt and title', () => {
    assert.equal(html('![alt text](i.png "T")\n'),
      '<p><img src="i.png" alt="alt text" title="T" /></p>\n');
  });

  test('an autolink and an email autolink', () => {
    assert.equal(html('<https://x.test/a> <a@b.test>\n'),
      '<p><a href="https://x.test/a">https://x.test/a</a> <a href="mailto:a@b.test">a@b.test</a></p>\n');
  });

  test('a link whose scheme is not allowed is text, not a link', () => {
    // The negative case the site's safety rests on: nothing executable, and nothing dropped either.
    assert.equal(html('[click](javascript:alert(1))\n'), '<p>[click](javascript:alert(1))</p>\n');
    assert.equal(html('[x](data:text/html,<script>1</script>)\n'),
      '<p>[x](data:text/html,&lt;script&gt;1&lt;/script&gt;)</p>\n');
    assert.equal(html('[y](vbscript:msgbox)\n'), '<p>[y](vbscript:msgbox)</p>\n');
  });

  test('a reference link is not modelled, so it stays text', () => {
    assert.equal(html('[a][b]\n'), '<p>[a][b]</p>\n');
  });
});

describe('raw HTML is escaped, never passed through', () => {
  test('a script tag in a paragraph becomes text', () => {
    assert.equal(html('before <script>alert(1)</script> after\n'),
      '<p>before &lt;script&gt;alert(1)&lt;/script&gt; after</p>\n');
  });

  test('an HTML block becomes a paragraph of text', () => {
    const out = html('<div onclick="x()">\n  <img src=x onerror=alert(1)>\n</div>\n');
    assert.ok(!/<div/.test(out) && !/<img/.test(out), 'raw HTML reached the page as markup');
    assert.ok(out.includes('&lt;div onclick=&quot;x()&quot;&gt;'), 'the HTML block was dropped rather than escaped');
  });

  test('an entity is escaped rather than decoded', () => {
    assert.equal(html('&amp; &lt;script&gt;\n'), '<p>&amp;amp; &amp;lt;script&amp;gt;</p>\n');
  });
});

describe('lists', () => {
  test('unordered and ordered', () => {
    assert.equal(html('- a\n- b\n'), '<ul>\n<li>a</li>\n<li>b</li>\n</ul>\n');
    assert.equal(html('1. a\n2. b\n'), '<ol>\n<li>a</li>\n<li>b</li>\n</ol>\n');
  });

  test('an ordered list that does not start at one carries a start attribute', () => {
    assert.match(html('4. a\n5. b\n'), /^<ol start="4">/);
  });

  test('four levels of nesting by indentation', () => {
    const out = html('- l1\n  - l2\n    - l3\n      - l4\n');
    assert.equal((out.match(/<ul>/g) || []).length, 4, 'the nesting did not reach four levels');
    assert.ok(out.includes('<li>l4</li>'), 'the deepest item was lost');
  });

  test('task-list items, checked and unchecked', () => {
    assert.equal(html('- [ ] open\n- [x] done\n'),
      '<ul>\n<li class="task-list-item"><input type="checkbox" disabled /> open</li>\n'
      + '<li class="task-list-item"><input type="checkbox" disabled checked /> done</li>\n</ul>\n');
  });

  test('a bracket pair that is not a task marker stays text', () => {
    assert.equal(html('- [y] not a task\n'), '<ul>\n<li>[y] not a task</li>\n</ul>\n');
  });

  test('a blank line between items keeps one list', () => {
    assert.equal((html('- a\n\n- b\n').match(/<ul>/g) || []).length, 1);
  });

  test('a change of bullet character starts a second list', () => {
    assert.equal((html('- a\n\n* b\n').match(/<ul>/g) || []).length, 2);
  });
});

describe('blockquotes and thematic breaks', () => {
  test('a blockquote holds blocks of its own', () => {
    assert.equal(html('> a\n>\n> - b\n'),
      '<blockquote>\n<p>a</p>\n<ul>\n<li>b</li>\n</ul>\n</blockquote>\n');
  });

  test('all three thematic-break spellings', () => {
    assert.equal(html('---\n\n***\n\n___\n'), '<hr />\n<hr />\n<hr />\n');
  });

  test('a two-character rule is not a break', () => {
    assert.equal(html('--\n'), '<p>--</p>\n');
  });
});

describe('fenced and indented code', () => {
  test('the info string\'s first word becomes the language class', () => {
    assert.equal(html('```js title="x"\nlet a = 1;\n```\n'),
      '<pre><code class="language-js">let a = 1;\n</code></pre>\n');
  });

  test('a fence with no info string carries no class', () => {
    assert.equal(html('```\nplain\n```\n'), '<pre><code>plain\n</code></pre>\n');
  });

  test('three backticks inside a four-backtick fence are content', () => {
    const out = html('````\n```\ninner\n```\n````\n');
    assert.equal(out, '<pre><code>```\ninner\n```\n</code></pre>\n');
  });

  test('a tilde fence may hold backticks', () => {
    assert.equal(html('~~~\n``` not a fence\n~~~\n'), '<pre><code>``` not a fence\n</code></pre>\n');
  });

  test('code contents are escaped and never highlighted', () => {
    assert.equal(html('```html\n<script>x</script>\n```\n'),
      '<pre><code class="language-html">&lt;script&gt;x&lt;/script&gt;\n</code></pre>\n');
  });

  test('an indented block is code', () => {
    assert.equal(html('para\n\n    <b>code</b>\n'),
      '<p>para</p>\n<pre><code>&lt;b&gt;code&lt;/b&gt;\n</code></pre>\n');
  });
});

describe('tables', () => {
  test('alignment reaches the cells', () => {
    const out = html('| l | c | r |\n| :-- | :-: | --: |\n| 1 | 2 | 3 |\n');
    assert.ok(out.includes('<th style="text-align:left">l</th>'));
    assert.ok(out.includes('<th style="text-align:center">c</th>'));
    assert.ok(out.includes('<th style="text-align:right">r</th>'));
    assert.ok(out.includes('<td style="text-align:right">3</td>'));
  });

  test('an escaped pipe stays inside its cell', () => {
    const out = html('| a | b |\n| --- | --- |\n| x \\| y | z |\n');
    assert.ok(out.includes('<td>x | y</td>'), 'the escaped pipe split the row');
    assert.equal((out.match(/<td>/g) || []).length, 2, 'the row did not keep exactly two cells');
  });

  test('a header row with no delimiter row is a paragraph', () => {
    assert.match(html('| a | b |\nplain text\n'), /^<p>/);
  });

  test('a ragged row is padded and truncated to the header', () => {
    const out = html('| a | b |\n| --- | --- |\n| 1 |\n| 1 | 2 | 3 |\n');
    assert.ok(out.includes('<tr><td>1</td><td></td></tr>'), 'the short row was not padded');
    assert.ok(out.includes('<tr><td>1</td><td>2</td></tr>'), 'the long row was not truncated');
  });
});

describe('comments and the constructs the subset does not model', () => {
  test('an HTML comment is dropped', () => {
    assert.equal(html('a\n\n<!-- gone -->\n\nb\n'), '<p>a</p>\n<p>b</p>\n');
  });

  test('a multi-line comment is dropped whole', () => {
    assert.equal(html('a\n\n<!--\nstill\ngone\n-->\n\nb\n'), '<p>a</p>\n<p>b</p>\n');
  });

  test('an unterminated comment is escaped text, not a silent deletion', () => {
    const out = html('<!-- never closed\nsecond line\n');
    assert.ok(out.includes('&lt;!-- never closed'), 'the unterminated comment was dropped');
    assert.ok(out.includes('second line'), 'text after an unterminated comment was dropped');
  });

  test('an unmodelled construct is escaped text, never dropped', () => {
    for (const source of [':::note\nx\n:::', '{% raw %}x{% endraw %}', '[[wiki]]', '$$\nx\n$$']) {
      const out = html(`${source}\n`);
      assert.ok(out.replace(/<\/?p>/g, '').trim().length > 0, `${source} rendered as nothing`);
      assert.ok(!/<(?!\/?p>)/.test(out), `${source} produced markup`);
    }
  });
});

// --- the title and the outline -------------------------------------------------------------------------

describe('title and headings outline', () => {
  test('the title is the first H1\'s plain text', () => {
    const out = renderMarkdown('# The *first* `heading`\n\n# A second H1\n');
    assert.equal(out.title, 'The first heading');
  });

  test('a document with no H1 has a null title', () => {
    assert.equal(renderMarkdown('## Only a second level\n').title, null);
  });

  test('the outline lists every heading in order, with ids matching the anchors', () => {
    const out = renderMarkdown('# A\n\n## B\n\n### C\n\n## B\n');
    assert.deepEqual(out.headings, [
      { level: 1, id: 'a', text: 'A' },
      { level: 2, id: 'b', text: 'B' },
      { level: 3, id: 'c', text: 'C' },
      { level: 2, id: 'b-1', text: 'B' },
    ]);
    for (const h of out.headings) assert.ok(out.html.includes(`id="${h.id}"`), `${h.id} is not an anchor`);
  });

  test('headings inside a generated section are part of the outline', () => {
    const out = renderMarkdown(readFixture('derived-continuity.md'));
    assert.ok(out.headings.length > 1, 'the generated block contributed no headings to the outline');
    assert.ok(out.headings.some((h) => h.level === 2), 'no second-level heading came out of the generated block');
  });

  test('an empty document renders to nothing, with no title and no headings', () => {
    assert.deepEqual(renderMarkdown(''), { html: '', title: null, headings: [] });
    assert.deepEqual(renderMarkdown(null), { html: '', title: null, headings: [] });
  });
});

// --- determinism ----------------------------------------------------------------------------------------

describe('determinism', () => {
  const documents = listFixtures('.md');

  test('two renders in one process are byte-identical', () => {
    for (const doc of documents) {
      const src = readFixture(doc);
      assert.equal(renderMarkdown(src).html, renderMarkdown(src).html, `${doc} rendered differently twice`);
    }
  });

  test('two renders in two processes are byte-identical', () => {
    const dir = tmp('two-processes');
    const child = path.join(dir, 'child.js');
    fs.writeFileSync(child, [
      'const fs = require("fs");',
      'const path = require("path");',
      `const { renderMarkdown } = require(${JSON.stringify(SITE)});`,
      `const dir = ${JSON.stringify(FIXTURES)};`,
      'const crypto = require("crypto");',
      'const h = crypto.createHash("sha256");',
      'for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".md")).sort()) {',
      '  h.update(f).update(renderMarkdown(fs.readFileSync(path.join(dir, f), "utf8")).html);',
      '}',
      'process.stdout.write(h.digest("hex"));',
    ].join('\n'));

    const here = crypto.createHash('sha256');
    for (const doc of documents) here.update(doc).update(renderMarkdown(readFixture(doc)).html);

    const there = execFileSync(process.execPath, [child], { encoding: 'utf8' }).trim();
    assert.equal(there, here.digest('hex'),
      'the renderer produced different bytes in a second process - something in it reads the clock, the '
      + 'environment, a random source or the filesystem, and O-4b\'s byte-identical rebuild cannot hold');
  });

  test('the renderer adds no absolute path and no timestamp of its own', () => {
    /*
     * Stated as "adds none", not "contains none": a generated document legitimately carries the
     * `_Generated <iso>._` line render.js wrote into it, and refusing to render that would be the
     * renderer editing its input. What must never happen is a path or a clock reading appearing in the
     * OUTPUT that was not in the SOURCE, which is the only way this function could be non-deterministic.
     */
    const patterns = [
      ['a Windows path', /[A-Za-z]:[\\/]{1,2}[A-Za-z0-9_.-]+[\\/][A-Za-z0-9_.-]+/g],
      ['an absolute POSIX path', /(?:^|\s)\/(?:home|tmp|var|Users|mnt)\/[A-Za-z0-9_./-]+/g],
      ['a timestamp', /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}[\d:.]*Z?/g],
    ];
    for (const doc of listFixtures('.md')) {
      const source = readFixture(doc);
      const out = renderMarkdown(source).html
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
      for (const [label, pattern] of patterns) {
        for (const hit of out.match(pattern) || []) {
          assert.ok(source.includes(hit.trim()),
            `${doc}: ${label} (${hit.trim()}) is in the render but not in the source, so the renderer put it there`);
        }
      }
      assert.ok(!out.includes(os.tmpdir()), `${doc}: the temp directory reached the page`);
    }
  });
});

// --- a large real document ---------------------------------------------------------------------------------

/*
 * The pack's own README is the largest tracked document a reader of the built site would open first, and
 * it is the one document in this suite nobody wrote for a test. The accounting below is the point: it is
 * cheap for a renderer to produce plausible HTML that quietly loses a code block, and this counts them.
 */
function fencedBlocks(source) {
  const lines = source.split('\n');
  const blocks = [];
  for (let i = 0; i < lines.length; i += 1) {
    const open = /^ {0,3}(`{3,}|~{3,})[ \t]*(.*)$/.exec(lines[i]);
    if (!open) continue;
    const bar = open[1];
    const info = (open[2].trim().split(/\s+/)[0] || '');
    const closer = new RegExp(`^ {0,3}\\${bar[0]}{${bar.length},}[ \\t]*$`);
    let end = i + 1;
    while (end < lines.length && !closer.test(lines[end])) end += 1;
    blocks.push({ info, content: lines.slice(i + 1, end).join('\n') });
    i = end;
  }
  return blocks;
}

describe('a large real document', () => {
  const source = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');

  test('the pack\'s own README renders without throwing', () => {
    const out = renderMarkdown(source);
    assert.ok(out.html.length > source.length / 2, 'the render is implausibly short');
    assert.equal(out.title, 'RespawnPack');
    assert.ok(out.headings.length > 5, 'the outline is implausibly short');
  });

  test('every fenced block in the README is accounted for in the output', () => {
    const out = renderMarkdown(source).html;
    const blocks = fencedBlocks(source);
    assert.ok(blocks.length > 0, 'no fenced block was found in README.md - re-aim this test, do not delete it');

    for (const block of blocks) {
      assert.ok(out.includes(escapeLike(block.content)),
        `a fenced block from README.md is missing from the render: ${JSON.stringify(block.content.slice(0, 60))}`);
    }

    const mermaid = blocks.filter((b) => b.info === 'mermaid');
    assert.equal((out.match(/<pre class="mermaid">/g) || []).length, mermaid.length,
      'the number of Mermaid blocks in the output does not match the number of Mermaid fences in the source');

    // A Mermaid fence emits two <pre> (the diagram and its offline source); every other fence emits one.
    // Indented code blocks emit one more each, and README.md carries none today - a fact recorded here
    // rather than re-derived, because counting them would mean re-implementing the renderer inside its
    // own test. If README.md gains an indented block, this expectation moves with it, deliberately.
    const expected = (blocks.length - mermaid.length) + (mermaid.length * 2);
    assert.equal((out.match(/<pre[ >]/g) || []).length, expected,
      'the <pre> blocks in the output do not account for exactly the fenced blocks in the source '
      + '(plus one extra per Mermaid fence, and one per indented code block, of which README.md has none)');
  });
});

/* ======================================================================================================
 * THE SITE (task O-4b) — what `buildSite` writes, what it refuses, and what `serve` will answer.
 *
 * ⛔ THE ARCHETYPES ARE STILL THE POINT. The class is "output shaped for a human": ANY repository's
 * tracked documents, browsable locally. So the build is proved on three of `ops/_project-fixtures.mjs`'s
 * archetypes rather than on one invented tree — `docs-only` (four documents that link to each other and
 * carry a diagram), `ops-infra` (one document, no cross-reference at all) and `greenfield-app` (the pack
 * actually installed on top, with a compiled state in three conditions).
 *
 * ⛔ AND THE DASHBOARD IS PROVED IN ALL THREE OF ITS STATES, ON A REAL COMPILED STATE. Not a hand-written
 * STATE.json: `install/install.js` lays the pack into the fixture, the TARGET'S OWN kernel runs
 * `savepoint --write`, and the three conditions are produced the way a project produces them — a fresh
 * compile (CURRENT), an edited compiler input (STALE) and a deleted projection (ABSENT). A dashboard
 * fixtured against a hand-written file would prove the renderer and not the rule.
 * ==================================================================================================== */

const KERNEL_JS = path.join(ROOT, 'kernel', 'respawnpack.js');
const INSTALL_JS = path.join(ROOT, 'install', 'install.js');
const sources = require_(path.join(ROOT, 'install', '_sources.js'));
const modhealth = require_(path.join(KERNEL, 'lib', 'modhealth.js'));
const { buildSite, serve, MERMAID_CDN, LOOPBACK } = require_(SITE);

/** Which of a materialised tree's files the site is a projection of, derived from the same rule. */
const siteInputs = (files) => files.filter((f) => f === 'README.md'
  || (f.endsWith('.md') && (f.startsWith('docs/') || f.startsWith('memory/graph/')))).sort();

/** Every file under `root`, by name and content, as one digest. `.git` is never part of the claim. */
function digestTree(root, skip = []) {
  const h = crypto.createHash('sha256');
  const walk = (abs, rel) => {
    let entries;
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.name === '.git' || skip.includes(r)) continue;
      const child = path.join(abs, e.name);
      if (e.isDirectory()) { h.update(`D ${r}\n`); walk(child, r); }
      else if (e.isFile()) { h.update(`F ${r}\n`); h.update(fs.readFileSync(child)); }
      else h.update(`? ${r}\n`);
    }
  };
  walk(root, '');
  return h.digest('hex');
}

/** Every `.html` under a built site, relative and POSIX, so a page set can be compared as a set. */
function pagesOn(out) {
  const found = [];
  const walk = (abs, rel) => {
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(abs, e.name), r);
      else if (e.isFile() && e.name.endsWith('.html')) found.push(r);
    }
  };
  walk(out, '');
  return found.sort();
}

const readPage = (out, rel) => fs.readFileSync(path.join(out, ...rel.split('/')), 'utf8');

/** Every relative href a page carries, as written. */
const hrefsOf = (html) => [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);

// --- what it builds, on three archetypes ---------------------------------------------------------------

describe('the site: any repository\'s documents, on every archetype', () => {
  for (const kind of ['docs-only', 'ops-infra', 'greenfield-app']) {
    const dir = tmp(`build-${kind}`);
    const { files } = materialize(kind, dir);
    const expected = siteInputs(files);
    const out = path.join(dir, '.respawnpack', 'site');
    const before = digestTree(dir, ['.respawnpack']);
    const built = buildSite(dir);

    test(`${kind}: every input document has a page, and the page set is exactly those plus index and state`, () => {
      assert.ok(expected.length > 0, `${kind} materialises no document the site would carry — re-aim this test`);
      assert.deepEqual(built.pages.map((p) => p.source).sort(), expected,
        `${kind}: the build read a different document set than the input rule names`);
      assert.deepEqual(pagesOn(out),
        [...expected.map((f) => f.replace(/\.md$/, '.html')), 'index.html', 'state.html'].sort(),
        `${kind}: the pages on disk are not exactly one per document plus the two the site owns`);
    });

    test(`${kind}: index.html names every document, and the sidebar links to each of them`, () => {
      const index = readPage(out, 'index.html');
      for (const page of built.pages) {
        assert.ok(index.includes(`href="${page.page}"`), `${kind}: index.html does not link to ${page.page}`);
        assert.ok(index.includes(page.source), `${kind}: index.html does not name the source ${page.source}`);
      }
      assert.ok(index.includes('href="state.html"'), `${kind}: index.html does not link to the dashboard`);
    });

    test(`${kind}: every relative link between documents resolves to a page that exists`, () => {
      const onDisk = new Set(pagesOn(out));
      let checked = 0;
      for (const page of built.pages) {
        const html = readPage(out, page.page);
        const dirOf = path.posix.dirname(page.page);
        for (const href of hrefsOf(html)) {
          const clean = href.split('#')[0].split('?')[0];
          if (!clean || !clean.endsWith('.html') || /^[a-z][a-z0-9+.-]*:|^\/\//i.test(clean)) continue;
          const target = path.posix.normalize(path.posix.join(dirOf === '.' ? '' : dirOf, clean));
          // A link out of the covered document set is a fact about the SOURCE and is reported by the
          // build, not asserted here; what must hold is that a link INTO the set always lands.
          if (target.startsWith('..')) continue;
          const asSource = `${target.replace(/\.html$/, '')}.md`;
          if (!expected.includes(asSource) && !['index.html', 'state.html'].includes(target)) continue;
          checked += 1;
          assert.ok(onDisk.has(target), `${kind}: ${page.page} links to ${target}, which is not a page this build wrote`);
        }
      }
      assert.ok(checked > 0, `${kind}: no internal cross-reference was checked — every page links only outward, or the extraction is broken`);
    });

    test(`${kind}: a rebuild of an unchanged tree is byte-identical`, () => {
      const first = digestTree(out);
      const again = buildSite(dir);
      assert.equal(digestTree(out), first,
        `${kind}: two builds of the same tree produced different bytes — something in the build reads a clock, a random source or an absolute path`);
      assert.deepEqual(again.pages, built.pages, `${kind}: the second build reported a different page set`);
    });

    test(`${kind}: nothing outside the output directory changed`, () => {
      assert.equal(digestTree(dir, ['.respawnpack']), before,
        `${kind}: building the site modified the project. It is a PROJECTION: it reads tracked documents and writes only under its output directory`);
    });

    test(`${kind}: the rows are the shared contract, and the build says what it did`, () => {
      const byCheck = Object.fromEntries(built.checks.map((c) => [c.check, c]));
      assert.ok(byCheck['site:pages'], `${kind}: no site:pages row`);
      assert.equal(byCheck['site:pages'].outcome, 'PASS');
      assert.equal(byCheck['site:pages'].checked, expected.length);
      assert.equal(byCheck['site:output'].outcome, 'PASS');
      assert.equal(byCheck['site:output'].checked, expected.length + 2);
      for (const row of built.checks) {
        assert.equal(row.domain, 'integrity', `${kind}: ${row.check} answers a question this verb does not ask`);
        assert.ok(typeof row.detail === 'string' && row.detail.length > 10, `${kind}: ${row.check} has no usable detail`);
      }
    });
  }

  test('docs-only: an out outside the project leaves the project byte-identical', () => {
    const dir = tmp('external-out');
    materialize('docs-only', dir);
    const before = digestTree(dir);
    const out = tmp('external-out-target');
    const built = buildSite(dir, { out });
    assert.equal(built.outcome, 'CANNOT_DETERMINE', 'a fixture with no compiled state rolls up to CANNOT_DETERMINE, like `status` does');
    assert.ok(pagesOn(out).includes('index.html'), 'the external output directory has no index');
    assert.equal(digestTree(dir), before, 'building into an external directory still touched the project');
  });

  test('docs-only: a document deleted from the repository loses its page on the next build', () => {
    const dir = tmp('prune');
    materialize('docs-only', dir);
    const out = path.join(dir, '.respawnpack', 'site');
    buildSite(dir);
    assert.ok(pagesOn(out).includes('docs/security-note.html'), 'the page under test was never built');
    fs.rmSync(path.join(dir, 'docs', 'security-note.md'));
    const again = buildSite(dir);
    assert.ok(!pagesOn(out).includes('docs/security-note.html'),
      'a page survived the deletion of its document — the output would then carry a document the repository does not have');
    assert.deepEqual(again.pruned, ['docs/security-note.html'], 'the removal must be reported, not silent');
  });

  test('docs-only: the sidebar, breadcrumbs and outline are on every page', () => {
    const dir = tmp('chrome');
    materialize('docs-only', dir);
    const out = path.join(dir, '.respawnpack', 'site');
    buildSite(dir);
    const guide = readPage(out, 'docs/guide.html');
    assert.match(guide, /<nav class="side" aria-label="documents">/, 'no sidebar');
    assert.ok(guide.includes('href="../index.html"'), 'the sidebar of a nested page does not reach the index');
    assert.match(guide, /<p class="crumbs"><a href="\.\.\/index\.html">The record<\/a>/, 'no breadcrumbs');
    assert.match(guide, /<nav class="outline" aria-label="on this page">/, 'no per-page heading outline');
    for (const h of ['getting-started', 'reference-table', 'flow']) {
      assert.ok(guide.includes(`href="#${h}"`), `the outline does not link to #${h}`);
    }
    assert.ok(!/<link[^>]+stylesheet/i.test(guide), 'the page links an external stylesheet; the styles are inline on purpose');
    assert.match(guide, /<style>\n:root \{/, 'the inline stylesheet is missing');
    assert.ok(guide.includes('80ch'), 'the 80-character measure is not in the stylesheet');
    assert.ok(guide.includes('@media print'), 'the stylesheet carries no print rule');
    assert.deepEqual(pagesOn(out).filter((p) => p.endsWith('.css')), [], 'a stylesheet file was written');
  });
});

// --- the dashboard, in all three of its states ---------------------------------------------------------

describe('the site: the dashboard withholds what is not current', () => {
  /*
   * greenfield-app with the pack really installed. Built once and reused across the three states, because
   * an install plus a savepoint is the expensive part and the three conditions are produced from it in
   * order: compile → edit an input → delete the projection.
   */
  const dir = tmp('dashboard');
  const out = tmp('dashboard-out');
  materialize('greenfield-app', dir);
  const install = spawnSync(process.execPath, [INSTALL_JS, dir], { encoding: 'utf8' });
  const targetKernel = path.join(dir, '.claude', 'respawnpack', 'respawnpack.js');
  const requirementsRel = path.join('docs', 'derived', 'state', 'requirements.json');
  const requirements = (n) => JSON.stringify({
    schemaVersion: '1.0.0',
    denominatorVersion: `fixture-${n}`,
    requirements: [
      { id: 'REQ-1', title: 'The record is browsable', mandatory: true, risk: 'low' },
      { id: 'REQ-2', title: 'The dashboard withholds what is stale', mandatory: true, risk: 'high' },
      { id: 'REQ-3', title: 'The server binds loopback only', mandatory: true, risk: 'high', blockedBy: ['REQ-1'] },
    ],
  }, null, 2);

  test('the fixture really has the pack installed and a compiled state', () => {
    assert.equal(install.status, 0, `install.js failed: ${install.stdout}\n${install.stderr}`);
    assert.ok(fs.existsSync(targetKernel), 'the target did not receive a kernel');
    assert.ok(fs.existsSync(path.join(dir, '.claude', 'respawnpack', 'lib', 'site.js')),
      'the installed kernel has no lib/site.js — install/_sources.js does not place the module this verb needs');

    fs.writeFileSync(path.join(dir, requirementsRel), requirements(1));
    const sp = spawnSync(process.execPath, [targetKernel, 'savepoint', '--write', '--dir', dir, '--json'], { encoding: 'utf8' });
    assert.ok(sp.status !== null, `savepoint did not run: ${sp.stderr}`);
    assert.ok(fs.existsSync(path.join(dir, 'docs', 'derived', 'STATE.json')),
      `savepoint --write wrote no STATE.json (exit ${sp.status}): ${sp.stdout.slice(0, 400)}${sp.stderr.slice(0, 400)}`);
  });

  test('CURRENT: the dashboard renders the goal, the counts, the blockers and the next work', () => {
    const built = buildSite(dir, { out });
    const row = built.checks.find((c) => c.check === 'state:STATE.json');
    assert.equal(row.outcome, 'PASS', `the state row is ${row.outcome}: ${row.detail}`);
    assert.equal(built.state, 'CURRENT');

    const page = readPage(out, 'state.html');
    assert.match(page, /data-count="mandatory">3</, 'the mandatory count is not on the page');
    assert.match(page, /data-count="unevidenced">3</, 'the unevidenced count is not on the page');
    assert.ok(page.includes('REQ-3'), 'the blocked row is not named');
    assert.ok(!page.includes('WITHHELD'), 'a current dashboard withheld something');
    assert.ok(!page.includes('⚠️ state:'), 'a current dashboard shows the stale banner');
  });

  test('STALE: an edited compiler input withholds every number, and says why', () => {
    fs.writeFileSync(path.join(dir, requirementsRel), requirements(2));
    const built = buildSite(dir, { out });
    const row = built.checks.find((c) => c.check === 'state:STATE.json');
    assert.equal(row.outcome, 'CANNOT_DETERMINE', 'a stale projection is not a pass');
    assert.equal(row.label, 'STALE', `expected STALE, got ${row.label}: ${row.detail}`);

    const page = readPage(out, 'state.html');
    assert.match(page, /⚠️ state: STALE/, 'no banner');
    assert.ok(page.includes('requirements.json'), 'the banner does not name the input that changed');
    assert.ok(page.includes('rows: WITHHELD · blocked: WITHHELD · next: WITHHELD'), 'the withholding line is missing');
    assert.ok(!page.includes('data-count='),
      'a count survived on a STALE dashboard. Anti-drift item 5: counts are WITHHELD, never caveated — a number printed beside a warning is still a number the next reader quotes');
    assert.ok(!/<table><tbody><tr><th scope="row">mandatory/.test(page), 'the counts table survived');
  });

  test('ABSENT: no STATE.json at all is the banner too, and still no number', () => {
    fs.rmSync(path.join(dir, 'docs', 'derived', 'STATE.json'));
    const built = buildSite(dir, { out });
    const row = built.checks.find((c) => c.check === 'state:STATE.json');
    assert.equal(row.outcome, 'CANNOT_DETERMINE');
    assert.equal(row.label, 'ABSENT');

    const page = readPage(out, 'state.html');
    assert.match(page, /⚠️ state: ABSENT/, 'no banner');
    assert.ok(page.includes('WITHHELD'), 'the withholding line is missing');
    assert.ok(!page.includes('data-count='), 'a count appeared for a project with no compiled state at all');
  });

  test('the dashboard reads the state through the SHARED reader, never raw', () => {
    /*
     * The property, from source: `kernel/lib/site.js` resolves `hooks/_runtime.js` the way every other
     * cross-tree reader in the kernel does and calls `readDurableState`. A second reader here would be a
     * second definition of "current", and the day the two disagreed this page would be the one showing a
     * number the boot banner had already withheld.
     */
    const src = fs.readFileSync(SITE, 'utf8');
    assert.match(src, /'hooks',\s*'_runtime\.js'/, 'kernel/lib/site.js no longer reaches the shared runtime reader');
    assert.match(src, /runtimeLib\.readDurableState\(/, 'kernel/lib/site.js no longer calls readDurableState');
    assert.ok(!/STATE\.json['"]\s*\)/.test(src.replace(/\/\*[\s\S]*?\*\//g, '')),
      'kernel/lib/site.js appears to build a path to STATE.json of its own — the freshness rule has exactly one implementation');
    assert.deepEqual(modhealth.CROSS_TREE['site.js'], ['_runtime.js'],
      'kernel/lib/modhealth.js does not declare the site\'s cross-tree edge, so doctor would report the module ACTIVE with its reader broken');
  });

  test('the verb prints the same rows and takes the same exit code as every other verb', () => {
    const verbOut = tmp('verb-out');
    const r = spawnSync(process.execPath, [KERNEL_JS, 'site', '--dir', dir, '--out', verbOut, '--json'], { encoding: 'utf8' });
    assert.ok(r.status !== null, `the verb did not run: ${r.stderr}`);
    const json = JSON.parse(r.stdout);
    assert.equal(json.outcome, 'CANNOT_DETERMINE', 'the fixture has no STATE.json at this point, so the verb cannot report a pass');
    assert.equal(r.status, 2, 'CANNOT_DETERMINE is exit 2 for this verb like every other');
    assert.ok(!('serving' in json), 'a Promise reached --json');
    assert.ok(json.checks.some((c) => c.check === 'site:pages'), 'no site:pages row in --json');
    assert.ok(fs.existsSync(path.join(verbOut, 'index.html')), 'the verb wrote no index');
  });
});

// --- what it refuses ------------------------------------------------------------------------------------

describe('the site: the output directory it refuses, and the link it will not follow', () => {
  test('an --out inside docs/ is refused, and nothing is written', () => {
    const dir = tmp('refuse-docs');
    materialize('docs-only', dir);
    const before = digestTree(dir);
    const built = buildSite(dir, { out: path.join(dir, 'docs', 'site') });
    assert.equal(built.outcome, 'FAIL');
    assert.deepEqual(built.pages, []);
    const row = built.checks.find((c) => c.check === 'site:out');
    assert.match(row.detail, /inside docs\/, which this build\s+READS/, `the refusal does not say why: ${row.detail}`);
    assert.equal(digestTree(dir), before, 'a refused build still wrote something');
  });

  test('an --out inside memory/graph/ is refused for the same reason', () => {
    const dir = tmp('refuse-memory');
    materialize('docs-only', dir);
    const built = buildSite(dir, { out: path.join(dir, 'memory', 'graph', 'site') });
    assert.equal(built.outcome, 'FAIL');
    assert.match(built.checks[0].detail, /memory\/graph\//);
  });

  test('an --out that CONTAINS the project is refused', () => {
    const dir = tmp('refuse-parent');
    materialize('docs-only', dir);
    const built = buildSite(dir, { out: dir });
    assert.equal(built.outcome, 'FAIL');
    assert.match(built.checks[0].detail, /contains the project/);
  });

  test('an --out outside the project is allowed — that is what the flag is for', () => {
    const dir = tmp('allow-outside');
    materialize('docs-only', dir);
    const out = tmp('allow-outside-target');
    const built = buildSite(dir, { out });
    assert.notEqual(built.outcome, 'FAIL', JSON.stringify(built.checks));
    assert.ok(fs.existsSync(path.join(out, 'index.html')));
  });

  /*
   * ⛔ A DIRECTORY JUNCTION, NOT A FILE SYMLINK, BECAUSE OTHERWISE THIS TEST DOES NOT RUN AT ALL.
   * Windows refuses `symlink()` to an unelevated process without developer mode, so a suite that only
   * knew the POSIX spelling would report `skipped` on the platform this pack is developed on — and a
   * containment rule proved on nobody's machine is a containment rule nobody has proved. A junction
   * needs no privilege, is the same question (a directory entry resolving somewhere else), and the
   * POSIX spelling is tried first so a Linux runner exercises the file case too.
   */
  function linkDir(target, link) {
    for (const type of ['dir', 'junction']) {
      try { fs.symlinkSync(target, link, type); return type; } catch { /* try the next spelling */ }
    }
    return null;
  }

  test('a link pointing outside the project is not followed, and the skip is reported', (t) => {
    const dir = tmp('symlink');
    materialize('docs-only', dir);
    const outside = tmp('symlink-outside');
    fs.writeFileSync(path.join(outside, 'secret.md'), '# Not this project\n\nThis document lives outside the repository.\n');
    if (!linkDir(outside, path.join(dir, 'docs', 'borrowed'))) {
      return t.skip('this machine permits neither a directory symlink nor a junction');
    }

    const out = tmp('symlink-out');
    const built = buildSite(dir, { out });
    assert.ok(!built.pages.some((p) => p.source.startsWith('docs/borrowed')),
      'the build followed a link out of the project and published a document nobody put in this repository');
    assert.ok(!pagesOn(out).some((p) => p.startsWith('docs/borrowed')), 'a page was written for the link target');
    assert.deepEqual(built.skipped.map((s) => s.path), ['docs/borrowed'], 'the skip was silent');
    assert.match(built.skipped[0].why, /outside the project/);
    assert.ok(readPage(out, 'index.html').includes('docs/borrowed'),
      'the index does not tell a reader that a path was not followed — a quiet omission looks the same as a document that does not exist');
    return undefined;
  });

  test('a link pointing INSIDE the project is followed, so the rule is containment and not "no links"', (t) => {
    const dir = tmp('symlink-inside');
    materialize('docs-only', dir);
    fs.mkdirSync(path.join(dir, 'extra'));
    fs.writeFileSync(path.join(dir, 'extra', 'note.md'), '# A note\n\nInside the project, reached through a link.\n');
    if (!linkDir(path.join(dir, 'extra'), path.join(dir, 'docs', 'alias'))) {
      return t.skip('this machine permits neither a directory symlink nor a junction');
    }
    const out = tmp('symlink-inside-out');
    const built = buildSite(dir, { out });
    assert.ok(built.pages.some((p) => p.source === 'docs/alias/note.md'),
      'a link that resolves inside the project was skipped — the rule is "never out of the tree", not "never a link"');
    assert.deepEqual(built.skipped, []);
    return undefined;
  });

  test('a link pointing at its own ancestor terminates instead of walking forever', (t) => {
    // Containment is the security rule and says YES here, correctly. Termination is a different rule,
    // and without it this build would descend docs/loop/loop/loop/… until the process died.
    const dir = tmp('symlink-loop');
    materialize('docs-only', dir);
    if (!linkDir(path.join(dir, 'docs'), path.join(dir, 'docs', 'loop'))) {
      return t.skip('this machine permits neither a directory symlink nor a junction');
    }
    const out = tmp('symlink-loop-out');
    const built = buildSite(dir, { out });
    assert.equal(built.pages.filter((p) => p.source.startsWith('docs/loop')).length, 0,
      'the cycle was entered — a directory is walked at most once, by its resolved path');
    assert.ok(built.pages.some((p) => p.source === 'docs/guide.md'), 'the real documents were lost along with the cycle');
    return undefined;
  });

  test('node_modules and .git are never walked', () => {
    const dir = tmp('never-walk');
    materialize('docs-only', dir);
    fs.mkdirSync(path.join(dir, 'docs', 'node_modules', 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'docs', 'node_modules', 'pkg', 'README.md'), '# A dependency\n');
    const out = tmp('never-walk-out');
    const built = buildSite(dir, { out });
    assert.ok(!built.pages.some((p) => p.source.includes('node_modules')),
      'a dependency\'s README was published as though this project had written it');
  });
});

// --- the loopback server ---------------------------------------------------------------------------------

describe('the site: served on loopback, read-only, and nowhere else', () => {
  const dir = tmp('serve-fixture');
  materialize('docs-only', dir);
  const out = tmp('serve-out');
  buildSite(dir, { out });

  /** A request written onto a raw socket, so no client normalises the path before the server sees it. */
  function rawGet(port, target) {
    return new Promise((resolve, reject) => {
      const socket = net.connect(port, LOOPBACK, () => {
        socket.write(`GET ${target} HTTP/1.1\r\nHost: ${LOOPBACK}\r\nConnection: close\r\n\r\n`);
      });
      let buf = '';
      socket.setEncoding('utf8');
      socket.on('data', (d) => { buf += d; });
      socket.on('end', () => {
        const head = buf.slice(0, buf.indexOf('\r\n\r\n'));
        resolve({ status: Number((/^HTTP\/1\.1 (\d+)/.exec(head) || [])[1]), head, body: buf.slice(buf.indexOf('\r\n\r\n') + 4) });
      });
      socket.on('error', reject);
    });
  }

  test('it starts on an ephemeral port, prints its URL, and answers on 127.0.0.1', async () => {
    const printed = [];
    const before = process.listenerCount('SIGINT');
    const h = await serve({ out, log: (line) => printed.push(line) });
    try {
      assert.ok(h.port > 0, 'no ephemeral port was allocated');
      assert.equal(h.address, LOOPBACK, `the server bound ${h.address}`);
      assert.equal(h.url, `http://${LOOPBACK}:${h.port}/`);
      assert.ok(printed.some((l) => l.includes(h.url)), `the URL was never printed: ${JSON.stringify(printed)}`);
      assert.ok(printed.some((l) => /loopback only/.test(l)), 'the operator is not told what the server is reachable from');
      assert.equal(process.listenerCount('SIGINT'), before + 1, 'no SIGINT handler was installed, so Ctrl-C would not stop it');

      const index = await rawGet(h.port, '/index.html');
      assert.equal(index.status, 200);
      assert.match(index.head, /content-type: text\/html; charset=utf-8/i);
      assert.ok(index.body.includes('<title>The record</title>'), 'the index was not what came back');

      assert.equal((await rawGet(h.port, '/')).status, 200, 'the site root does not resolve to its index');
      const state = await rawGet(h.port, '/state.html');
      assert.equal(state.status, 200);
      assert.ok(state.body.includes('Project state'), 'the dashboard was not what came back');

      const nested = await rawGet(h.port, '/docs/guide.html');
      assert.equal(nested.status, 200, 'a nested page is not served');
      assert.ok(!/<link[^>]+stylesheet/i.test(nested.body), 'the served page asks for a stylesheet file');
      assert.match(nested.body, /<style>/, 'the served page carries no inline stylesheet');
    } finally {
      await h.close();
    }
    assert.equal(process.listenerCount('SIGINT'), before, 'close() left its SIGINT handler behind');
    assert.rejects(() => fetch(`http://${LOOPBACK}:${h.port}/index.html`), 'the server is still answering after close()');
  });

  test('it refuses path traversal, in every spelling, and answers nothing outside the site', async () => {
    const h = await serve({ out, log: () => {} });
    try {
      for (const target of ['/../../../etc/hosts', '/%2e%2e/%2e%2e/x.html', '/docs/../index.html', '/..%2f..%2fx.html']) {
        const r = await rawGet(h.port, target);
        assert.ok(r.status === 403 || r.status === 404, `${target} was answered with ${r.status}, not a refusal`);
        assert.ok(!r.body.includes('<html'), `${target} returned a page`);
      }
      assert.equal((await rawGet(h.port, '/nothing-here.html')).status, 404, 'a missing page is not a 404');
    } finally { await h.close(); }
  });

  test('it answers GET and HEAD and refuses every other method', async () => {
    const h = await serve({ out, log: () => {} });
    try {
      const head = await fetch(`${h.url}index.html`, { method: 'HEAD' });
      assert.equal(head.status, 200);
      assert.equal(head.headers.get('content-type'), 'text/html; charset=utf-8');
      for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
        assert.equal((await fetch(h.url, { method })).status, 405, `${method} was not refused — this server is read-only`);
      }
    } finally { await h.close(); }
  });

  test('it refuses any host but 127.0.0.1, before a socket exists', async () => {
    for (const host of ['0.0.0.0', '::', '::1', 'localhost', '10.0.0.5']) {
      await assert.rejects(() => serve({ out, host, log: () => {} }),
        (e) => e.message.includes(host) && /binds 127\.0\.0\.1/.test(e.message),
        `serve() accepted ${host} — the site would have been reachable from somewhere nobody chose`);
    }
  });

  test('it refuses a port that is not one, and a directory that holds no site', async () => {
    await assert.rejects(() => serve({ out, port: 'eighty', log: () => {} }), /not a port/);
    await assert.rejects(() => serve({ out, port: 70000, log: () => {} }), /not a port/);
    await assert.rejects(() => serve({ out: path.join(out, 'nowhere'), log: () => {} }), /no built site/);
  });

  test('the verb prints its rows and then does NOT exit, which is the one verb that does not', async () => {
    /*
     * ⛔ THE BRANCH THIS COVERS IS AN ABSENCE. Every other verb ends at `process.exit(exitCodeFor(...))`;
     * `site --serve` must print its verdict and then stay up until its operator stops it, so the thing
     * to prove is that the process is still there and still answering after the rows have been printed.
     * A unit test of `serve()` cannot see that: the omission lives in the dispatcher.
     */
    const child = spawn(process.execPath,
      [KERNEL_JS, 'site', '--dir', dir, '--out', tmp('cli-serve'), '--serve'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { buf += d; });
    child.stderr.on('data', (d) => { buf += d; });
    try {
      const url = await new Promise((resolve, reject) => {
        const bail = setTimeout(() => reject(new Error(`the verb printed no URL within 20s:\n${buf}`)), 20000);
        const poll = setInterval(() => {
          const m = /http:\/\/127\.0\.0\.1:\d+\//.exec(buf);
          if (m) { clearInterval(poll); clearTimeout(bail); resolve(m[0]); }
        }, 50);
      });
      assert.match(buf, /site:pages: \d+ document\(s\) rendered/, 'the rows were not printed before the URL');
      assert.match(buf, /→ (PASS|CANNOT_DETERMINE)/, 'the verdict was not printed');
      const r = await fetch(new URL('index.html', url));
      assert.equal(r.status, 200, 'the served site did not answer, so the verb exited when it should have stayed up');
      assert.equal(r.headers.get('content-type'), 'text/html; charset=utf-8');
      assert.equal(child.exitCode, null, 'the verb exited while its server was meant to be running');
    } finally {
      child.kill();
    }
  });

  test('it executes nothing: the server path holds no process spawn at all', () => {
    const src = fs.readFileSync(SITE, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const needle of ['child_process', 'execFile', 'spawn(', 'execSync', 'eval(']) {
      assert.ok(!src.includes(needle), `kernel/lib/site.js reaches for ${needle} — a document viewer runs nothing`);
    }
  });
});

// --- the pinned diagram script ---------------------------------------------------------------------------

describe('the site: one pinned diagram script, on the pages that carry a diagram', () => {
  const dir = tmp('mermaid');
  materialize('docs-only', dir);
  const out = tmp('mermaid-out');
  const built = buildSite(dir, { out });

  test('the URL is one pinned string in the module, and the pack never fetches it', () => {
    const src = fs.readFileSync(SITE, 'utf8');
    const hits = src.match(new RegExp(MERMAID_CDN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || [];
    assert.equal(hits.length, 1, `the CDN URL is written ${hits.length} times in kernel/lib/site.js; it is one constant`);
    assert.match(MERMAID_CDN, /^https:\/\/[^\s]+@\d+\.\d+\.\d+\//,
      'the diagram script is not pinned to an exact version — two builds of the same tree would render differently on two days');
    for (const needle of ['fetch(', 'https.get', 'http.get', 'require(\'https\')']) {
      assert.ok(!src.includes(needle), `kernel/lib/site.js appears to ${needle} — owner decision 20: this run downloads nothing`);
    }
  });

  test('it appears only on the pages that carry a diagram, with the offline note and the source', () => {
    const withDiagram = built.pages.filter((p) => p.diagrams > 0).map((p) => p.page);
    assert.deepEqual(withDiagram, ['docs/guide.html'], 'the archetype\'s diagram moved — re-aim this test');
    for (const page of [...pagesOn(out)]) {
      const html = readPage(out, page);
      const shouldHave = withDiagram.includes(page);
      assert.equal(html.includes(MERMAID_CDN), shouldHave,
        shouldHave ? `${page} carries a diagram and does not load the script` : `${page} has no diagram and still names an external host`);
      assert.equal(/<noscript>/.test(html), shouldHave, `${page}: the noscript note does not follow the diagram`);
    }
    const guide = readPage(out, 'docs/guide.html');
    assert.match(guide, /<pre class="mermaid">flowchart TD/, 'the diagram block is gone');
    assert.match(guide, /<details><summary>diagram source<\/summary>/,
      'the diagram source is gone, so a reader with no script has nothing at all');
    assert.match(guide, /startOnLoad:false/, 'the init does not wait for the page');
    assert.match(guide, /securityLevel:"strict"/, 'the diagram library is not asked to keep label text out of markup');
  });
});

// --- the registry rows this module now owes ---------------------------------------------------------------

describe('the site: the module is registered where the pack expects it (O-4a\'s open fence)', () => {
  test('modhealth.SUBSYSTEMS declares site.js with exactly the exports respawnpack.js reads', () => {
    const entry = modhealth.SUBSYSTEMS.site;
    assert.ok(entry, 'kernel/lib/modhealth.js does not register the site subsystem, so doctor could only say the file loads');
    assert.equal(entry.file, 'site.js');
    assert.deepEqual(Object.keys(entry.exports).sort(), ['buildSite', 'serve']);
    const cli = fs.readFileSync(path.join(KERNEL, 'respawnpack.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const name of Object.keys(entry.exports)) {
      assert.ok(cli.includes(`siteLib.${name}(`), `respawnpack.js does not call siteLib.${name} — a contract entry with no call site is a fence about nothing`);
    }
    assert.ok(!('renderMarkdown' in entry.exports),
      'renderMarkdown is declared and no verb reads it; the registry is what production modules ACTUALLY call');
    assert.ok(!entry.postureRow, 'the site is not gated by ADR-003, so every profile must place it');
  });

  test('every shipped kernel lib is registered — O-4a\'s one known red is closed', () => {
    // The same claim kernel/kernel.test.mjs makes, restated here because THIS branch is the one that
    // closes it: `kernel/lib/site.js` was shipped by O-4a with no contract on purpose, and registering it
    // without placing it would have handed doctor a row for a file no target receives.
    const shipped = fs.readdirSync(path.join(KERNEL, 'lib')).filter((f) => f.endsWith('.js')).sort();
    const registered = Object.values(modhealth.SUBSYSTEMS).map((s) => s.file);
    assert.deepEqual(shipped.filter((f) => !registered.includes(f) && !modhealth.BOOTSTRAP.includes(f)), []);
  });

  test('install/_sources.js places lib/site.js, and the uninstaller follows that one list', () => {
    assert.ok(sources.KERNEL_FILES.includes('kernel/lib/site.js'),
      'the module is registered as a subsystem and is not in KERNEL_FILES — every installed target would report it BROKEN (anti-drift item 33)');
    for (const rel of sources.KERNEL_FILES) {
      assert.ok(fs.existsSync(path.join(ROOT, rel)), `KERNEL_FILES names ${rel}, which this pack does not ship`);
    }
    const uninstaller = fs.readFileSync(path.join(ROOT, 'install', 'uninstall.js'), 'utf8');
    assert.match(uninstaller, /SRC_KERNEL_FILES\.map/,
      'install/uninstall.js no longer derives its kernel inventory from install/_sources.js, so a placed site.js could be left behind');
  });

  test('the verb is registered, and the help text describes it', () => {
    const cli = fs.readFileSync(path.join(KERNEL, 'respawnpack.js'), 'utf8');
    assert.match(cli, /const VERBS = \{[^}]*\bsite: cmdSite\b/, 'the verb is not in VERBS');
    const help = spawnSync(process.execPath, [path.join(KERNEL, 'respawnpack.js'), '--help'], { encoding: 'utf8' });
    assert.match(help.stdout, /site \[--out <dir>\] \[--serve \[port\]\]/, 'the help text does not describe the verb');
    assert.match(help.stdout, /WITHHOLDS every number/, 'the help text does not state the freshness rule the dashboard obeys');
  });
});
