export interface V1DevelopmentDelta {
  comparison: string;
  overall?: number;
  areas: Record<string, number>;
}

export interface Candidate {
  branch: string;
  pr: number;
  flags: Record<string, string>;
  adapter?: 'conversation-reviewer' | 'structured-memory' | 'deliberation' | 'clarification';
  stackedOn?: number;
  optional?: true;
  v1?: V1DevelopmentDelta & { stackedComparison?: V1DevelopmentDelta };
}

const v1Baseline = 'v1 development baseline';

export const candidates: readonly Candidate[] = [
  {
    branch: 'feat/small-talk-manners',
    pr: 40,
    flags: { MOHASSAN_SMALL_TALK_MANNERS: '1' },
    v1: { comparison: v1Baseline, overall: 15, areas: { 'small-talk': 15 } },
  },
  {
    branch: 'feat/conversation-reviewer',
    pr: 28,
    flags: { MOHASSAN_CONVERSATION_REVIEW_APPLY: '1' },
    adapter: 'conversation-reviewer',
    v1: { comparison: v1Baseline, overall: 0, areas: {} },
  },
  {
    branch: 'e2e/follow-up-end-to-end',
    pr: 51,
    stackedOn: 35,
    flags: { MOHASSAN_CONVERSATION_SHADOW: 'decide' },
    v1: {
      comparison: 'enabled PR #35, which matched the v1 development baseline',
      overall: 27,
      areas: { 'follow-up': 18, explanation: 3, factual: 6 },
    },
  },
  {
    branch: 'e2e/multi-step-end-to-end',
    pr: 52,
    stackedOn: 24,
    flags: { MOHASSAN_PLAN_COMPILER: 'on' },
    v1: {
      comparison: v1Baseline,
      overall: 17,
      areas: { 'multi-step': 17 },
      stackedComparison: {
        comparison: 'enabled PR #24',
        overall: 20,
        areas: { calculation: 2, 'multi-step': 18 },
      },
    },
  },
  {
    branch: 'e2e/memory-end-to-end',
    pr: 53,
    stackedOn: 31,
    flags: { MOHASSAN_STRUCTURED_MEMORY: '1' },
    adapter: 'structured-memory',
    v1: {
      comparison: 'enabled PR #31, which matched the v1 development baseline',
      overall: 16,
      areas: { memory: 16 },
    },
  },
  {
    branch: 'feat/explanations-multisource',
    pr: 49,
    stackedOn: 33,
    flags: { MOHASSAN_EXTRACTIVE_WRITING: '1' },
    v1: {
      comparison: 'enabled PR #33, which matched the v1 development baseline',
      areas: { explanation: 8, comparison: 1 },
    },
  },
  {
    branch: 'e2e/deliberation-no-regressions',
    pr: 55,
    stackedOn: 37,
    flags: {},
    adapter: 'deliberation',
    v1: {
      comparison: v1Baseline,
      overall: 3,
      areas: { clarification: 1, refusal: 2 },
      stackedComparison: {
        comparison: 'enabled PR #37',
        overall: 13,
        areas: { desktop: 5, 'document-file': 5, refusal: 3 },
      },
    },
  },
  {
    branch: 'e2e/document-file-end-to-end',
    pr: 58,
    flags: {},
    v1: { comparison: v1Baseline, overall: 13, areas: { 'document-file': 13 } },
  },
  {
    branch: 'e2e/comparison-end-to-end',
    pr: 50,
    stackedOn: 26,
    flags: { MOHASSAN_REASONING: '1' },
    v1: {
      comparison: 'enabled PR #26, which matched the v1 development baseline',
      overall: 18,
      areas: { comparison: 18 },
    },
  },
  {
    branch: 'e2e/factual-end-to-end',
    pr: 54,
    stackedOn: 25,
    flags: { MOHASSAN_ANSWER_SELECTION: '1' },
    v1: {
      comparison: v1Baseline,
      overall: 10,
      areas: { factual: 10 },
      stackedComparison: { comparison: 'enabled PR #25', overall: 13, areas: { factual: 13 } },
    },
  },
  {
    branch: 'e2e/refusal-generalization',
    pr: 57,
    stackedOn: 39,
    flags: { MOHASSAN_REFUSAL_POLICY: '1' },
    v1: {
      comparison: v1Baseline,
      overall: 15,
      areas: { refusal: 15 },
      stackedComparison: { comparison: 'enabled PR #39', overall: 0, areas: {} },
    },
  },
  {
    branch: 'feat/scratch-classifiers',
    pr: 47,
    flags: { MOHASSAN_SCRATCH_CLASSIFIERS: '1' },
    v1: {
      comparison: v1Baseline,
      overall: 5,
      areas: { refusal: 3, 'small-talk': 2 },
    },
  },
  {
    branch: 'feat/arabic-understanding-core',
    pr: 23,
    flags: { MOHASSAN_ARABIC_UNDERSTANDING: '1' },
    v1: { comparison: v1Baseline, overall: -1, areas: { factual: -1 } },
  },
  {
    branch: 'e2e/clarification-end-to-end',
    pr: 59,
    stackedOn: 32,
    optional: true,
    flags: { MOHASSAN_CLARIFY_CHOICES: '1' },
    adapter: 'clarification',
    v1: {
      comparison: v1Baseline,
      overall: 12,
      areas: { clarification: 12 },
      stackedComparison: { comparison: 'enabled PR #32', overall: 16, areas: { clarification: 16 } },
    },
  },
];

// These optional refs were absent when freezing the measured candidate set.
export const optionalBranches = ['integration/wave-1', 'e2e/calculation-end-to-end'] as const;
