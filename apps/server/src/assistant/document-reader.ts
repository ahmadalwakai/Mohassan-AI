import { extractPdfText, LearningContentError } from '@mohassan/learning';
import { PdfError } from '@mohassan/pdf';
import type { CommandChatConfig } from '../command-chat.js';
import type { DocumentControl, DocumentInput } from '../documents.js';
import type { BrainState } from './brain.js';
import { documentTask, type DocumentReadTask } from './documents.js';
import { requestCapabilityAllowed, type UserRequestConstraints } from './request-constraints.js';
export { finishInlineDataFile } from './inline-data-file.js';

type DocumentAccess = Pick<DocumentControl, 'list' | 'content' | 'readLocal'>;
interface ReadContext {
  ownerId: string;
  conversationId: string;
  localFiles: boolean;
  constraints: UserRequestConstraints | null;
  signal: AbortSignal;
  state: Pick<BrainState, 'steps' | 'trail'>;
}

const MAX_SOURCES = 4;
const MAX_READ_CHARS = 6000;
const SUMMARY_SIZE = 3;

/** The generic desktop text parser can also claim an explicitly named PDF. Leave those operations to PDF handling. */
export function preferDocumentControl(config: CommandChatConfig): CommandChatConfig {
  const { desktop, documents } = config;
  if (!desktop || !documents) return config;
  return {
    ...config,
    desktop: {
      describe: desktop.describe.bind(desktop),
      execute: desktop.execute.bind(desktop),
      parse(text) {
        const parsed = desktop.parse(text);
        const command = parsed?.command;
        if (command?.kind === 'file_create' && documentTask(text)?.kind === 'create') return null;
        if (command?.kind === 'file_read' || command?.kind === 'file_delete' || command?.kind === 'file_write') {
          const task = documentTask(text);
          if (task?.kind === 'read' || task?.kind === 'edit') return null;
        }
        return parsed;
      },
    },
  };
}

async function namedDocument(control: DocumentAccess, ownerId: string, conversationId: string, name: string): Promise<DocumentInput | null> {
  if (/[\\/]/u.test(name)) return null;
  const matches = await control.list(ownerId, conversationId, 2, name);
  if (matches.length > 1) throw new PdfError('DOCUMENT_NAME_AMBIGUOUS', 'يوجد أكثر من ملف PDF بهذا الاسم في المحادثة.');
  const match = matches[0];
  return match ? control.content(ownerId, match.id) : null;
}

/** A bare filename can identify a stored PDF in this conversation. An explicit local path uses the existing root checks. */
export async function addNamedDocumentInput(control: DocumentAccess, ownerId: string, conversationId: string, name: string, inputs: DocumentInput[], constraints: UserRequestConstraints | null): Promise<boolean> {
  const stored = requestCapabilityAllowed(constraints, 'knowledge_read') ? await namedDocument(control, ownerId, conversationId, name) : null;
  if (!stored) {
    if (!requestCapabilityAllowed(constraints, 'computer_read')) throw new PdfError('DOCUMENT_PATH_DENIED', 'الطلب لا يسمح بقراءة هذا الملف من الجهاز.');
    return false;
  }
  inputs.push(stored);
  return true;
}

async function readSource(control: DocumentAccess, context: ReadContext, reference: string | null): Promise<DocumentInput> {
  const { ownerId, conversationId, localFiles, constraints } = context;
  const storedFiles = requestCapabilityAllowed(constraints, 'knowledge_read');
  if (reference !== null) {
    const stored = storedFiles ? await namedDocument(control, ownerId, conversationId, reference) : null;
    if (stored) return stored;
    if (localFiles && requestCapabilityAllowed(constraints, 'computer_read')) return control.readLocal(ownerId, reference);
  } else if (storedFiles) {
    const [latest] = await control.list(ownerId, conversationId, 1);
    if (latest) return control.content(ownerId, latest.id);
  }
  throw new PdfError('DOCUMENT_NOT_FOUND', 'لم أجد ملف PDF المطلوب في هذه المحادثة.');
}

function excerpt(text: string, lang: DocumentReadTask['lang']): string {
  const segmenter = new Intl.Segmenter(lang, { granularity: 'sentence' });
  const sentences = [...segmenter.segment(text.replace(/\s+/gu, ' '))].map(({ segment }) => segment.trim()).filter(Boolean);
  return sentences.slice(0, SUMMARY_SIZE).join('\n');
}

function literalBlock(text: string): string {
  const fence = '```';
  // The Markdown renderer treats line-start fences as delimiters even within an existing block.
  const lines = text.split('\n').map(line => line.trimStart().startsWith(fence) ? '\u200b' + line : line);
  return [fence, ...lines, fence].join('\n');
}

function readError(error: LearningContentError | PdfError, ar: boolean): string {
  if (ar) return error.message;
  if (error.code === 'DOCUMENT_NAME_AMBIGUOUS') return 'Several PDFs have that name in this conversation. Specify which copy to use.';
  if (error.code === 'DOCUMENT_PATH_DENIED' || error.code === 'DOCUMENT_NOT_FOUND') return 'I could not find the requested PDF among the available files. Upload it to this conversation or give its permitted local path.';
  if (error.code === 'KNOWLEDGE_PDF_NO_TEXT') return 'The PDF has no extractable text. Its scanned pages need OCR.';
  return 'The PDF could not be read.';
}

/** Return verified PDF text or verbatim source excerpts, with no interpretation of document instructions. */
export async function readDocumentRequest(task: DocumentReadTask, control: DocumentAccess, context: ReadContext): Promise<{ text: string; status: 'completed' | 'partial' | 'blocked' }> {
  const ar = task.lang === 'ar';
  if (task.paths.length > MAX_SOURCES) {
    return { text: ar ? 'اذكر أربعة ملفات PDF أو أقل في الطلب.' : 'Request up to four PDFs at a time.', status: 'blocked' };
  }
  const references = task.paths.length ? task.paths : [null];
  const replies: string[] = [];
  let read = 0;
  let incomplete = false;
  for (const reference of references) {
    try {
      const source = await readSource(control, context, reference);
      const text = await extractPdfText(source.bytes, { signal: context.signal });
      context.state.trail.push({ step: ++context.state.steps, action: 'document_read', changed: false, result: 'PDF text extracted' });
      const result = task.summary ? excerpt(text, task.lang) : text;
      const truncated = result.length > MAX_READ_CHARS;
      const heading = task.summary ? (ar ? 'ملخص بمقتطفات من الملف' : 'Summary using excerpts from the file') : (ar ? 'نص الملف' : 'Text from the file');
      const limit = truncated ? (ar ? '\n\nعُرض الجزء الأول فقط لأن النص طويل.' : '\n\nThe text is long, so only the first portion is shown.') : '';
      replies.push(heading + '\n\n' + literalBlock(source.name + '\n\n' + result.slice(0, MAX_READ_CHARS)) + limit);
      incomplete ||= truncated;
      read++;
    } catch (error) {
      context.signal.throwIfAborted();
      if (!(error instanceof LearningContentError) && !(error instanceof PdfError)) throw error;
      replies.push((reference === null ? '' : literalBlock(reference) + '\n\n') + readError(error, ar));
      incomplete = true;
    }
  }
  return { text: replies.join('\n\n'), status: read === 0 ? 'blocked' : incomplete ? 'partial' : 'completed' };
}
