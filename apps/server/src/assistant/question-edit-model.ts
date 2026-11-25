import { QUESTION_EDIT_DIMENSIONS, questionEditCandidates, type QuestionEditCandidate } from './question-edit-candidates.ts';
import { questionEditMinMargin, questionEditWeightsBase64, questionEditWeightScale } from './question-edit-weights.ts';
import type { QuestionHistory } from './question-rewriter.js';

type RankedQuestionEdit = { text: string; margin: number };

export function rankQuestionEdits(
  candidates: readonly QuestionEditCandidate[],
  weights: Float64Array,
): RankedQuestionEdit | null {
  let best: QuestionEditCandidate | undefined;
  let bestScore = -Infinity;
  let nextScore = -Infinity;
  for (const candidate of candidates) {
    let score = 0;
    for (const feature of candidate.features) score += weights[feature];
    if (score > bestScore) {
      best = candidate;
      nextScore = bestScore;
      bestScore = score;
    } else if (score > nextScore) {
      nextScore = score;
    }
  }
  return best ? { text: best.text, margin: bestScore - nextScore } : null;
}

function loadQuestionEditWeights(): Float64Array {
  const bytes = Buffer.from(questionEditWeightsBase64, 'base64');
  const weights = new Float64Array(QUESTION_EDIT_DIMENSIONS);
  if (bytes.length !== weights.length * 2) return weights;
  for (let index = 0; index < weights.length; index++) weights[index] = bytes.readInt16LE(index * 2) * questionEditWeightScale;
  return weights;
}

const learnedWeights = loadQuestionEditWeights();

/** Returns a copied edit only when the learned ranker prefers it to its alternatives. */
export function predictQuestionEdit(
  question: string,
  history: QuestionHistory,
  weights = learnedWeights,
  minMargin = questionEditMinMargin,
): RankedQuestionEdit | null {
  if (!history.articleTitle && history.turns.length === 0) return null;
  const edit = rankQuestionEdits(questionEditCandidates(question, history), weights);
  return edit && edit.text !== question.trim() && edit.margin >= minMargin ? edit : null;
}
