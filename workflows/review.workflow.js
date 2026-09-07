/*
 * RespawnPack template · REVIEW — per-dimension review, each finding adversarially verified (pipelined).
 * Each dimension verifies its findings as soon as its review completes — no wasted wall-clock barrier.
 * Backs the /review skill. FILL: the dimensions (+ prompts) and the diff/target you pass in.
 * Run: Workflow({ scriptPath: ".claude/workflows/review.workflow.js", args: { diffRef: "main..HEAD" } })
 */
export const meta = {
  name: 'review',
  description: 'Review a change across dimensions, adversarially verify each finding, return only confirmed issues',
  phases: [{ title: 'Review' }, { title: 'Verify' }],
}

const diffRef = (args && args.diffRef) || 'HEAD~1..HEAD' // FILL via args

// FILL: the review lenses. Source of truth for this list is the agents/*-reviewer.md files
// (mirrored in skills/review/SKILL.md Step 2) — keep them in sync.
//
// ⛔ THEY WERE NOT IN SYNC. The catalog advertised six lenses and this list shipped five: `design` was
// missing, so every workflow-driven review silently skipped the design pass while reporting a complete
// run. The comment above already said to keep them in sync — which is why the counts fence now asserts
// it mechanically (counts-fence.test.mjs), instead of relying on a reader honoring a comment.
const DIMENSIONS = [
  { key: 'correctness', prompt: `Review the diff (${diffRef}) for logic errors, edge cases, error propagation, intent-vs-impl.` },
  { key: 'security', prompt: `Review the diff (${diffRef}) for input validation, authz, secrets, injection. Weight risky paths.` },
  { key: 'performance', prompt: `Review the diff (${diffRef}) for N+1 queries, unbounded/unpaginated reads, missing pagination, and heavy work on the request path, per docs/reference/performance-standards.md.` },
  { key: 'maintainability', prompt: `Review the diff (${diffRef}) for complexity, coupling, naming, dead code, and comment quality, per docs/reference/coding-standards.md.` },
  { key: 'spine', prompt: `Review the diff (${diffRef}) for spine drift: does it match docs/PRODUCT.md + docs/FEATURES-PAGES.md, resurrect a DECISIONS.md killed feature, hardcode a value that contradicts code-truth, or add a route with no matrix row?` },
  { key: 'design', prompt: `Review the diff (${diffRef}) against docs/reference/design-standards.md — load only the §-file(s) the diff touches. Interaction craft, visual system, psychology of use, accessibility (name the WCAG SC), and validation. Skip cleanly if the diff has no user-facing surface.` },
]

const FINDINGS = {
  type: 'object', required: ['findings'], additionalProperties: false,
  properties: { findings: { type: 'array', items: {
    type: 'object', required: ['title', 'file', 'detail'], additionalProperties: false,
    properties: { title: { type: 'string' }, file: { type: 'string' }, detail: { type: 'string' }, severity: { type: 'string' } } } } },
}
const VERDICT = {
  type: 'object', required: ['isReal', 'why'], additionalProperties: false,
  properties: { isReal: { type: 'boolean' }, why: { type: 'string' } },
}

const results = await pipeline(
  DIMENSIONS,
  (d) => agent(d.prompt, { label: `review:${d.key}`, phase: 'Review', schema: FINDINGS }),
  (review, d) => parallel((review.findings || []).map((f) => () =>
    agent(`Adversarially verify this ${d.key} finding — try to REFUTE it; default isReal=false unless the evidence holds:\n${JSON.stringify(f)}`,
      { label: `verify:${f.file}`, phase: 'Verify', schema: VERDICT })
      .then((v) => ({ ...f, dimension: d.key, verdict: v }))))
)

const confirmed = results.flat().filter(Boolean).filter((f) => f.verdict && f.verdict.isReal)
return { confirmed, reviewed: DIMENSIONS.map((d) => d.key) }
