import type { QuestionHistory } from './question-rewriter.js';

export interface QuestionRewriteRequest {
  question: string;
  history: QuestionHistory;
  omitEndingPunctuation: boolean;
}

const rewriteInstruction = /^(?:(?:please|kindly)[,\s]+)?(?:(?:rewrite|rephrase|restate|make|turn)\b|(?:أعد صياغة|اعد صياغة|صغ|حوّل|حول|اجعل)(?=\s))/iu;
const standalone = /\b(?:stand[ -]?alone|self[ -]?contained|independent)\b|(?:مستقل(?:ة)?|مكتفٍ بذاته|واضح بذاته)/iu;
const questionOrQuery = /\b(?:question|query)\b|(?:سؤال|استعلام)/iu;
const omitEndingPunctuation = /\b(?:without|omit|no|remove|drop)\b[^.!?\r\n]{0,45}\b(?:punctuation|question mark)\b|(?:دون|بدون|احذف)\s+[^.!؟\r\n]{0,30}(?:الترقيم|علامة الاستفهام)/iu;

const field = /^\s*(article(?: title)?|section(?: title)?|(?:previous )?question(?: \d+)?|(?:previous )?answer(?: \d+)?|(?:final|current|follow[ -]?up) question|(?:عنوان )?المقال(?:ة)?|(?:عنوان )?القسم|السؤال (?:الأخير|الحالي|التالي)|سؤال(?: \d+)?|إجابة(?: \d+)?|جواب(?: \d+)?)\s*[:：]\s*(.*)$/iu;

/** Read the labelled transcript before general routing flattens its line breaks. */
export function parseQuestionRewriteRequest(request: string): QuestionRewriteRequest | null {
  if (!request || request.length > 8000 || !/[\r\n]/u.test(request)) return null;
  const [instruction = '', ...lines] = request.trim().split(/\r\n?|\n/u);
  if (!(rewriteInstruction.test(instruction) && standalone.test(instruction) && questionOrQuery.test(instruction))) return null;

  const entries: Array<{ label: string; value: string }> = [];
  for (const line of lines) {
    const match = field.exec(line);
    if (match) {
      entries.push({ label: match[1].toLowerCase(), value: match[2].trim() });
    } else if (line.trim()) {
      const previous = entries.at(-1);
      if (!previous) {
        if (!/^(?:context|history|conversation|السياق|المحادثة)\s*[:：]?$/iu.test(line.trim())) return null;
      } else {
        previous.value += ` ${line.trim()}`;
      }
    }
  }

  const final = entries.pop();
  if (!final?.value || !/^(?:(?:final|current|follow[ -]?up) |السؤال )/u.test(final.label)) return null;
  let articleTitle: string | undefined;
  let sectionTitle: string | undefined;
  const turns: Array<{ question: string; answer?: string }> = [];
  for (const { label, value } of entries) {
    if (!value) return null;
    const previous = turns.at(-1);
    if (!turns.length && !articleTitle && /^(?:article|(?:عنوان )?المقال)/u.test(label)) articleTitle = value;
    else if (!turns.length && !sectionTitle && /^(?:section|(?:عنوان )?القسم)/u.test(label)) sectionTitle = value;
    else if (/^(?:question|previous question|سؤال)/u.test(label) && (!previous || previous.answer)) turns.push({ question: value });
    else if (/^(?:answer|previous answer|إجابة|جواب)/u.test(label) && previous && !previous.answer) previous.answer = value;
    else return null;
  }
  if (!turns.length && !articleTitle && !sectionTitle) return null;
  return { question: final.value, history: { articleTitle, sectionTitle, turns }, omitEndingPunctuation: omitEndingPunctuation.test(instruction) };
}
