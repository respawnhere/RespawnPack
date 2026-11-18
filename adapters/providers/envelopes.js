/*
 * RespawnPack · adapters/providers/envelopes.js — the per-family prompt envelope table.
 *
 * Spec: the class audit Class G, "Per-family prompting practice" ("the offload composer applies the
 * family's envelope from a table in code and a golden-file test per family").
 *
 * ⛔ THE TABLE IS THE PRODUCT, NOT A STYLE PREFERENCE. spine/reference/models/prompting-*.md are four
 * short standards distilled from vendor guidance with a citation per practice. A composer that ignored
 * them would send one shape to three families whose own makers document three different ones: Anthropic
 * asks for XML tags, long input first and the question last; OpenAI asks for lean developer-role
 * markdown with contradictions removed; MiniMax asks for bold labels, an explicit output contract and
 * permission to refuse. This file is where that guidance becomes bytes, and adapters/providers/fixtures/
 * holds one golden file per family so a change to any envelope is a visible diff rather than a silent
 * change in what every offload since has actually asked for.
 *
 * ⛔ THE GENERAL ENVELOPE IS THE FALLBACK AND SAYS SO, IN THE PROMPT ITSELF. A family this table does
 * not profile gets `general`, whose own text tells the model it is being addressed through a shared
 * envelope rather than one written for it. That sentence is not decoration: it is the difference between
 * "we applied the practice for this family" and "we applied the practice that all three agree on", and a
 * reader of the receipt can tell which happened because `fallback` records it and the composed prompt
 * shows it.
 *
 * ⛔ NOTHING HERE READS A FILE, A CLOCK OR AN ENVIRONMENT. There is no `require` in this module. Every
 * fact it acts on arrives as an argument, which is what lets the golden files be byte-comparable: a
 * composer that stamped a date or read a config would produce a different prompt on every run and the
 * golden test would have to be loosened until it proved nothing.
 */

'use strict';

/** The family the table falls back to. Named once, so the string is never spelled twice. */
const GENERAL = 'general';

/** The families this table profiles. `general` is not one of them; it is what happens without one. */
const PROFILED = ['anthropic', 'openai', 'minimax'];

/*
 * One line per task class, in core/policy/routing.js's TASK_CLASSES order. This is the WHOLE of what
 * the envelope knows about the work: the offload carries a bounded unit whose real instruction is in
 * the input file, and a composer that invented more than a framing sentence would be writing the
 * operator's prompt for them.
 */
const CLASS_BRIEF = {
  coding: 'Write or change code, and say what you changed and why.',
  review: 'Review the material and report what is wrong with it, most serious first.',
  'security-testing': 'Report security weaknesses in the material, each with the condition that makes it exploitable.',
  'long-context': 'Read the whole of the material before answering, and answer from all of it rather than from its opening.',
  planning: 'Produce an ordered plan whose steps a different reader could carry out without asking you a question.',
  writing: 'Write the prose the material asks for, in the register the material is already written in.',
  research: 'Answer the question from the material, and name what the material does not settle.',
  extraction: 'Extract exactly the fields the material asks for, and leave a field absent rather than guessing it.',
};

/*
 * The shared floor, applied by every envelope in the family's own idiom. These four sentences are the
 * practices spine/reference/models/prompting-general.md records as held by at least two makers and
 * contradicted by none: state the task and the output contract, answer from the supplied material,
 * refuse rather than invent, and stop when the request is answered.
 */
const FLOOR = [
  // Position-neutral on purpose: two of the four envelopes put the material FIRST, so a rule that said
  // "below" would be false in half the table and read as a mistake in the prompt the model receives.
  'Answer only from the material supplied with this request.',
  'Say plainly when the material does not settle the question, rather than filling the gap.',
  'Stop when the request is answered. Do not add a summary of what you just wrote.',
];

const ENVELOPES = {
  /*
   * prompting-anthropic.md §2 (structure with XML tags), §3 (long input first, question last, ask for
   * quotes) and §1 (be explicit, and say why). The input comes FIRST and the task LAST, which is the
   * ordering that file records as measurably better on long inputs.
   */
  anthropic: {
    id: 'anthropic',
    fallback: false,
    practice: 'docs/reference/models/prompting-anthropic.md',
    why: 'the Anthropic envelope: XML-tagged sections, the long input first and the question last, and a request for the quotes the answer rests on',
    system: 'You are answering one bounded request handed to you by RespawnPack. It is a single turn with no tools and no follow-up, so answer the request as it stands.',
    render({ taskClass, brief, input }) {
      return [
        '<material>',
        input,
        '</material>',
        '',
        '<task>',
        `Task class: ${taskClass}.`,
        brief,
        '</task>',
        '',
        '<instructions>',
        ...FLOOR.map((f) => `- ${f}`),
        '- Quote the lines from <material> that your answer rests on, so a reader can check it against the source.',
        '</instructions>',
      ].join('\n');
    },
  },

  /*
   * prompting-openai.md §4 (the developer role, organised by headers), §2 (prefer leaner prompts) and
   * §3 (remove contradictions before adding instructions). Markdown headers rather than tags, and the
   * shortest framing of the three, because that file's own advice is to remove one thing at a time
   * rather than to add.
   */
  openai: {
    id: 'openai',
    fallback: false,
    practice: 'docs/reference/models/prompting-openai.md',
    why: 'the OpenAI envelope: lean developer-role markdown organised by headers, with no instruction repeated in two places',
    system: 'You are answering one bounded request handed to you by RespawnPack. One turn, no tools, no follow-up.',
    render({ taskClass, brief, input }) {
      return [
        `# Task (${taskClass})`,
        brief,
        '',
        '# Rules',
        ...FLOOR.map((f) => `- ${f}`),
        '',
        '# Material',
        input,
      ].join('\n');
    },
  },

  /*
   * prompting-minimax.md §1 (make the task, the constraints and the output contract explicit), §2
   * (label sections with bold headers or trailing colons), §4 (for long context, put the task at the
   * end and index the sources) and §7 (permission to refuse, and a citation requirement).
   */
  minimax: {
    id: 'minimax',
    fallback: false,
    practice: 'docs/reference/models/prompting-minimax.md',
    why: 'the MiniMax envelope: bold labels, an explicit output contract, and explicit permission to refuse rather than invent',
    system: 'You are answering one bounded request handed to you by RespawnPack. This is a single turn. You have no tools and there will be no follow-up question.',
    render({ taskClass, brief, input }) {
      return [
        '**Material:**',
        input,
        '',
        `**Task:** ${taskClass}.`,
        brief,
        '',
        '**Constraints:**',
        ...FLOOR.map((f) => `- ${f}`),
        '- You may refuse. A refusal that names what is missing is a better answer than a plausible invention.',
        '',
        '**Output:** the answer itself, with the part of the material each claim rests on named beside it.',
      ].join('\n');
    },
  },

  /*
   * The fallback. Its first line says so, on purpose: a reader of the composed prompt can see that no
   * family-specific practice was applied, without having to consult the receipt to find out.
   */
  [GENERAL]: {
    id: GENERAL,
    fallback: true,
    practice: 'docs/reference/models/prompting-general.md',
    why: 'the general envelope, which is the fallback: it carries only the practices at least two makers state and none contradicts, because no family-specific practice applies here',
    system: 'You are answering one bounded request handed to you by RespawnPack. One turn, no tools, no follow-up.',
    render({ taskClass, brief, input }) {
      return [
        'This request is composed with the general prompting envelope, which is the fallback: no practice',
        'specific to your model family was applied, so nothing below is tuned to your maker\'s guidance.',
        '',
        `Task class: ${taskClass}.`,
        brief,
        '',
        'Rules:',
        ...FLOOR.map((f) => `- ${f}`),
        '',
        'Material:',
        input,
      ].join('\n');
    },
  },
};

/**
 * The envelope for one family, and the general fallback for anything this table does not profile.
 * A null or unknown family is not an error: the register may name a family whose practice nobody has
 * written yet, and answering that with the shared floor is the honest thing to do.
 */
function envelopeFor(family) {
  const key = typeof family === 'string' && Object.prototype.hasOwnProperty.call(ENVELOPES, family) && family !== GENERAL
    ? family
    : GENERAL;
  return ENVELOPES[key];
}

/**
 * Compose one prompt.
 *
 * @param {{family:string|null, taskClass:string, input:string}} opts
 * @returns {{family:string|null, envelope:string, fallback:boolean, practice:string, why:string,
 *            system:string, prompt:string, text:string}}
 *
 * `text` is `system`, a blank line, then `prompt` — the single string the two CLI-shaped providers take.
 * The HTTP provider is handed `system` and `prompt` separately, because its protocol has a place for
 * each; both are composed from the same envelope, so the two providers cannot drift apart.
 */
function compose({ family = null, taskClass, input } = {}) {
  const brief = CLASS_BRIEF[taskClass];
  if (!brief) throw new Error(`adapters/providers/envelopes.js: unknown task class "${taskClass}" — the class vocabulary is core/policy/routing.js's TASK_CLASSES`);
  if (typeof input !== 'string') throw new Error('adapters/providers/envelopes.js: `input` must be a string');

  const env = envelopeFor(family);
  const prompt = env.render({ taskClass, brief, input });
  return {
    family: family || null,
    envelope: env.id,
    fallback: env.fallback,
    practice: env.practice,
    why: env.fallback && family
      ? `${env.why}; no envelope is written for the family "${family}"`
      : env.why,
    system: env.system,
    prompt,
    text: `${env.system}\n\n${prompt}`,
  };
}

module.exports = { GENERAL, PROFILED, CLASS_BRIEF, FLOOR, ENVELOPES, envelopeFor, compose };
