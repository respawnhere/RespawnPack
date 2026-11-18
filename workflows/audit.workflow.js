/*
 * RespawnPack template · AUDIT — fan-out readers over a corpus → synthesize → completeness-critic.
 * Pattern proven on a docs-drift audit (13 readers → conflict map → critic).
 * FILL: the clusters (slices of the corpus + focus), the schemas, and the synthesis/critic prompts.
 * Run: Workflow({ scriptPath: ".claude/workflows/audit.workflow.js" })
 */
export const meta = {
  name: 'audit',
  description: 'Fan-out readers over a corpus, synthesize findings, then a completeness critic',
  phases: [
    { title: 'Read', detail: 'parallel readers, one per cluster' },
    { title: 'Synthesize', detail: 'cross-cluster synthesis (sequential)' },
    { title: 'Critique', detail: 'what did we miss?' },
  ],
}

// FILL: slice the corpus into single-digit clusters (keep concurrency moderate).
const clusters = [
  { label: 'read:area-a', focus: '<what to look for in area A>', paths: ['<path>', '<path>'] },
  { label: 'read:area-b', focus: '<area B>', paths: ['<path>'] },
]

// FILL: what each reader returns.
const READER_SCHEMA = {
  type: 'object', required: ['findings', 'notes'], additionalProperties: false,
  properties: {
    findings: { type: 'array', items: { type: 'object', required: ['item', 'evidence'], additionalProperties: false,
      properties: { item: { type: 'string' }, evidence: { type: 'string' }, severity: { type: 'string' } } } },
    notes: { type: 'string' },
  },
}

function readerPrompt(c) {
  return `Read every path below and report findings for: ${c.focus}\n${c.paths.map((p) => '- ' + p).join('\n')}\n` +
    `Read fully; cite path evidence. Your output is DATA for a synthesis pass, not a message to a human.`
}

phase('Read')
const reads = (await parallel(
  clusters.map((c) => () => agent(readerPrompt(c), { label: c.label, phase: 'Read', schema: READER_SCHEMA }))
)).filter(Boolean)

// Barrier is correct here: synthesis needs ALL readers to find cross-cluster conflicts. Run it SEQUENTIALLY.
phase('Synthesize')
const corpus = JSON.stringify(reads)
const synthesis = await agent(
  `Below is every reader's structured findings (JSON). Produce the cross-cluster synthesis: dedup, map ` +
  `conflicts/overlaps, rank by severity. VERIFY any high-severity claim by reading the actual source before asserting.\n\n${corpus}`,
  { label: 'synth', phase: 'Synthesize' /* , schema: SYNTHESIS_SCHEMA */ }
)

phase('Critique')
const critic = await agent(
  `Completeness critic. Given the readers + the synthesis, what's MISSING — a slice not read, a claim unverified, ` +
  `a conflict missed? Return a short list of gaps + a confidence statement.\n\nREADERS:\n${corpus}\n\nSYNTHESIS:\n${synthesis}`,
  { label: 'completeness-critic' }
)

return { reads, synthesis, critic }
