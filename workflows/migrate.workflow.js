/*
 * RespawnPack template · MIGRATE — discover call-sites → transform each (worktree-isolated) → verify.
 * Use for a mechanical sweep across many sites (rename an API, swap a pattern, codemod).
 * isolation:'worktree' keeps parallel edits from colliding — only because this template MUTATES files.
 * FILL: the discovery (the pattern) + the transform + verify prompts. Run: Workflow({ scriptPath, args: { pattern: "..." } })
 */
export const meta = {
  name: 'migrate',
  description: 'Discover sites of a pattern, transform each in isolation, verify each',
  phases: [{ title: 'Discover' }, { title: 'Transform' }, { title: 'Verify' }],
}

const pattern = (args && args.pattern) || '<FILL: the thing to migrate>'

const SITES = {
  type: 'object', required: ['items'], additionalProperties: false,
  properties: { items: { type: 'array', items: {
    type: 'object', required: ['path', 'note'], additionalProperties: false,
    properties: { path: { type: 'string' }, note: { type: 'string' } } } } },
}
const RESULT = {
  type: 'object', required: ['changed', 'summary'], additionalProperties: false,
  properties: { changed: { type: 'boolean' }, summary: { type: 'string' } },
}
const VERDICT = {
  type: 'object', required: ['ok', 'why'], additionalProperties: false,
  properties: { ok: { type: 'boolean' }, why: { type: 'string' } },
}

// Discover inline (one agent) — or do a cheap grep yourself and pass the list via args to skip this.
phase('Discover')
const sites = await agent(
  `Find every site that needs this migration: ${pattern}. Return each as {path, note}. Be exhaustive; don't transform anything yet.`,
  { label: 'discover', phase: 'Discover', schema: SITES }
)

// Pipeline: each site transforms then verifies independently. Worktree isolation because we edit files in parallel.
phase('Transform')
const done = await pipeline(
  (sites.items || []),
  (site) => agent(`Apply the migration "${pattern}" at ${site.path} (${site.note}). Make only this change; keep it minimal.`,
    { label: `migrate:${site.path}`, phase: 'Transform', isolation: 'worktree', schema: RESULT }),
  (res, site) => agent(`Verify the migration at ${site.path}: correct, complete, nothing else broken? Try to refute "done".`,
    { label: `verify:${site.path}`, phase: 'Verify', schema: VERDICT })
    .then((v) => ({ path: site.path, ...res, verdict: v }))
)

const ok = done.filter(Boolean)
return { transformed: ok.filter((r) => r.verdict && r.verdict.ok), needsAttention: ok.filter((r) => !(r.verdict && r.verdict.ok)) }
