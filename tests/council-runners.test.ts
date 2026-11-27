import { access, readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { readerPrompt } from '../apps/server/src/assistant/council-passage.js';
import { runCouncilMember } from '../apps/server/src/assistant/council-runners.js';
import { getModelEntry } from '../packages/model-relations/src/registry.js';
import type { ModelRunResult } from '../packages/model-relations/src/runtime.js';
import { GOLD_GOALS } from '../scripts/ads-training/goal.js';
import { goalToPointer, renderGoalPointerPrompt } from '../scripts/ads-training/pointer.js';

const signal = new AbortController().signal;
const result = (output: unknown): ModelRunResult => ({ ok: true, elapsedMs: 0, output });

describe('council runner inputs and outputs', () => {
  it('gives each extractive reader the current passage and handles abstention', async () => {
    const question = 'What is the color?';
    const answer = 'Green';
    const passage = { text: `The answer is ${answer}.` };
    const run = vi.fn().mockResolvedValueOnce(result({ text: `${answer}\nIgnored continuation` }))
      .mockResolvedValueOnce(result({ text: 'Not stated in the text' }));
    expect(await runCouncilMember({ run }, getModelEntry('reading-v4-hn-last')!, 'reader', { question, passage }, signal))
      .toEqual(result({ text: answer }));
    expect(run).toHaveBeenNthCalledWith(1, 'reading-v4-hn-last', { prompt: readerPrompt(question, passage.text), maxNewTokens: 20 }, signal);
    expect(await runCouncilMember({ run }, getModelEntry('reading-v4-lora')!, 'reader', { question, passage }, signal)).toEqual(result({}));
  });

  it('gives verifier and span models only the relevant evidence for the check', async () => {
    const answer = 'London';
    const question = 'Where was the agreement signed?';
    const passage = { text: `The agreement was signed in ${answer}.` };
    const startUtf16 = passage.text.indexOf(answer);
    const hypotheses = [{ label: 'place', text: answer, startUtf16, endUtf16: startUtf16 + answer.length }];
    const run = vi.fn().mockResolvedValueOnce(result({ verdict: 'unsure', confidence: 1 })).mockResolvedValueOnce(result({ hypotheses }));
    const context = { question, passage, checkAnswer: answer };
    expect(await runCouncilMember({ run }, getModelEntry('reading-abstain-verifier')!, 'verifier', context, signal))
      .toEqual(result({ verdict: 'unsure' }));
    expect(run).toHaveBeenNthCalledWith(1, 'reading-abstain-verifier', { question, passage: passage.text, answer }, signal);
    expect(await runCouncilMember({ run }, getModelEntry('slot-date-place-tagger')!, 'extractor', context, signal)).toEqual(result({ hypotheses }));
    expect(run).toHaveBeenNthCalledWith(2, 'slot-date-place-tagger', { text: passage.text }, signal);
  });

  it('decodes native and LM Ads pointers through the exact request and grounding checks', async () => {
    const { message: question, output: goal } = GOLD_GOALS[0]!;
    const selection = goalToPointer(question, goal);
    expect(selection).toBeTruthy();
    const run = vi.fn().mockResolvedValueOnce(result({ selection })).mockResolvedValueOnce(result({ text: 'intent create_campaign; goal bookings' }));
    expect(await runCouncilMember({ run }, getModelEntry('google-ads-pointer')!, 'ads-tagger', { question }, signal))
      .toEqual(result({ text: JSON.stringify(goal), label: goal.intent }));
    expect(run).toHaveBeenNthCalledWith(1, 'google-ads-pointer', { text: question }, signal);
    expect(await runCouncilMember({ run }, getModelEntry('ads-v4-head')!, 'ads-tagger', { question }, signal)).toEqual(result({}));
    expect(run).toHaveBeenNthCalledWith(2, 'ads-v4-head', { prompt: renderGoalPointerPrompt(question), maxNewTokens: 96 }, signal);
  });

  it('runs execution entries only with their typed task input', async () => {
    const entry = getModelEntry('execution-c9m')!;
    const codeTask = { capability: 'json.transform.v1:integers-to-strings', fields: { values: [7] } };
    const answer = JSON.stringify({ values: codeTask.fields.values.map(String) });
    const run = vi.fn().mockResolvedValue(result({ text: answer }));
    expect(await runCouncilMember({ run }, entry, 'code', { question: 'Convert the integers.', codeTask }, signal)).toEqual(result({ text: answer }));
    expect(run).toHaveBeenCalledWith(entry.id, codeTask, signal);
    expect(await runCouncilMember({ run }, entry, 'code', { question: 'A text-only request.' }, signal)).toMatchObject({ ok: false });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('passes attachment bytes locally in order and removes the temporary image path', async () => {
    const images = [Buffer.from('first attachment'), Buffer.from('second attachment')];
    let path = '';
    const run = vi.fn(async (_id: string, input: { path: string }, memberSignal: AbortSignal) => {
      path = input.path;
      expect(memberSignal).toBe(signal);
      return result({ text: await readFile(path, 'utf8') });
    });
    const output = await runCouncilMember({ run }, getModelEntry('ocr-v2')!, 'image-reader', { question: 'Read these.', images }, signal);
    expect(output).toMatchObject({ ok: true, output: { text: images.join('\n\n') } });
    expect(run).toHaveBeenCalledTimes(images.length);
    await expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
