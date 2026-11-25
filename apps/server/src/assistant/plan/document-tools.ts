import { PdfError, parsePageSelection } from '@mohassan/pdf';
import type { CommandChatConfig } from '../../command-chat.js';
import type { DocumentEdit, DocumentInput, StoredDocument } from '../../documents.js';
import { composeDocumentSpec, documentCreatedReply, documentEditedReply, documentInfoReply, documentRequestGaps, documentTask, type DocumentEditTask } from '../documents.js';
import { verifyStoredPdf } from '../run-plans.js';
import type { PlanToolResult } from './executor.js';
import { valueText } from './local-tools.js';
import type { PlanStep, ResolvedStepInputs } from './types.js';

interface PlanDocumentContext {
  ownerId: string;
  conversationId: string;
  documents?: CommandChatConfig['documents'];
  fullAccess?: boolean;
  active(): Promise<void>;
  scrub(text: string): string;
}

export function createPlanDocumentTools(context: PlanDocumentContext) {
  const files = new Map<string, StoredDocument>();
  const { documents, ownerId, conversationId, active, scrub } = context;
  async function verified(stored: StoredDocument, signal: AbortSignal): Promise<string | null> {
    if (!documents) return null;
    await active();
    const readback = await documents.control.content(ownerId, stored.id);
    signal.throwIfAborted();
    if (!verifyStoredPdf(stored, readback).ok) return null;
    const link = documents.link(stored.id);
    files.set(link, stored);
    return link;
  }

  async function operation(task: DocumentEditTask, first: DocumentInput, signal: AbortSignal): Promise<DocumentEdit | null> {
    if (!documents) return null;
    const pagesOf = async (words: string) => parsePageSelection(words, (await documents.control.info(first.bytes, signal)).pages);
    switch (task.operation) {
      case 'merge': return { op: 'merge' };
      case 'extract': return { op: 'extract', pages: await pagesOf(task.pages ?? '') };
      case 'delete': return { op: 'delete', pages: await pagesOf(task.pages ?? '') };
      case 'rotate': return { op: 'rotate', angle: task.angle ?? 90, ...(task.pages ? { pages: await pagesOf(task.pages) } : {}) };
      case 'watermark': return { op: 'watermark', text: task.text ?? '' };
      case 'number': return { op: 'number' };
      case 'metadata': return { op: 'metadata', ...(task.title ? { title: task.title } : {}), ...(task.author ? { author: task.author } : {}) };
      default: return null;
    }
  }

  async function edit(task: DocumentEditTask, references: ResolvedStepInputs['references'], signal: AbortSignal): Promise<PlanToolResult> {
    if (!documents) return { ok: false, reason: 'unavailable' };
    const explicitPaths = task.sources.filter(source => source.kind === 'path');
    if (explicitPaths.length && !context.fullAccess) return { ok: false, reason: 'restricted' };
    const inputs: DocumentInput[] = [];
    for (const { value } of references) {
      const stored = value.type === 'file' ? files.get(value.value) : undefined;
      if (!stored) return { ok: false, reason: 'missing_input' };
      await active();
      const readback = await documents.control.content(ownerId, stored.id);
      if (!verifyStoredPdf(stored, readback).ok) return { ok: false, reason: 'invalid_result' };
      inputs.push({ name: readback.name, bytes: readback.bytes });
    }
    const sources = references.length ? explicitPaths : task.sources;
    for (const source of sources) {
      await active();
      if (source.kind === 'path') {
        inputs.push(await documents.control.readLocal(ownerId, source.path));
        continue;
      }
      const rows = await documents.control.list(ownerId, conversationId, source.kind === 'all' ? 12 : source.count);
      for (const row of rows.reverse()) {
        await active();
        const content = await documents.control.content(ownerId, row.id);
        inputs.push({ name: content.name, bytes: content.bytes });
      }
    }
    const first = inputs[0];
    if (!first || task.operation === 'merge' && inputs.length < 2) return { ok: false, reason: 'missing_input' };
    if (task.operation === 'info') {
      const info = await documents.control.info(first.bytes, signal);
      return { ok: true, value: { type: 'text', value: scrub(documentInfoReply(first.name, first.bytes.byteLength, info, task.lang)) },
        evidence: { kind: 'readback', label: 'PDF read from storage', independent: true } };
    }
    const action = await operation(task, first, signal);
    if (!action) return { ok: false, reason: 'unavailable' };
    await active();
    signal.throwIfAborted();
    const stored = await documents.control.edit(ownerId, conversationId, inputs, action, signal);
    const link = await verified(stored, signal);
    if (!link) return { ok: false, reason: 'unknown_effect' };
    return { ok: true, value: { type: 'file', value: link, label: stored.name },
      text: scrub(documentEditedReply(task, stored, link, inputs.map(input => input.name))),
      evidence: { kind: 'readback', label: 'Stored PDF readback', reference: stored.id, independent: true } };
  }

  return async (step: PlanStep, inputs: ResolvedStepInputs, signal: AbortSignal): Promise<PlanToolResult> => {
    if (!documents) return { ok: false, reason: 'unavailable' };
    const parserInput = inputs.references.length
      ? step.text.replace(/(?<!\p{L})حو[ّ]?ل(?:ها|ه)(?=\s+(?:إلى|الى)\s)/u, 'حوّل هذا النص')
      : step.text;
    const task = documentTask(parserInput, { hasDocuments: inputs.references.some(input => input.value.type === 'file') });
    if (!task || task.kind === 'unsupported') return { ok: false, reason: 'unavailable' };
    if (task.kind === 'edit') return edit(task, inputs.references, signal);
    // Results are document body data. Parse the original instruction first so
    // webpage wording cannot rename the file, specify a local path or add work.
    const referenceContent = inputs.references.map(({ value }) => valueText(value)).join('\n\n');
    const content = [task.suppliedText, referenceContent].filter(Boolean).join('\n\n');
    const { spec, emptyContent } = composeDocumentSpec({ ...task, suppliedText: scrub(content) });
    if (emptyContent) return { ok: false, reason: 'missing_input',
      question: task.lang === 'ar' ? 'ما النص الذي تريده داخل ملف PDF؟' : 'What text belongs in the PDF?' };
    await active();
    signal.throwIfAborted();
    let stored: StoredDocument;
    try {
      stored = await documents.control.create(ownerId, conversationId, spec, signal, task.fileName ? { name: task.fileName } : {});
    } catch (error) {
      if (error instanceof PdfError && error.code === 'PDF_RENDER_UNAVAILABLE') return { ok: false, reason: 'unavailable' };
      throw error;
    }
    const link = await verified(stored, signal);
    if (!link) return { ok: false, reason: 'unknown_effect' };
    const gaps = documentRequestGaps(task, stored);
    const reply = documentCreatedReply(stored, link, task.lang, false, gaps);
    // Omit the direct-message-only footer when the file quotes observed data.
    const text = scrub(referenceContent ? reply.split('\n\n---\n', 1)[0]! : reply);
    const evidence = { kind: 'readback' as const, label: 'Stored PDF readback', reference: stored.id, independent: true };
    if (gaps.length) return { ok: false, reason: 'invalid_result', text, evidence };
    return { ok: true, value: { type: 'file', value: link, label: stored.name }, text, evidence };
  };
}
