/*
 * Generates schemas/fixtures/<family>/{valid,invalid-*}.json.
 *
 * The seeds are hand-authored from the writers; the negatives are derived from the seeds by one
 * named mutation each, so a negative can never drift away from the positive it is meant to contrast
 * with. Both directions are still checked independently: kernel/schema.test.mjs validates artifacts
 * CAPTURED FROM REAL RUNS against the same schemas, so a wrong seed cannot hide a wrong schema.
 *
 * ⛔ EVERY FAMILY THE REGISTRY DECLARES MUST APPEAR HERE, AND NOTHING ELSE MAY. This generator OWNS
 * schemas/fixtures/ outright: it clears the directory and rewrites it, which is only safe while
 * FAMILIES below and schemas/registry.json name exactly the same set. That is no longer a request to
 * whoever edits this file — the fence just above the clear CHECKS it and refuses to run otherwise.
 *
 * It is stated as a rule because both directions have already cost something. A family the registry
 * declares but this file omits used to be DELETED by the next person to regenerate — that is how
 * v0.2's `context-monitor-state` and the seven rollover-core families v0.3 added lost their tracked
 * fixtures, and the only signal was kernel/schema.test.mjs failing on a family the author had never
 * touched. An entry here for a family the registry no longer declares writes an orphan directory that
 * nothing validates. An inventory built from what is present cannot report an absence, so the
 * denominator is registry.json and this file is checked against it rather than the other way round.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = path.join(ROOT, 'schemas', 'fixtures');
const clone = (o) => JSON.parse(JSON.stringify(o));

/*
 * ⛔ THE SUBJECT DIGEST COMES FROM THE PRODUCTION READER, NOT FROM A SECOND SPELLING OF IT. A fixture
 * that hashed the text here would prove only that whoever wrote it read `fingerprint()` the same way
 * twice, and the day the normalisation changed the seed would keep validating against a schema
 * describing a string the pack no longer produces.
 */
const { fingerprint } = createRequire(import.meta.url)(path.join(ROOT, 'hooks', '_exceptions.js'));

const MANIFEST = { algorithm: 'sha256', inputs: { 'docs/derived/state/requirements.json': 'a'.repeat(64), 'docs/derived/state/evidence/': 'ABSENT' } };
const REV = '0'.repeat(40);
const ISO = '2026-08-04T00:00:00.000Z';

const STATE_VALID = {
  schemaVersion: '1.0.0',
  generatedAt: ISO,
  generatedBy: 'respawnpack state — GENERATED, never hand-edit',
  sourceRevision: REV,
  sourceManifest: MANIFEST,
  tracksRequirements: true,
  denominatorVersion: 'schema-1',
  ongoingGoalId: 'G-1',
  goal: 'ship it',
  forbidden: ['git push'],
  authority: ['edit code'],
  milestone: null,
  milestoneComplete: false,
  goalComplete: false,
  goalCompletion: { status: 'UNMET', criteria: [{ text: 'all-mandatory-conformant', kind: 'all-mandatory-conformant', status: 'UNMET', detail: '0/2 mandatory conformant' }], why: 'a stated criterion is unmet' },
  counts: { total: 2, mandatory: 2, conformant: 0, candidate: 0, unevidenced: 2, waived: 0, blocked: 0, staleEvidence: 0 },
  requirements: [{ id: 'R-1', title: 'one', mandatory: true, risk: 'normal', priority: null, gate: 'G1', status: 'unevidenced', why: 'no accepted evidence', evidence: [], blockedBy: [], claimTypes: ['untriaged'] }],
  gates: [{ id: 'G1', title: 'gate one', denominator: 1, conformant: 0, complete: false, missingRows: [], status: 'INCOMPLETE', note: null }],
  openP0P1: [],
  blockers: [],
  transitivelyBlocked: [],
  projectBlocked: false,
  currentAtomicTask: null,
  nextUnblockedWork: [{ id: 'R-1', title: 'one', status: 'unevidenced' }],
  lastQualified: null,
  evidence: { accepted: 0, rejected: [{ file: 'e1.json', reason: 'no verdict' }] },
  constraints: ['no pushes'],
  killedFeatures: [{ id: 'K-1', feature: 'magic gauntlet', status: 'clear', risk: 'normal' }],
  removals: { status: 'PASS', why: ['1 row clear'], scannedFiles: 3, scannedDirs: ['docs'], extensions: ['.md'], notScanned: [], unreadable: [], scannedAtRevision: REV, corpusManifest: MANIFEST },
  lineage: { status: 'FAIL', counts: { sources: 2, derivations: 1, pass: 0, fail: 1, undetermined: 0 }, failing: ['guac-config'], failingTruncated: false },
  reconciliation: { status: 'DRIFT', why: 'TASK_WITHOUT_PROJECT_RECORD: T-9 · PROJECT_RECORD_WITHOUT_TASK: G-4', counts: { tasks: 3, project: 3, drift: 2 }, driftIds: ['TASK_WITHOUT_PROJECT_RECORD:T-9', 'PROJECT_RECORD_WITHOUT_TASK:G-4'], driftTruncated: false },
  cannotDetermine: [],
};

/*
 * ⭐ v0.3 · THE ROLLOVER CORE'S SHARED SEED IDS. Six families below describe ONE conversation crossing
 * ONE compaction boundary: the handoff, the receipt proving it was read back, the receipt proving it
 * was consumed exactly once, the cycle they all belong to, the thresholds that fired inside that cycle,
 * and the journal that ordered the lot. They are declared once here on purpose — a fixture set whose
 * records disagree about WHICH cycle or WHICH handoff they describe validates perfectly and proves
 * nothing, which is the failure mode a per-file hand-authored id invites.
 */
const CYCLE_ID = 'claude-code:sess-compact-1:0:aabbccddeeff';
const HANDOFF_ID = 'ho_a1b2c3d4e5f60718';
const HANDOFF_DIGEST = '90458769396f3f39838918b13b888f1496d8d75307c11321e75b4e1cbc1d5565';
const ROLLOVER_ISO = '2026-08-06T12:00:00.000Z';

const CYCLE_VALID = {
  host: 'claude-code', conversationId: 'sess-compact-1', index: 0, nonce: 'aabbccddeeff',
  startedAt: ROLLOVER_ISO, provenance: 'minted', cycleId: CYCLE_ID,
};

// The journal is a UNION — a row and the folded snapshot — and the snapshot embeds the cycle record
// above verbatim, so the two families cannot disagree about the identity they share.
const JOURNAL_SNAPSHOT = {
  v: 1, at: '2026-08-06T12:00:01.100Z',
  derivedFrom: 'journal.jsonl — the authority; this file is a fast path and a cross-check',
  state: 'COMPACTING', cycleId: CYCLE_ID, cycle: CYCLE_VALID, halted: null,
  verifiedHandoff: { handoffId: HANDOFF_ID, equal: true },
  counts: { transitions: 5, noops: 0, refusals: 0, halts: 0, consumptions: 0 }, seq: 5,
};

// candidate-memory keeps its own cycle id: a captured memory outlives the rollover cycle that captured
// it, so its provenance names a memory-graph cycle rather than one of the ids above.
const MEMORY_CYCLE = '663ec2eaabbccddeeff00112233445566778899';
const PROMOTION_EVIDENCE = 'ran the fix locally against the contention fixture, 20/20 clean';
const CANDIDATE_PROMOTED = {
  schemaVersion: '2.0.0', kind: 'candidate-memory', id: 'cm_b2c3d4e5f6a7b8c9',
  claim: 'index-guard deadlocks when three writers race one lease file without a bounded retry',
  klass: 'root-cause-fix',
  provenance: {
    by: 'operator', at: '2026-08-06T12:05:00.000Z', cycleId: MEMORY_CYCLE,
    conversationId: null, host: null, sourceKind: 'operator', evidencePaths: [],
  },
  verificationState: 'verified',
  verification: { by: 'founder', at: '2026-08-06T12:10:00.000Z', evidencePaths: [PROMOTION_EVIDENCE], note: PROMOTION_EVIDENCE },
  rejection: null, supersededBy: null,
};

const FAMILIES = {
  'compiled-state': {
    valid: STATE_VALID,
    extraValid: { name: 'valid-untracked', doc: { schemaVersion: '1.0.0', generatedAt: ISO, sourceRevision: REV, sourceManifest: MANIFEST, tracksRequirements: false, cannotDetermine: ['no approved requirement source'], ongoingGoalId: null, goal: null, goalComplete: false, goalCompletion: { status: 'CANNOT_DETERMINE', criteria: [], why: 'no goal contract' }, milestone: null, currentAtomicTask: null, constraints: [], forbidden: [], killedFeatures: [], removals: { status: 'CANNOT_DETERMINE', why: 'no registry' }, lineage: { status: 'NOT_APPLICABLE', counts: { sources: 0, derivations: 0, pass: 0, fail: 0, undetermined: 0 }, failing: [], failingTruncated: false }, reconciliation: { status: 'NOT_CONFIGURED', why: 'no state.reconcile in respawnpack.config.json', counts: { tasks: 0, project: 0, drift: 0 }, driftIds: [], driftTruncated: false } } },
    negatives: {
      'missing-required': (d) => { delete d.sourceManifest; return d; },
      'wrong-type': (d) => { d.counts.conformant = '0'; return d; },
      'unknown-schema-version': (d) => { d.schemaVersion = '9.9.9'; return d; },
      'malformed-nested': (d) => { d.gates[0].status = 'MOSTLY_DONE'; return d; },
      'undeclared-field': (d) => { d.mode = 'goal'; return d; },
      'untracked-with-counts': (d) => { d.tracksRequirements = false; return d; },
    },
  },
  requirements: {
    valid: { schemaVersion: '1.0.0', denominatorVersion: 'v1', requirements: [{ id: 'R-1', title: 'one', mandatory: true, gate: 'G1' }], gates: { G1: { title: 'gate one', requires: ['R-1'] } } },
    negatives: {
      'missing-required': (d) => { delete d.requirements; return d; },
      'wrong-type': (d) => { d.requirements = { 'R-1': {} }; return d; },
      'malformed-nested': (d) => { d.requirements[0].id = 42; return d; },
      'malformed-nested-gate': (d) => { d.gates.G1.requires = 'R-1'; return d; },
      'malformed-nested-blocked': (d) => { d.requirements[0].blockedBy = 'R-2'; return d; },
    },
    exempt: { 'unknown-schema-version': 'kernel/lib/state.js never reads this file\'s schemaVersion — it is present by convention only, and additionalProperties is TRUE because the founder owns the file. Declaring a const here would make the schema stricter than the code it documents.' },
  },
  'task-queue': {
    // AUTHORED input (writer:null), the same class as requirements — see this family's writerNote in
    // schemas/registry.json. One row is enough to prove the schema discriminates; the ordering and
    // dependsOn semantics a real queue would exercise are for the future runner, not this fixture.
    valid: {
      schemaVersion: '1.0.0',
      tasks: [{
        id: 'T-1', title: 'add the CSV export button', specPointer: 'PLAN.md decision 2.1',
        scope: { files: ['src/export.ts'], dirs: [] },
        intent: 'Give the report page a CSV export next to the existing PDF one.',
        acceptance: ['clicking Export CSV downloads a file with one row per visible record'],
        gates: { savepoint: true, gate: true, only: ['test'] },
        dependsOn: [], state: 'ready', risk: 'low; additive UI, no existing route changes',
        provenance: { createdBy: 'planner', createdAt: ISO },
      }],
    },
    /*
     * ⭐ THE SECOND SEED IS THE `tools` HALF (P5-N-6b), AND IT IS A SECOND SEED ON PURPOSE. The field
     * is OPTIONAL, so the two shapes are genuinely different documents: the primary row above declares
     * nothing and takes the runner's declared default, this one narrows to exactly what its own task
     * needs. A fixture set that only carried the declaring form would leave "absent means default" —
     * the common case — unproved, and one that only carried the primary would leave the new field with
     * no fixture at all.
     */
    extraValid: [
      {
        name: 'valid-declared-tools',
        doc: {
          schemaVersion: '1.0.0',
          tasks: [{
            id: 'T-2', title: 'correct the export heading', specPointer: 'PLAN.md decision 2.1',
            scope: { files: ['docs/export.md'], dirs: [] },
            intent: 'Fix the heading the CSV export page shows; no code changes.',
            acceptance: ['docs/export.md names the export "Export CSV", matching the button'],
            tools: ['Read', 'Edit', 'Bash(git status)', 'Bash(git diff *)'],
            gates: { savepoint: true, gate: false },
            dependsOn: ['T-1'], state: 'ready', risk: 'low; one prose heading, no behaviour',
            provenance: { createdBy: 'planner', createdAt: ISO },
          }],
        },
      },
      /*
       * ⭐ A THIRD SEED FOR taskClass (P4-M-5), KEPT SEPARATE FROM THE tools SEED ABOVE ON PURPOSE. The
       * two optional fields are independent concerns — which tools a session may run, and which model
       * it runs on — and a seed that declared both would leave a reader guessing which mutation below
       * exercises which field. This row also has no `tools`, so it doubles as a second control for "a
       * declared optional field does not disturb the other".
       */
      {
        name: 'valid-declared-task-class',
        doc: {
          schemaVersion: '1.0.0',
          tasks: [{
            id: 'T-3', title: 'review the token-exchange path for injection and replay', specPointer: 'PLAN.md P4-M-5',
            scope: { files: ['src/auth.ts'], dirs: [] },
            intent: "Route this row to the model the capability register's evidence prefers for security review, not the coding default.",
            acceptance: ["the auth module's new token-exchange path is reviewed for injection and replay"],
            taskClass: 'security-testing',
            gates: { savepoint: true, gate: true },
            dependsOn: [], state: 'ready', risk: 'medium; touches the token exchange path',
            provenance: { createdBy: 'planner', createdAt: ISO },
          }],
        },
      },
    ],
    negatives: {
      'missing-required': (d) => { delete d.tasks[0].specPointer; return d; },
      'wrong-type': (d) => { d.tasks[0].dependsOn = 'T-0'; return d; },
      'unknown-schema-version': (d) => { d.schemaVersion = '9.9.9'; return d; },
      'malformed-nested': (d) => { d.tasks[0].gates.only = 'test'; return d; },
      // The declaring seed is the only one that can express these two, because the field is absent
      // from the other: a `tools` that is not a list of rules, and a list that grants nothing at all.
      'malformed-tools': { from: 'valid-declared-tools', mutate: (d) => { d.tasks[0].tools = 'Read,Edit'; return d; } },
      /*
       * ⛔ EMPTY IS NOT "TAKE THE DEFAULT". A row declaring `tools: []` says its session may use no
       * tool at all, which is not something a planner means; left accepted it would be indistinguishable
       * from an absent field and would quietly grant MORE than the row asked for. Omitting the field is
       * how a row takes the default, and it is the only way.
       */
      'empty-tools': { from: 'valid-declared-tools', mutate: (d) => { d.tasks[0].tools = []; return d; } },
      /*
       * ⛔ P4-M-5 · A CLASS route() CAN NEVER BE ASKED FOR IS A QUEUE DEFECT, NOT SOMETHING TO GUESS
       * AROUND. Named after the same invented class core/core.test.mjs's own P4-M-2 tests use for "a
       * class nothing declares", so a reader who has seen one recognises the other.
       */
      'unknown-task-class': { from: 'valid-declared-task-class', mutate: (d) => { d.tasks[0].taskClass = 'summarizing'; return d; } },
    },
  },
  evidence: {
    valid: { schemaVersion: '1.0.0', requirements: ['R-1'], sourceRevision: REV, verdict: 'pass', positiveControl: { passed: true }, negativeControl: { detected: true }, claimType: 'real-engine qualified', qualifiedBy: 'independent', timestamp: ISO, tool: 'fixture', toolVersion: '1.0.0' },
    negatives: {
      'missing-required': (d) => { delete d.negativeControl; return d; },
      'wrong-type': (d) => { d.requirements = 'R-1'; return d; },
      'unknown-schema-version': (d) => { d.schemaVersion = '9.9.9'; return d; },
      'malformed-nested': (d) => { d.positiveControl.passed = 'yes'; return d; },
      'empty-claim': (d) => { d.requirements = []; return d; },
      'bad-claim-type': (d) => { d.claimType = 'vibes'; return d; },
    },
  },
  'goal-contract': {
    valid: { schemaVersion: '1.0.0', goals: { 'G-1': { id: 'G-1', goal: 'ship it', completion: ['all-mandatory-conformant', { kind: 'gate-complete', gate: 'G1' }], constraints: ['no pushes'], authority: [], forbidden: ['git push'], externalBlockers: [], createdAt: ISO, contextStages: { checkpoint: 60, closeout: 75, handoff: 85 }, hostNote: 'No hook can create a session.' } }, ongoingGoalId: 'G-1', completedGoalIds: [] },
    extraValid: { name: 'valid-legacy-flat', doc: { schemaVersion: '1.0.0', goal: 'a pre-goals document', completion: ['all-mandatory-conformant'], constraints: [], activeGoalId: 'G-legacy' } },
    negatives: {
      'wrong-type': (d) => { d.goals = []; return d; },
      'unknown-schema-version': (d) => { d.schemaVersion = '9.9.9'; return d; },
      'malformed-nested': (d) => { d.goals['G-1'].constraints = 'no pushes'; return d; },
      'malformed-nested-stages': (d) => { d.goals['G-1'].contextStages = { checkpoint: 60, bogus: 1 }; return d; },
      'missing-required-nested': (d) => { d.goals['G-1'].completion = 'all-mandatory-conformant'; return d; },
    },
    exempt: { 'missing-required': 'This document has no required top-level property, and that is deliberate: an empty goal.json is a project with no goal, which is a legitimate and common state rather than a malformed file.' },
  },
  'removals-registry': {
    valid: { schemaVersion: '1.0.0', removals: [{ id: 'K-1', feature: 'magic gauntlet', forbidden: ['the gauntlet grants'], risk: 'high', controls: { good: 'the gauntlet was removed in v2', bad: 'the gauntlet grants three wishes' }, reason: 'cut in the v2 scope review' }] },
    negatives: {
      'missing-required': (d) => { delete d.removals[0].forbidden; return d; },
      'wrong-type': (d) => { d.removals = {}; return d; },
      'unknown-schema-version': (d) => { d.schemaVersion = '9.9.9'; return d; },
      'malformed-nested': (d) => { d.removals[0].forbidden = []; return d; },
      'malformed-nested-controls': (d) => { delete d.removals[0].controls.bad; return d; },
    },
  },
  /*
   * lineage — docs/derived/state/lineage.json, AUTHORED (writer:null, the class of requirements and
   * removals-registry), so this seed is a clean fixture rather than a copy of any real project's rows.
   * It is the owner's own instance in miniature: a range inventory that IS the truth, a template box
   * that must never be the truth, and a per-range configuration generated from the first — the exact
   * shape the guac case fails on when the marker names the second.
   */
  lineage: {
    valid: {
      schemaVersion: '1.0.0',
      sources: [
        { id: 'range-inventory', kind: 'inventory', path: 'inventory/range.yml', authority: 'source-of-truth', note: 'the per-range host list; every range-specific file is generated from this one' },
        { id: 'template-inventory', kind: 'template', path: 'inventory/template.yml', authority: 'source-of-truth' },
        { id: 'upstream-openapi', kind: 'schema', url: 'https://example.invalid/openapi.yaml', authority: 'source-of-truth' },
      ],
      derivations: [
        { id: 'guac-config', target: 'config/guac/range.conf', from: ['range-inventory'], how: 'generate', neverFrom: ['template-inventory'], required: true },
        { id: 'generated-client', target: 'src/generated/**/*.ts', from: ['upstream-openapi'], how: 'generate' },
      ],
    },
    negatives: {
      // A derivation with no `from` is a target nothing can be checked against — the row would exist and
      // establish nothing, which is the shape this contract is here to make unspellable.
      'missing-required': (d) => { delete d.derivations[0].from; return d; },
      'wrong-type': (d) => { d.derivations[0].required = 'true'; return d; },
      'unknown-schema-version': (d) => { d.schemaVersion = '9.9.9'; return d; },
      'malformed-nested': (d) => { d.sources[0].kind = 'spreadsheet'; return d; },
      // ⛔ EXACTLY ONE OF path/url. A source declaring both would give a marker two things to be
      // compared against and no rule for which wins; declaring neither names no bytes at all.
      'source-with-both-locations': (d) => { d.sources[0].url = 'https://example.invalid/range.yml'; return d; },
      // Dropping `authority` is the quiet one: the entry still LOOKS like a source, and a reader would
      // have to guess whether the derivations are checked against it.
      'source-without-authority': (d) => { delete d.sources[1].authority; return d; },
      // `how` outside the four erases the one thing that tells a reader which repair to reach for.
      'unknown-how': (d) => { d.derivations[1].how = 'symlink'; return d; },
    },
  },
  'reconciliation-source': {
    valid: { schemaVersion: '1.0.0', tasks: [{ id: 'T-1', title: 'shared work', status: 'open' }, { id: 'T-2', title: 'shipped', status: 'done' }] },
    extraValid: { name: 'valid-no-version', doc: { gaps: [{ id: 'G-1', status: 'open', requirement: 'R-1', gate: 'G1' }] } },
    negatives: {
      'unknown-schema-version': (d) => { d.schemaVersion = '9.9.9'; return d; },
      'wrong-type': () => ['not', 'an', 'object'],
      'malformed-nested': (d) => { d.tasks[0].id = 42; return d; },
      'malformed-nested-status': (d) => { d.tasks[0].status = 7; return d; },
    },
    exempt: {
      'missing-required': 'The document itself declares no required top-level property, because the record ARRAY lives at whatever `pointer` the project declares — a project may nest its rows anywhere, and requiring a fixed key here would reject every source that does. The record shape ($defs/record) is where `id` and `status` are required, and the reconciler enforces exactly that: a record with no stable identifier is rejected and REPORTED, never skipped.',
    },
  },
  'skill-meta': {
    valid: { schemaVersion: '1.0.0', skill: 'debug', baseHash: 'b'.repeat(64), enabledAt: ISO, lastReset: null, overlayBudgetLines: 12, source: 'memory entities with `applies-to|skill:debug`' },
    negatives: {
      'missing-required': (d) => { delete d.baseHash; return d; },
      'wrong-type': (d) => { d.overlayBudgetLines = '12'; return d; },
      'unknown-schema-version': (d) => { d.schemaVersion = '9.9.9'; return d; },
      'malformed-nested': (d) => { d.supersededByUpgrade = { lines: 4, archive: 'SKILL.old.md' }; return d; },
      'malformed-hash': (d) => { d.baseHash = 'not-a-sha'; return d; },
    },
  },
  'project-config': {
    valid: {
      respawnpack: '0.2.0',
      installedAt: ISO,
      qualityGate: { notApplicable: true, reason: 'a documentation-only repository' },
      posture: { profile: 'standard', overrides: { 'push-guard:tier1': { verdict: 'off', reason: 'solo repo, every push reviewed at the PR' } } },
      /*
       * ⛔ TWO ENTRIES, TWO RULES, TWO DIFFERENT SUBJECT SHAPES (P1-E-1a). One AND-matched pair
       * (`fingerprint` plus `path`, the narrowest allowance the grammar can express) and one path-only
       * glob, so the seed exercises both the multi-key rule and the single-key one — a seed carrying a
       * single shape would leave the negatives below deriving from a document that never used the key
       * the way a real project does. No secret text appears anywhere: what a founder declares is the
       * DIGEST the guard printed, which is the point of the fingerprint kind.
       */
      exceptions: [
        {
          id: 'aws-doc-example-key',
          rule: 'secret-scan',
          match: { fingerprint: fingerprint('the AWS documentation example access key id, quoted verbatim in the setup guide'), path: 'docs/aws-setup.md' },
          reason: 'the AWS documentation example key quoted in the setup guide — a published placeholder, not a credential',
          declaredBy: 'owner',
          declaredAt: '2026-09-03',
          expires: '2027-03-01',
        },
        {
          id: 'security-triage-payloads',
          rule: 'injection-scan',
          match: { path: 'docs/security/**' },
          reason: 'the security write-ups quote injection payloads on purpose; every file under this path is reviewed prose',
        },
      ],
      projectType: 'docs-only',
      /*
       * ⛔ ONE PROVIDER BLOCK, CARRYING A VARIABLE NAME AND NOT A VALUE (P4-M-3, anti-drift item 52).
       * MiniMax is the worked example because it is the first provider the owner holds a key for, and
       * every string here is a NAME or a published id: the base URL and the two model ids come from
       * the vendor's own documentation (recorded with their access date in the run's evidence file),
       * and `MINIMAX_API_KEY` is the name of an environment variable, not a credential. The negatives
       * below derive from a seed that uses the key exactly the way a real project does.
       */
      providers: {
        minimax: {
          protocol: 'openai-compatible',
          baseUrl: 'https://api.minimax.io/v1',
          apiKeyEnv: 'MINIMAX_API_KEY',
          models: ['MiniMax-M3', 'MiniMax-M2.7'],
          note: 'the international platform; the owner exports the variable in the shell that runs the pack, and nothing writes it here',
        },
      },
      state: { removals: { registry: 'docs/derived/state/removals.json', liveContentDirs: ['docs', 'story'], extensions: ['.md'] }, adapters: [{ name: 'lint', command: 'npm', args: ['run', 'lint'], critical: true, controls: { good: 'ok.js', bad: 'bad.js' } }] },
      founderOwnKey: 'kept, because additionalProperties is true',
    },
    negatives: {
      'wrong-type': (d) => { d.state.removals.liveContentDirs = 'docs'; return d; },
      'malformed-nested': (d) => { d.state.adapters[0].args = 'run lint'; return d; },
      'malformed-nested-gate': (d) => { d.qualityGate.checks = { lint: true }; return d; },
      'malformed-nested-memory': (d) => { d.memory = { engine: { node: 42 } }; return d; },
      'malformed-nested-extensions': (d) => { d.state.removals.extensions = [1, 2]; return d; },
      /*
       * ⛔ THE THREE POSTURE FAILURES, ONE FIXTURE EACH, BECAUSE THEY ARE REJECTED FOR THREE DIFFERENT
       * REASONS AND A SINGLE COMBINED FIXTURE WOULD PROVE ONLY THAT SOMETHING WAS WRONG. ADR-003 names
       * all three as INVALID rather than ignored: a posture nobody can spell is not a posture anybody
       * chose, an override nobody has to justify is an override nobody reviews, and an override on a
       * rule that is fixed in every posture must be REFUSED — silently discarding it is the same class
       * of lie as silently loosening the guard it names.
       */
      'posture-bad-profile': (d) => { d.posture.profile = 'paranoid'; return d; },
      'posture-override-no-reason': (d) => { delete d.posture.overrides['push-guard:tier1'].reason; return d; },
      'posture-override-on-fixed-id': (d) => { d.posture.overrides['secret-scan'] = { verdict: 'off', reason: 'this repository has no secrets to leak' }; return d; },
      /*
       * ⛔ AND THE PROJECT TYPE, REFUSED BY THE ENUM RATHER THAN CARRIED ALONG (P6-5-7). `projectType`
       * decides which digest sections install/install.js composes into the target's CLAUDE.md, so a
       * value the installer cannot recognise must be a REJECTED declaration and not a founder note
       * that happens to sit beside `posture` — the top level of this file is
       * `additionalProperties: true`, so declaring the key in the schema is the only thing that makes
       * the difference. The installer refuses the same value at install time by writing no block at
       * all; this fixture is that refusal at declaration time.
       */
      'project-type-unknown': (d) => { d.projectType = 'data-warehouse'; return d; },
      /*
       * ⛔ THE FIVE EXCEPTION FAILURES, ONE FIXTURE EACH, BECAUSE THEY ARE REFUSED FOR FIVE DIFFERENT
       * REASONS AND A COMBINED FIXTURE WOULD PROVE ONLY THAT SOMETHING WAS WRONG (P1-E-1a). An
       * allowance nobody has to justify is an allowance nobody reviews; a rule with no subject notion
       * has nothing for an exception to name; a `match` with no key would lift every subject the rule
       * sees, which is the whole-guard escape this grammar exists to REPLACE; a subject kind the named
       * rule never computes is a condition that can never hold, which reads as declared and lifts
       * nothing; and a date nobody can parse would decide when the allowance stops working.
       */
      'exception-no-reason': (d) => { delete d.exceptions[0].reason; return d; },
      'exception-unknown-rule': (d) => { d.exceptions[1].rule = 'lockdown'; return d; },
      'exception-no-match': (d) => { d.exceptions[1].match = {}; return d; },
      'exception-subject-kind-rule-lacks': (d) => { d.exceptions[1].match = { fingerprint: d.exceptions[0].match.fingerprint }; return d; },
      'exception-malformed-expires': (d) => { d.exceptions[0].expires = 'when we get round to it'; return d; },
      /*
       * ⛔ THE FIVE PROVIDER FAILURES, ONE FIXTURE EACH, BECAUSE THEY ARE REFUSED FOR FIVE DIFFERENT
       * REASONS (P4-M-3). The first is the one that matters most and is the only one this schema
       * refuses BY NAME rather than merely by shape: a property called `apiKey` is where a founder
       * would put a key value, and a config is a tracked file, so it is refused at declaration time in
       * the editor rather than at review time in a repository that already has the credential in its
       * history. The other four are the block's shape: a plaintext base URL carries a credential in
       * clear, an empty model list is a provider nothing can route to, a lowercase `apiKeyEnv` is not
       * an environment variable name (and is the shape an accidentally pasted VALUE would have), and a
       * protocol with no adapter is a provider nothing can reach.
       */
      'provider-key-value': (d) => { d.providers.minimax.apiKey = 'REFUSED: a value never belongs in a tracked config, which is why this fixture exists'; return d; },
      'provider-base-url-not-https': (d) => { d.providers.minimax.baseUrl = 'http://api.example.invalid/v1'; return d; },
      'provider-empty-models': (d) => { d.providers.minimax.models = []; return d; },
      'provider-env-name-lowercase': (d) => { d.providers.minimax.apiKeyEnv = 'minimax_api_key'; return d; },
      'provider-unknown-protocol': (d) => { d.providers.minimax.protocol = 'anthropic-compatible'; return d; },
    },
    exempt: {
      'missing-required': 'The founder owns this file and every key in it is optional — the installer seeds a few and the project may delete any of them. A required field here would fail a legitimate configuration.',
      'unknown-schema-version': 'This file carries no schemaVersion (it is configuration, not a versioned wire format) and additionalProperties is TRUE, so an invented one is legitimately carried rather than rejected.',
    },
  },
  'runtime-contract': {
    valid: { mode: 'goal', activeGoalId: 'G-1', suspendedGoalId: null, setAt: ISO },
    extraValid: { name: 'valid-delegate', doc: { mode: 'delegate', activeGoalId: null, suspendedGoalId: 'G-1', setAt: ISO, task: 'write the CSV writer', acceptance: ['tests pass'], authority: [], forbidden: [] } },
    negatives: {
      'missing-required': (d) => { delete d.mode; return d; },
      'wrong-type': (d) => { d.suspendedGoalId = 7; return d; },
      'unknown-schema-version': (d) => { d.schemaVersion = '9.9.9'; return d; },
      'malformed-nested': (d) => { d.acceptance = []; return d; },
      'bad-mode': (d) => { d.mode = 'autonomous'; return d; },
    },
  },
  'delegation-archive': {
    valid: { schemaVersion: '1.0.0', completed: [{ task: 'write the CSV writer', acceptance: ['tests pass'], attestedAt: ISO, attestation: 'the closing caller restated every recorded acceptance criterion; this is a claim, not a proof', evidence: 'suite green', note: null }] },
    negatives: {
      'missing-required': (d) => { delete d.completed[0].attestation; return d; },
      'wrong-type': (d) => { d.completed = {}; return d; },
      'unknown-schema-version': (d) => { d.schemaVersion = '9.9.9'; return d; },
      'malformed-nested': (d) => { d.completed[0].acceptance = 'tests pass'; return d; },
      'softened-attestation': (d) => { d.completed[0].attestation = 'the delegation was verified complete'; return d; },
    },
  },
  'session-baseline': {
    valid: { sessionId: 's-1', head: REV, files: { 'W:src/a.ts': 'c'.repeat(32), 'U:new.txt': 'd'.repeat(32) }, capturedAt: ISO, workingDigest: 'e'.repeat(32), stagedDigest: 'f'.repeat(32), indexPath: 'c:/p/.git/index' },
    negatives: {
      'missing-required': (d) => { delete d.files; return d; },
      'wrong-type': (d) => { d.files = []; return d; },
      'unknown-schema-version': (d) => { d.schemaVersion = '9.9.9'; return d; },
      'malformed-nested': (d) => { d.files['src/a.ts'] = 'c'.repeat(32); return d; },
      'malformed-digest': (d) => { d.workingDigest = 'short'; return d; },
    },
  },
  'stop-decision': {
    valid: { sessionId: 's-1', fingerprint: 'a'.repeat(32), head: REV, files: ['src/a.ts'], branch: 'blocked-for-closeout', at: ISO },
    negatives: {
      'missing-required': (d) => { delete d.fingerprint; return d; },
      'wrong-type': (d) => { d.files = 'src/a.ts'; return d; },
      'unknown-schema-version': (d) => { d.schemaVersion = '9.9.9'; return d; },
      'malformed-nested': (d) => { d.files = [1, 2]; return d; },
      'malformed-fingerprint': (d) => { d.fingerprint = 'nope'; return d; },
    },
  },
  'savepoint-attempt': {
    valid: {
      at: ISO, sessionId: 's-1', outcome: 'CANNOT_DETERMINE', exitCode: 2, blockerDigest: 'b'.repeat(32),
      // Two blockers on purpose (K-09): one carrying the emitting subsystem's own richer word in the
      // additive `label`, one without. A seed where every row had a label would not show that the field
      // is optional, which is the whole compatibility claim — an older kernel's receipt carries none.
      blockers: [
        { check: 'render:docs/derived/CONTINUITY.md', outcome: 'CANNOT_DETERMINE', detail: 'hand-authored file not yet migrated' },
        { check: 'gate:.:test', outcome: 'CANNOT_DETERMINE', detail: 'npm is not on PATH', label: 'COULD_NOT_RUN' },
      ],
      /*
       * ⛔ SEEDED AS A FULL RUN, WHICH IS THE ONLY SHAPE THAT MAY CARRY A `sourceRevision` (P4-K-08).
       * `skipped: []` beside a present `sourceRevision` is one statement, not two fields: a PARTIAL run
       * withholds that revision so the Stop hook cannot read a scoped run as a completed closeout. The
       * pairing is a WRITER invariant and is fenced where a writer invariant belongs — against the real
       * receipt a real run leaves, in kernel/kernel.test.mjs — because schemas/validate.mjs implements
       * no cross-field keyword and a rule it silently ignored would be a check of nothing.
       */
      stages: {
        requested: ['compile', 'writeback', 'render', 'verify', 'removals', 'reconcile', 'coverage', 'adapters', 'memory'],
        ran: ['compile', 'writeback', 'render', 'verify', 'removals', 'reconcile', 'coverage', 'adapters', 'memory'],
        skipped: [],
      },
      // The source the run verified and where it ran — equal here; they differ only when the run
      // happened on top of savepoint-only commits (the Stop hook's quiet case).
      sourceRevision: REV, head: REV,
    },
    negatives: {
      /*
       * ⛔ THE STAGE SET IS THE ANTI-FORGERY FIELD, SO A STAGE NAME NOTHING RUNS IS A REJECTION. A
       * receipt naming `remvoals` describes a run nobody can reconstruct; accepting it would let the
       * one durable record of "which checks actually happened" carry a name with no checks behind it.
       */
      'unknown-stage-name': (d) => { d.stages.ran = ['compile', 'remvoals']; return d; },
      'missing-required': (d) => { delete d.blockerDigest; return d; },
      // Same rule as stop-decision: this record is rewritten wholesale by the next run and never
      // migrated, so it declares no schemaVersion — and additionalProperties:false is what makes an
      // unexpected one a rejection rather than a field quietly along for the ride.
      'unknown-schema-version': (d) => { d.schemaVersion = '9.9.9'; return d; },
      // The digest is the re-arm key: a reader that accepted a non-digest would suppress the nag forever.
      'malformed-digest': (d) => { d.blockerDigest = 'nope'; return d; },
      // ⛔ exitCode 0 is what "it finished" means to hooks/stop-savepoint.js, so an out-of-range one is
      // the field most worth rejecting — a bad value here decides whether the operator is told anything.
      'wrong-type': (d) => { d.exitCode = '2'; return d; },
      'out-of-range-exit': (d) => { d.exitCode = 7; return d; },
      'malformed-nested': (d) => { d.blockers = [{ check: 'x', outcome: 'PASS', detail: 'a passing check is not a blocker' }]; return d; },
    },
  },
  'task-attempt': {
    /*
     * The receipt of ONE task attempt, seeded in the shape that carries the most signal: a gate that
     * FAILED beside one that could not run at all, and an attestation that is complete. That pairing
     * is the point — the two non-passing rows have DIFFERENT outcomes (FAIL vs CANNOT_DETERMINE) for
     * the reason anti-drift item 2 states, and a seed where they were the same would document the
     * collapse instead of the rule.
     */
    valid: {
      kind: 'respawnpack-task-attempt',
      schemaVersion: '1.0.0',
      at: ISO,
      taskId: 'T-1',
      title: 'add the CSV export button',
      attempt: 1,
      sessionId: 'sess-task-1',
      outcome: 'FAIL',
      exitCode: 1,
      /*
       * ⛔ WHAT THE SESSION WAS PERMITTED, BESIDE WHAT IT ACHIEVED (P5-N-6b). Seeded with the host's
       * own trust sentence present, because that is the pairing this field was added for: a FAILING
       * attempt whose receipt shows the settings file was discarded and the argv list is what applied.
       * A seed with `trustRefused: null` would document the quiet case and leave the loud one unproved.
       */
      tools: {
        source: 'default',
        allowed: ['Read', 'Edit', 'Write', 'Bash(node .claude/respawnpack/respawnpack.js contract *)', 'Bash(git status)', 'Bash(git diff *)', 'Bash(git log *)'],
        trustRefused: 'Ignoring 9 permissions.allow entries from .claude/settings.json: this workspace has not been trusted.',
        // P3-I-2: this project declared neither posture nor projectType, so it derives the floor above
        // byte for byte — posture `strict` (hooks/_posture.js's DEFAULTED resolution) and no projectType.
        derivedFrom: { posture: 'strict', projectType: null },
      },
      /*
       * ⛔ P4-M-5 · SEEDED IN THE OVERRIDDEN SHAPE, THE RICHEST ONE. `model` is what route() chose for
       * this row's declared `taskClass`; `effectiveModel` differs from it because the owner typed
       * `--model` on this run, which is the pairing this field exists to make legible — a seed where
       * the two always matched would leave "the owner's choice, not the router's" unproved.
       */
      route: {
        taskClass: 'coding',
        family: 'anthropic',
        model: 'claude-fable-5-1',
        effectiveModel: 'claude-opus-5',
        rating: 'preferred',
        why: 'claude-fable-5-1 is preferred (current) for coding, the best-ranked available candidate.',
        overridden: true,
        overriddenBy: '--model claude-opus-5 on the command line',
        register: { source: 'pack', path: 'D:/pack/spine/reference/models/capability-register.json', why: null },
      },
      gates: {
        outcome: 'FAIL',
        scopeRequested: ['test'],
        // ⛔ null while the runner applies no gate scoping: the request is recorded, the FULL gate ran,
        // and saying so is what stops an unapplied narrowing from reading as an applied one. P4-K-08
        // landed `savepoint --only`/`--skip` and left this seam unwired, since `gates.only` names
        // project gate ids and `--only` names savepoint stages.
        scopeApplied: null,
        checks: [
          { id: 'savepoint --verify', kind: 'kernel', outcome: 'PASS', exitCode: 0, command: 'node', args: ['.claude/respawnpack/respawnpack.js', 'savepoint', '--verify', '--json'], detail: 'the kernel verified the projection and every rendered claim (exit 0)' },
          { id: 'qualityGate:test', kind: 'project', outcome: 'FAIL', exitCode: 1, command: 'npm', args: ['test'], detail: 'ran in . and exited 1' },
          { id: 'qualityGate:lint', kind: 'project', outcome: 'CANNOT_DETERMINE', exitCode: null, command: 'ruff', args: ['check', '.'], detail: 'command not found: ruff' },
        ],
      },
      acceptance: {
        outcome: 'PASS',
        contractStatus: 'ATTESTED',
        recorded: ['clicking Export CSV downloads a file with one row per visible record'],
        attested: ['clicking Export CSV downloads a file with one row per visible record'],
        unattested: [],
        attestedAt: ISO,
        evaluation: [{
          criterion: 'clicking Export CSV downloads a file with one row per visible record',
          attested: true,
          evaluation: 'CANNOT_DETERMINE',
          why: 'a prose acceptance criterion is not something this runner can evaluate; the attestation beside it is a claim the closing caller made, not a proof',
        }],
        detail: 'the kernel archived an attestation for all 1 recorded criterion(s) — a claim under the kernel\'s own refusal of a partial close, and not a proof',
      },
      handoff: { status: 'WRITTEN', handoffId: HANDOFF_ID, path: `.respawnpack/runtime/rollover/claude-code-sess-task-1/${HANDOFF_ID}.json`, cycleId: CYCLE_ID, verified: true, detail: 'written and read back identical' },
      turn: { seq: 1, file: '.respawnpack/runtime/tasks/T-1/turn-001.json', lines: 12, digest: HANDOFF_DIGEST },
    },
    negatives: {
      'missing-required': (d) => { delete d.acceptance.unattested; return d; },
      'wrong-type': (d) => { d.attempt = '1'; return d; },
      'unknown-schema-version': (d) => { d.schemaVersion = '9.9.9'; return d; },
      'out-of-range-exit': (d) => { d.exitCode = 7; return d; },
      /*
       * ⛔ THE ONE THIS FAMILY EXISTS TO REFUSE. A criterion whose machine EVALUATION reads PASS is a
       * program ruling on prose in its own favour — the substitution `evaluation`'s const pins shut.
       * The attestation beside it may be true; the evaluation may never be anything but
       * CANNOT_DETERMINE.
       */
      'evaluated-prose': (d) => { d.acceptance.evaluation[0].evaluation = 'PASS'; return d; },
      'malformed-nested': (d) => { d.gates.checks[0].outcome = 'GREEN'; return d; },
      /*
       * ⛔ THE ALLOW LIST HAS THREE DECLARED SOURCES AND THE SETTINGS FILE IS NOT ONE OF THEM. That is
       * the whole finding of the field run of 2026-09-03 D3: an untrusted workspace's
       * `permissions.allow` is discarded outright, so a receipt claiming the settings file granted the
       * session its tools would be recording something that cannot have happened.
       */
      'unknown-tools-source': (d) => { d.tools.source = 'settings'; return d; },
      /*
       * ⛔ P3-I-2 · A RECEIPT THAT CANNOT SAY WHAT ITS PROJECT DERIVED IS AS INCOMPLETE AS ONE THAT
       * CANNOT SAY WHO GRANTED THE TOOLS. `derivedFrom` is required precisely so "what would this
       * project have derived" survives even when a row narrowed the list or the owner overrode it.
       */
      'missing-tools-derivedfrom': (d) => { delete d.tools.derivedFrom; return d; },
      /*
       * ⛔ P4-M-5 · THE ONE THIS FIELD EXISTS TO MAKE UNSPELLABLE (anti-drift item 54). A task session
       * is always hook-bearing, so `route.family` is `const: "anthropic"`; a receipt naming any other
       * family would be recording a route that never had a mechanism to produce it.
       */
      'route-non-anthropic-family': (d) => { d.route.family = 'openai'; return d; },
      // The same invented class the task-queue and capability-register fixtures use for "a class
      // nothing in this pack's vocabulary declares" — consistent naming across the three families.
      'unknown-route-task-class': (d) => { d.route.taskClass = 'summarizing'; return d; },
    },
  },
  /*
   * offload-receipt — .respawnpack/runtime/offload-<id>.json, written by adapters/providers/offload.js.
   * Seeded in the shape that carries the most signal: a turn that DID NOT PRODUCE AN ANSWER, on a route
   * that had to skip an unreachable family to reach the one it used. A clean PASS would validate the one
   * shape that was never in question and leave `provider.kind`, the field that says WHICH way a provider
   * failed, as a value nothing had ever written. The same reasoning task-attempt's own seed states.
   */
  'offload-receipt': {
    valid: {
      kind: 'respawnpack-offload-receipt',
      schemaVersion: '1.0.0',
      at: ISO,
      id: 'review-0a1b2c3d4e5f',
      taskClass: 'review',
      outcome: 'CANNOT_DETERMINE',
      exitCode: 2,
      register: { source: 'pack', path: 'spine/reference/models/capability-register.json', asOf: '2026-01-02' },
      route: {
        family: 'example-family-1',
        model: 'example-model-1',
        rating: 'capable',
        why: 'example-model-1 is capable (current) for review, the best-ranked available candidate.',
        asOf: '2026-01-02',
        practice: 'docs/reference/models/prompting-general.md',
        alternatives: [{ family: 'example-family-1', model: 'example-model-3', rating: 'unproven', why: 'example-model-3 is unproven (legacy)' }],
        skipped: [{ family: 'example-family-2', why: 'the environment variable this fixture family names is unset in this process' }],
      },
      envelope: {
        name: 'general',
        fallback: true,
        practice: 'docs/reference/models/prompting-general.md',
        why: 'the general envelope, which is the fallback; no envelope is written for the family "example-family-1"',
      },
      provider: {
        name: 'openai-compatible',
        family: 'example-family-1',
        model: 'example-model-1',
        kind: 'TIMEOUT',
        detail: 'the request was cancelled at the deadline, which is an observation of a clock and never a completion',
      },
      availability: [
        { family: 'example-family-1', ok: true, why: 'EXAMPLE_PROVIDER_ENV_NAME is set in this process; presence is all that is checked' },
        { family: 'example-family-2', ok: false, why: 'the environment variable this fixture family names is unset in this process' },
      ],
      retry: {
        attempted: false,
        from: null,
        to: null,
        why: 'this path runs exactly one turn on the routed provider and stops; a second attempt on another family would spend a budget the operator did not choose',
      },
      usage: { input: null, output: null },
      durationMs: 1234,
      input: { path: '/tmp/fixture/unit-of-work.md', bytes: 42, digest: 'a'.repeat(64) },
      output: { path: null, bytes: null, digest: null },
    },
    negatives: {
      'missing-required': (d) => { delete d.route.skipped; return d; },
      'wrong-type': (d) => { d.durationMs = '1234'; return d; },
      'unknown-schema-version': (d) => { d.schemaVersion = '9.9.9'; return d; },
      'wrong-kind': (d) => { d.kind = 'offload'; return d; },
      'unknown-task-class': (d) => { d.taskClass = 'pentesting'; return d; },
      'malformed-nested': (d) => { d.route.rating = 'best'; return d; },
      'extra-property': (d) => { d.prompt = 'the composed prompt, which this receipt has no field for'; return d; },
      /*
       * ⛔ THE TWO THIS FAMILY EXISTS TO REFUSE, and they are the same rule from two sides. A provider
       * that would not answer is not a finding about the work: it is CANNOT_DETERMINE at exit 2, never
       * FAIL at exit 1 (anti-drift item 2). Both halves are pinned by enum rather than by review, so a
       * writer that wanted to record a failed offload as a failed TASK would have to change this schema
       * to do it.
       */
      'fail-outcome': (d) => { d.outcome = 'FAIL'; return d; },
      'failure-exit-code': (d) => { d.exitCode = 1; return d; },
      // A digest that is not a sha256 is a digest nobody can check the input against.
      'malformed-digest': (d) => { d.input.digest = 'not-a-digest'; return d; },
      // A negative usage count. Null means "the host published nothing"; a number means it published one.
      'negative-usage': (d) => { d.usage = { input: -1, output: 0 }; return d; },
    },
  },
  'precompact-handoff': {
    valid: { schemaVersion: '1.0.0', kind: 'precompact-handoff', sessionId: 's-1', trigger: 'auto', writtenAt: ISO, head: REV, uncommittedFiles: ['src/a.ts'], uncommittedTruncated: false, sessionDelta: { status: 'CHANGED', files: ['src/a.ts'], headMoved: false }, ledgerPresent: true, ledgerLastCommit: 'abc1234', ledgerBehindHead: false, atomicTask: { task: 'finish the CSV writer' }, contract: 'goal', readBackVerified: true },
    negatives: {
      'missing-required': (d) => { delete d.readBackVerified; return d; },
      'wrong-type': (d) => { d.uncommittedTruncated = 'no'; return d; },
      'unknown-schema-version': (d) => { d.schemaVersion = '9.9.9'; return d; },
      'malformed-nested': (d) => { d.sessionDelta.status = 'MAYBE'; return d; },
      'wrong-kind': (d) => { d.kind = 'handoff'; return d; },
    },
  },
  'atomic-task': {
    valid: { task: 'finish the CSV writer', evidence: ['EVIDENCE/csv.json'] },
    negatives: {
      'wrong-type': () => ['not', 'an', 'object'],
      'wrong-type-string': () => 'a bare string',
      'wrong-type-number': () => 42,
      'wrong-type-null': () => null,
    },
    exempt: {
      'missing-required': 'This schema is deliberately open and declares no required property, because no reader in the tree names a field of this file — a fence verifies that claim. Requiring a field would invent a contract out of someone else\'s file.',
      'unknown-schema-version': 'Nothing anywhere reads a version from this file, so rejecting an unrecognised one would be a constraint with no consumer — and would break the hand-authored and /savepoint-authored notes this file exists to carry.',
      'malformed-nested': 'No nested structure is declared, because declaring one would require knowing what the note contains, and the whole point of this family is that the pack does NOT know and does not need to. If a reader ever names a field, the reader-coverage fence fails and this schema must grow.',
    },
  },
  'index-lease': {
    valid: { holderKey: 's-1/main', sessionId: 's-1', agentId: null, agentType: null, indexPath: 'c:/p/.git/index', acquiredAt: ISO, heartbeatAt: ISO, provisional: true },
    negatives: {
      'missing-required': (d) => { delete d.provisional; return d; },
      'wrong-type': (d) => { d.provisional = 'true'; return d; },
      'unknown-schema-version': (d) => { d.schemaVersion = '9.9.9'; return d; },
      'malformed-nested': (d) => { d.holderKey = 'no-slash'; return d; },
      'undeclared-field': (d) => { d.owner = 's-1'; return d; },
    },
  },
  'index-ownership': {
    valid: { '0123456789abcdef': { 'src/a.ts': 'M|100644|abc|src/a.ts|' } },
    negatives: {
      'wrong-type': () => ({ '0123456789abcdef': 'src/a.ts' }),
      'malformed-nested': () => ({ '0123456789abcdef': { 'src/a.ts': 'not-a-state-key' } }),
      'malformed-nested-key': () => ({ 'not-a-sha16': { 'src/a.ts': 'M|100644|abc|src/a.ts|' } }),
      'wrong-type-root': () => [],
      'missing-required': () => ({ '0123456789abcdef': { 'src/a.ts': 42 } }),
    },
    exempt: { 'unknown-schema-version': 'The root object is a map keyed by index-identity digest, so a `schemaVersion` key would have to be a 16-hex string to be accepted and is rejected as a malformed KEY rather than as a version — which is what the malformed-nested-key fixture covers.' },
  },
  'spawn-counter': {
    valid: { count: 3, updatedAt: ISO },
    negatives: {
      'missing-required': (d) => { delete d.count; return d; },
      'wrong-type': (d) => { d.count = '3'; return d; },
      'unknown-schema-version': (d) => { d.schemaVersion = '9.9.9'; return d; },
      'malformed-nested': (d) => { d.count = -1; return d; },
      'undeclared-field': (d) => { d.sessionId = 's-1'; return d; },
    },
  },
  'rollover-handoff': {
    valid: {
      schemaVersion: '2.0.0', kind: 'rollover-handoff', handoffId: HANDOFF_ID, writtenAt: ROLLOVER_ISO,
      identity: { host: 'claude-code', conversationId: 'sess-compact-1', conversationIdField: 'session_id' },
      contextCycleId: CYCLE_ID, atomicActionId: null, exactNextAction: 'finish the CSV writer',
      git: {
        head: 'a1b2c3d4e5f60718293a4b5c6d7e8f9021324354', uncommittedFiles: ['src/inflight.ts'],
        uncommittedTruncated: false,
        sessionDelta: { status: 'CHANGED', files: ['src/inflight.ts'], headMoved: false },
      },
      userConstraints: [], verificationEvidence: [], unresolvedQuestions: [], candidateMemories: [],
      migratedFrom: null, source: { kind: 'native', raw: { trigger: 'auto', sessionId: 'sess-compact-1' } },
    },
    negatives: {
      // ⛔ contextCycleId is what binds a handoff to the compaction it belongs to. A handoff that cannot
      // be matched to a cycle is exactly the v0.2 shape v0.3 exists to stop reading as current.
      'missing-required': (d) => { delete d.contextCycleId; return d; },
      'wrong-type': (d) => { d.userConstraints = 'no billing edits'; return d; },
      'unknown-schema-version': (d) => { d.schemaVersion = '9.9.9'; return d; },
      'malformed-nested': (d) => { d.identity.host = 'not-a-real-host'; return d; },
    },
  },
  'handoff-verification-receipt': {
    valid: {
      kind: 'handoff-verification', handoffId: HANDOFF_ID,
      handoffPath: `.respawnpack/runtime/rollover/claude-code-sess-compact-1/${HANDOFF_ID}.json`,
      writtenDigest: HANDOFF_DIGEST, readBackDigest: HANDOFF_DIGEST, equal: true,
      verifiedAt: '2026-08-06T12:00:00.100Z',
    },
    negatives: {
      'missing-required': (d) => { delete d.readBackDigest; return d; },
      'wrong-type': (d) => { d.equal = 'true'; return d; },
      /*
       * ⛔ `equal` IS A CONST TRUE, NOT A BOOLEAN. writeVerified() only ever writes this receipt on a
       * readback that MATCHED, so `equal: false` is not a failed verification on record — it is a
       * document that cannot exist. A reader accepting one would treat an unverified handoff as
       * verified, which is the single claim this whole family is here to make unspellable.
       */
      'wrong-const': (d) => { d.equal = false; d.readBackDigest = 'a'.repeat(64); return d; },
      'malformed-digest': (d) => { d.writtenDigest = 'not-a-hex-digest'; return d; },
    },
    exempt: {
      'unknown-schema-version': 'This is a receipt with a single-purpose lifetime bound to one handoffId, created once by writeVerified() and never migrated or rewritten — it carries no schemaVersion field for a future reader to check, so there is no version claim a fixture could break.',
      'malformed-nested': 'Every field is a flat scalar (four strings and one const boolean) with no nested object or array anywhere in the shape, so there is no nested structure for a fixture to malform.',
    },
  },
  'consumption-receipt': {
    valid: {
      kind: 'consumption-receipt', subjectId: HANDOFF_ID, consumerId: 'session-start:sess-compact-1',
      consumedAt: '2026-08-06T12:05:00.000Z',
      note: 'the rollover handoff was injected into the next context cycle',
      extra: { verifiedDigest: HANDOFF_DIGEST, contextCycleId: CYCLE_ID, exactNextAction: 'finish the CSV writer' },
    },
    // The generic primitive with no caller-specific payload at all — consumable.js's own shape, before
    // any family hands it an `extra` to store opaquely.
    extraValid: { name: 'valid-no-extra', doc: { kind: 'consumption-receipt', subjectId: `continue:${CYCLE_ID}`, consumerId: 'sdk-supervisor:1234:ab12cd34', consumedAt: '2026-08-06T12:05:00.000Z', note: null } },
    negatives: {
      // Without the consumer, an exactly-once receipt cannot say WHO consumed it — which is the only
      // question a second claimant asks.
      'missing-required': (d) => { delete d.consumerId; return d; },
      'wrong-type': (d) => { d.note = 42; return d; },
      'wrong-const': (d) => { d.kind = 'handoff-verification'; return d; },
      'malformed-nested': (d) => { d.extra = 'not an object or null'; return d; },
    },
    exempt: {
      'unknown-schema-version': 'This is core/lifecycle/consumable.js\'s generic exactly-once claim receipt, created once with O_EXCL and never rewritten — it carries no schemaVersion field for a future reader to check, so there is no version claim a fixture could break.',
    },
  },
  'threshold-latches': {
    valid: {
      kind: 'threshold-latches', cycleId: 'claude-code:sess-goal-1:0:aabbccddeeff',
      latched: { 60: { at: '2026-08-06T12:01:00.000Z', atPercent: 60 }, 75: { at: '2026-08-06T12:02:00.000Z', atPercent: 75 } },
    },
    // A cycle in which nothing has fired yet — the shape forCycle() re-arms TO, which must be as valid
    // as a populated one or every fresh cycle would look malformed.
    extraValid: { name: 'valid-empty', doc: { kind: 'threshold-latches', cycleId: 'claude-code:sess-fresh-1:0:112233445566', latched: {} } },
    negatives: {
      // ⛔ The cycle id is the ONLY thing that makes a latch record discardable. Without it, forCycle()
      // cannot tell "already fired this cycle" from "fired in a cycle that ended" — the exact v0.2
      // defect (a per-session latch that fired once and went silent forever) this family corrects.
      'missing-required': (d) => { delete d.cycleId; return d; },
      'wrong-type': (d) => { d.latched = ['60', '75']; return d; },
      'wrong-const': (d) => { d.kind = 'consumption-receipt'; return d; },
      'malformed-nested': (d) => { d.latched['60'].atPercent = 'sixty'; return d; },
    },
    exempt: {
      'unknown-schema-version': 'This file is REPLACED WHOLESALE the instant its own cycleId stops matching the machine\'s current one (core/policy/thresholds.js forCycle()) rather than migrated, so there is no schemaVersion field for a fixture to break — a stale format is discarded, not read.',
    },
  },
  'cycle-record': {
    valid: CYCLE_VALID,
    extraValid: { name: 'valid-advanced', doc: { host: 'claude-code', conversationId: 'sess-compact-1', index: 1, nonce: '112233445566', startedAt: '2026-08-06T12:10:00.000Z', provenance: 'advanced', cycleId: 'claude-code:sess-compact-1:1:112233445566' } },
    negatives: {
      'missing-required': (d) => { delete d.nonce; return d; },
      'wrong-type': (d) => { d.index = '0'; return d; },
      // The nonce is what stops a repeated session id from reading as the same cycle, so a nonce that
      // is not the declared 12 hex characters must not be accepted as one.
      'bad-nonce-pattern': (d) => { d.nonce = 'not-hex!!'; return d; },
      // 'restored' is the plausible value that is NOT in the enum: a cycle is minted, minted-after-repair
      // or advanced, and provenance is how a reader knows which — an invented one erases the distinction.
      'bad-provenance-enum': (d) => { d.provenance = 'restored'; return d; },
    },
    exempt: {
      'unknown-schema-version': 'This is the machine\'s own per-conversation identity record, re-minted with a fresh nonce on every advance and re-derived from the journal\'s fold on every restart (core/lifecycle/cycle.js) — it carries no schemaVersion field for a future reader to check.',
      'malformed-nested': 'Every field is a flat scalar (five strings, one non-negative integer, one enum) with no nested object or array anywhere in the shape, so there is no nested structure for a fixture to malform.',
    },
  },
  'rollover-journal': {
    validName: 'valid-row-transition',
    valid: {
      v: 1, seq: 4, at: '2026-08-06T12:00:01.000Z', cycleId: CYCLE_ID, kind: 'transition',
      transition: 'verify-handoff', transitionKey: `verify-handoff:verified:${HANDOFF_ID}`,
      eventKey: `evt:verify-handoff:verified:${HANDOFF_ID}`, eventId: `verified:${HANDOFF_ID}`,
      from: 'ROLLOVER_PENDING', to: 'HANDOFF_VERIFIED',
      evidence: [{ kind: 'handoff-readback', handoffId: HANDOFF_ID, equal: true }],
      verifiedHandoff: { handoffId: HANDOFF_ID, equal: true },
      result: { status: 'APPLIED', transition: 'verify-handoff', from: 'ROLLOVER_PENDING', to: 'HANDOFF_VERIFIED' },
    },
    extraValid: { name: 'valid-snapshot', doc: JOURNAL_SNAPSHOT },
    negatives: {
      'missing-required': (d) => { delete d.kind; return d; },
      'wrong-type': (d) => { d.seq = '4'; return d; },
      // `v` is JOURNAL_VERSION — a codec marker for the journal format itself, so an unrecognised one
      // is the one version claim this family CAN break (see the registry's note on its absent schemaVersion).
      'unknown-schema-version': (d) => { d.v = 999; return d; },
      // The snapshot is the other half of this family's union, and the embedded `cycle` identity record
      // is the only nested structure either half carries — so the nested failure exists only on that side.
      'malformed-nested': { from: 'valid-snapshot', mutate: (d) => { d.cycle = 'not an object'; return d; } },
    },
  },
  'push-authorization': {
    valid: { at: 1754265600000, firstAt: 1754265600000, cmd: 'git push origin main', session: 's-1' },
    negatives: {
      'missing-required': (d) => { delete d.session; return d; },
      'wrong-type': (d) => { d.at = '1754265600000'; return d; },
      'unknown-schema-version': (d) => { d.schemaVersion = '9.9.9'; return d; },
      'malformed-nested': (d) => { d.retries = 0; return d; },
      'undeclared-field': (d) => { d.approvedBy = 'someone'; return d; },
    },
  },
  /*
   * gate-verdict — one `result()` row per planned check (K-09), so the seed carries the seven shared
   * contract fields as well as the gate's own planning facts. `outcome` is the pack's four-value
   * vocabulary and `label` is the gate's richer word for the same verdict; the seed pairs them the way
   * a real run does, so a negative that separates them is separating something the writer never does.
   */
  'gate-verdict': {
    valid: {
      outcome: 'PASS', label: 'PASS', why: '2 check(s) passed',
      profiles: [{ id: 'node', root: '.', evidence: 'package.json' }],
      checks: [{
        outcome: 'PASS', check: 'gate:.:lint', detail: 'exit 0', checked: 1, domain: 'gate',
        subject: 'npm run lint', label: 'PASS',
        name: 'lint', profile: 'node', root: '.', configured: true, bin: 'npm', args: ['run', 'lint'],
        exitCode: 0, output: '',
      }],
      ran: 1, exitCode: 0,
    },
    negatives: {
      // `ran` is the field that makes a vacuous green unspellable, so its absence must be refused.
      'missing-required': (d) => { delete d.ran; return d; },
      // A count that arrives as a string compares as truthy and sorts as text — the shape a reader
      // would still print as "ran 1" while nothing could arithmetic on it.
      'wrong-type': (d) => { d.ran = '1'; return d; },
      // A CI artifact declares no schemaVersion (registry.json says so); one that turns up carrying an
      // unimplemented version is a document from a writer this reader has never met.
      'unknown-schema-version': (d) => { d.schemaVersion = '9.9.9'; return d; },
      // ⛔ THE ROW VOCABULARY, WHICH IS WHERE A SKIP WOULD RE-ENTER. `SKIPPED` is precisely the word
      // the four YAML steps used, and precisely the one the row vocabulary must not accept: a skipped
      // check is NOT_CONFIGURED or COULD_NOT_RUN, and both are CANNOT_DETERMINE, never green.
      'malformed-nested': (d) => { d.checks[0].label = 'SKIPPED'; return d; },
      // A verdict outcome outside the four. GREEN is the invented word this whole family exists over.
      'invented-outcome': (d) => { d.outcome = 'GREEN'; return d; },
      // Three exit codes, and only three. A fourth would be a meaning nobody declared.
      'impossible-exit-code': (d) => { d.exitCode = 3; return d; },
    },
  },
  'candidate-memory': {
    // This family is a UNION of two documents that live in different files: the candidate RECORD
    // (memory/candidates/<id>.json) and one row of the append-only capture/promote/reject AUDIT
    // (memory/candidates/audit.jsonl). Both are seeded, because a schema that only ever sees the
    // record half would accept an audit row that no writer produces.
    validName: 'valid-record',
    valid: {
      schemaVersion: '2.0.0', kind: 'candidate-memory', id: 'cm_a1b2c3d4e5f6a7b8',
      claim: 'state-writeback: STATE.json was written but reads back different content than what was written',
      klass: 'finding',
      provenance: {
        by: 'savepoint', at: ROLLOVER_ISO, cycleId: MEMORY_CYCLE,
        conversationId: null, host: null, sourceKind: 'savepoint', evidencePaths: ['docs/derived/STATE.json'],
      },
      verificationState: 'candidate', verification: null, rejection: null, supersededBy: null,
    },
    extraValid: [
      { name: 'valid-record-promoted', doc: CANDIDATE_PROMOTED },
      { name: 'valid-auditrow', doc: { at: ROLLOVER_ISO, action: 'capture', id: 'cm_a1b2c3d4e5f6a7b8', klass: 'finding', cycleId: MEMORY_CYCLE, by: 'savepoint' } },
    ],
    negatives: {
      // ⛔ Provenance is the whole point of a candidate: an unattributed claim promoted into the memory
      // graph is indistinguishable from one the pack invented about itself.
      'missing-required': (d) => { delete d.provenance; return d; },
      'wrong-type': (d) => { d.id = 42; return d; },
      'unknown-schema-version': (d) => { d.schemaVersion = '9.9.9'; return d; },
      // Only the PROMOTED seed can express this one: a candidate carries `verification: null`, so the
      // shape promotion must refuse — verified, with nothing recorded to have verified it — exists on
      // the promoted side alone.
      'malformed-nested': {
        from: 'valid-record-promoted',
        mutate: (d) => {
          d.verification.evidencePaths = [];
          d.verification.note = 'promoted with no evidence path recorded — the exact shape promotion must refuse';
          return d;
        },
      },
    },
  },
  /*
   * pairs-registry — docs/derived/state/pairs.json, HAND-AUTHORED (writer:null, same as removals-registry
   * and reconciliation-source), so this seed is a clean fixture rather than a copy of the pack's real
   * rows: it exists to prove the SCHEMA discriminates, not to double as documentation of the real register.
   */
  'pairs-registry': {
    valid: {
      schemaVersion: '1.0.0',
      reason: 'fixture register — mirrors the real shape for schema testing only',
      shapes: {
        A: 'set-diff completeness over an enumerable-now set',
        D: 'n-way semantic agreement checked by a shared test vector',
      },
      pairs: [
        {
          id: 'P-001',
          sideA: 'widget.config.json ALLOWED_KEYS',
          sideB: 'widget.js the keys its loader actually reads',
          invariant: 'every key the loader reads must be declared, or an unrecognised key is silently ignored',
          shape: 'A',
          exposure: 'a typo in a config key is accepted and never applied, with no error anywhere',
          enforcedBy: null,
          why: 'nothing derives ALLOWED_KEYS from the loader\'s own reads, so a key added to the loader has no fence proving the config schema was updated to match it',
        },
        {
          id: 'P-002',
          sideA: 'widget.js OUTCOME enum',
          sideB: 'widget.schema.json outcome enum',
          invariant: 'the runtime vocabulary and its schema must name the same outcomes',
          shape: 'D',
          exposure: 'a renamed outcome validates against a schema that no longer describes what the code emits',
          enforcedBy: 'widget.test.mjs:the runtime and schema outcome vocabularies agree',
        },
      ],
    },
    negatives: {
      'missing-required': (d) => { delete d.pairs[0].invariant; return d; },
      'wrong-type': (d) => { d.pairs = {}; return d; },
      'unknown-schema-version': (d) => { d.schemaVersion = '9.9.9'; return d; },
      'malformed-nested': (d) => { d.pairs[0].enforcedBy = 42; return d; },
      // ⛔ The declared-opt-out doctrine itself: enforcedBy:null with no `why` is the one shape the
      // allOf/anyOf fence exists to refuse — the same rule state.removals and state.reconcile already
      // enforce in schemas/project-config.schema.json, checked here rather than only in prose.
      'unjustified-gap': (d) => { delete d.pairs[0].why; return d; },
    },
  },
  /*
   * capability-register — spine/reference/models/capability-register.json, HAND-AUTHORED (writer:null,
   * the class of pairs-registry). This seed is a CLEAN FIXTURE with invented models on a reserved
   * domain, not a copy of the real register: it exists to prove the schema discriminates, and a fixture
   * that doubled as documentation of the real file would go stale against it every time a vendor ships.
   * The real document is validated separately, against the same schema, in kernel/schema.test.mjs.
   *
   * ⛔ THE TWO NEGATIVES THIS FAMILY EXISTS FOR are `rating-without-evidence` and `unknown-rating-word`.
   * Both are the same failure from different sides: a claim about a model that no source supports. The
   * schema's oneOf makes each unspellable, and these fixtures are what keep that true.
   */
  'capability-register': {
    valid: {
      schemaVersion: '1.0.0',
      asOf: '2026-01-02',
      reVerifyAfter: '2026-02-02',
      evidenceBase: 'capability-evidence.md',
      why: ['A fixture register: the shape only, so the schema can be shown to accept a good document and refuse each bad one.'],
      taskClasses: ['coding', 'review', 'security-testing', 'long-context', 'planning', 'writing', 'research', 'extraction'],
      families: [
        {
          id: 'anthropic',
          name: 'Example host-session family',
          access: {
            how: 'a signed-in host CLI this fixture never runs',
            credential: 'host-session',
            note: 'no credential value appears in this fixture, and the schema declares no property one could be written into',
          },
          promptingPractice: 'docs/reference/models/prompting-anthropic.md',
          notes: [],
        },
        {
          id: 'minimax',
          name: 'Example environment-variable family',
          access: {
            how: 'an OpenAI-compatible endpoint reached over HTTP',
            credential: 'environment-variable',
            envVar: 'EXAMPLE_PROVIDER_ENV_NAME',
            note: 'the variable NAME only; the negative fixture below proves the pattern refuses anything shaped like a pasted value',
          },
          promptingPractice: 'docs/reference/models/prompting-minimax.md',
          notes: [],
        },
      ],
      models: [
        {
          id: 'example-model-1',
          family: 'anthropic',
          name: 'Example Model 1',
          status: 'current',
          contextWindow: 200000,
          maxOutput: 64000,
          vendorPositioning: {
            text: 'A fixture model, not a real one.',
            form: 'quote',
            evidence: [{ url: 'https://example.invalid/docs/example-model-1', kind: 'vendor', accessedAt: '2026-01-02', publishedAt: null, claim: 'the fixture maker\'s own page describes this fixture model' }],
          },
          ratings: {
            coding: {
              rating: 'preferred',
              evidence: [{ url: 'https://example.invalid/docs/example-model-1', kind: 'vendor', accessedAt: '2026-01-02', publishedAt: '2026-01', claim: 'the fixture maker names coding for this model' }],
              why: 'a rated class, with the caveat its sources carry',
            },
            review: {
              rating: 'capable',
              evidence: [{ url: 'https://example.invalid/evals/review', kind: 'third-party', accessedAt: '2026-01-02', publishedAt: '2026-01-02', claim: 'a named fixture evaluation places this model in the class' }],
            },
            'security-testing': { rating: 'unproven', evidence: [], why: 'no source of any kind names this fixture model for security work' },
            'long-context': { rating: 'unproven', evidence: [], why: 'the window is documented and no quality measurement of it exists' },
            planning: { rating: 'unproven', evidence: [], why: 'no orchestration source names this fixture model' },
            writing: { rating: 'unproven', evidence: [], why: 'no writing source names this fixture model' },
            research: { rating: 'unproven', evidence: [], why: 'no research source names this fixture model' },
            extraction: { rating: 'unproven', evidence: [], why: 'no extraction source names this fixture model' },
          },
          notes: ['a note carries a caveat that is not a rating'],
          asOf: '2026-01-02',
          probes: [],
        },
        {
          id: 'example-model-2',
          family: 'minimax',
          name: 'Example Model 2',
          status: 'restricted',
          contextWindow: null,
          maxOutput: null,
          vendorPositioning: {
            text: 'A gated fixture model whose specification the fixture maker does not publish.',
            form: 'paraphrase',
            evidence: [{ url: 'https://example.invalid/docs/example-model-2', kind: 'vendor', accessedAt: '2026-01-02', publishedAt: null, claim: 'the page describes access terms and carries no context-window figure' }],
          },
          ratings: {
            coding: { rating: 'unproven', evidence: [], why: 'restricted access, so there is no rating a general owner could act on' },
            review: { rating: 'unproven', evidence: [], why: 'restricted access, as above' },
            'security-testing': { rating: 'unproven', evidence: [], why: 'restricted access, as above' },
            'long-context': { rating: 'unproven', evidence: [], why: 'restricted access, and no window is published' },
            planning: { rating: 'unproven', evidence: [], why: 'restricted access, as above' },
            writing: { rating: 'unproven', evidence: [], why: 'restricted access, as above' },
            research: { rating: 'unproven', evidence: [], why: 'restricted access, as above' },
            extraction: { rating: 'unproven', evidence: [], why: 'restricted access, as above' },
          },
          notes: [],
          asOf: '2026-01-02',
          probes: [{ at: '2026-01-02', taskClass: 'coding', outcome: 'CANNOT_DETERMINE', note: 'the fixture runs no probe; this row exists so the probe shape is validated by the valid fixture rather than only declared' }],
        },
      ],
    },
    negatives: {
      'missing-required': (d) => { delete d.models[0].asOf; return d; },
      'wrong-type': (d) => { d.models[0].contextWindow = '200000'; return d; },
      'unknown-schema-version': (d) => { d.schemaVersion = '9.9.9'; return d; },
      'malformed-nested': (d) => { d.models[0].vendorPositioning.form = 'summary'; return d; },
      // ⛔ A `preferred` rating with nothing behind it. The whole register exists to make this shape
      // impossible; if this fixture ever validates, every rating in the real file means nothing.
      'rating-without-evidence': (d) => { d.models[0].ratings.coding.evidence = []; return d; },
      // The other side of the same failure: a word outside the vocabulary cannot borrow the evidence
      // rule of the word it resembles.
      'unknown-rating-word': (d) => { d.models[0].ratings.review.rating = 'best'; return d; },
      'unknown-task-class': (d) => { d.models[0].ratings.pentesting = d.models[0].ratings.review; return d; },
      'malformed-date': (d) => { d.models[0].ratings.coding.evidence[0].accessedAt = '03-09-2026'; return d; },
      'extra-property': (d) => { d.models[0].vendor = 'anthropic'; return d; },
      // ⛔ ANTI-DRIFT ITEM 52, EXPRESSED AS A SHAPE. `envVar` holds a variable NAME; a pasted value does
      // not match a SHOUTING_SNAKE identifier, so the field cannot quietly become the place a key lives.
      'credential-shaped-env-var': (d) => { d.families[1].access.envVar = 'the value someone pasted here'; return d; },
    },
  },
};

/*
 * --- the fence, and it runs BEFORE the clear on purpose ---
 *
 * The clear below is the destructive step, and its safety rests entirely on FAMILIES covering the
 * registry. Checking that afterwards would report the drift from inside the wreckage it caused; the
 * one ordering that helps is refusing to start. registry.json is the denominator in both directions,
 * so this is a bijection test, not a subset test — the missing-family direction is the one that
 * deleted tracked fixtures, and the extra-family direction is the one that writes bytes nothing reads.
 */
const REGISTRY = JSON.parse(fs.readFileSync(path.join(ROOT, 'schemas', 'registry.json'), 'utf8'));
const declared = REGISTRY.families.map((f) => f.family);
const generated = Object.keys(FAMILIES);
const problems = [];

for (const f of declared) {
  if (!generated.includes(f)) problems.push(`"${f}" is a registered family with no entry in FAMILIES — regenerating would DELETE its fixtures, and the fences in kernel/schema.test.mjs require them`);
}
for (const f of generated) {
  if (!declared.includes(f)) problems.push(`FAMILIES generates "${f}", which schemas/registry.json does not declare — a fixture nobody registered is validated by nothing`);
}
if (problems.length) {
  console.error('schemas/fixtures.gen.mjs refused to run — FAMILIES and schemas/registry.json do not describe the same set:');
  for (const p of problems) console.error(`  ⛔ ${p}`);
  process.exit(1);
}

fs.rmSync(OUT, { recursive: true, force: true });
let files = 0;
for (const [family, spec] of Object.entries(FAMILIES)) {
  const dir = path.join(OUT, family);
  fs.mkdirSync(dir, { recursive: true });
  const w = (name, doc) => { fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(doc, null, 2) + '\n'); files += 1; };

  // A family may seed more than one valid shape, and name its primary something other than `valid` —
  // candidate-memory's record/audit-row and the journal's row/snapshot are UNIONS, where "the" valid
  // document does not exist.
  const extras = spec.extraValid ? [].concat(spec.extraValid) : [];
  const primary = spec.validName || 'valid';
  const seeds = new Map([[primary, spec.valid], ...extras.map((e) => [e.name, e.doc])]);
  w(primary, spec.valid);
  for (const e of extras) w(e.name, e.doc);

  for (const [kind, neg] of Object.entries(spec.negatives)) {
    // A negative mutates the primary seed unless it names another with `from` — a union's nested
    // failure usually only exists on ONE side of it, and deriving it from the wrong side would produce
    // a fixture that is invalid for a reason nobody chose.
    const mutate = typeof neg === 'function' ? neg : neg.mutate;
    const seed = typeof neg === 'function' ? spec.valid : seeds.get(neg.from);
    if (!seed) throw new Error(`${family}/invalid-${kind} names seed "${neg.from}", which this family does not declare`);
    w(`invalid-${kind}`, mutate(clone(seed)));
  }
}
// The declared exemptions travel with the fixtures, so the fence can read them.
fs.writeFileSync(path.join(OUT, 'exemptions.json'), JSON.stringify(
  Object.fromEntries(Object.entries(FAMILIES).filter(([, s]) => s.exempt).map(([f, s]) => [f, s.exempt])), null, 2) + '\n');
console.log(`wrote ${files} fixtures across ${Object.keys(FAMILIES).length} families`);
