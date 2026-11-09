import { afterEach, describe, expect, it } from 'vitest';
import { AgentBrowser } from '@mohassan/browser';
import { createDatabase, migrate } from '@mohassan/database';
import type { ModelRequest } from '@mohassan/providers';
import { createCommandChatControl } from '../apps/server/src/command-chat.js';
import type { ComputerScreen } from '../apps/server/src/assistant/tools.js';

const owner = 'computer-view-test-owner';
const blank = { thought: null, plan: null, note: null, url: null, ref: null, text: null, submit: null, options: null, sensitive: null, outcome: null };
const databases: Awaited<ReturnType<typeof createDatabase>>[] = [];
const controls: Awaited<ReturnType<typeof createCommandChatControl>>[] = [];
// Only provider dispatch is under test; the injected provider never decodes this image or contacts a service.
const jpeg = Buffer.from([255, 216, 255, 224, ...Buffer.from('synthetic-jpeg-boundary'), 255, 217]).toString('base64');
const unavailable = 'No screenshot is available; only the listed elements were observed.';

async function readScreen(overrides: Partial<ComputerScreen> = {}) {
  const database = await createDatabase();
  databases.push(database);
  await migrate(database.db);
  const requests: { model: string; request: ModelRequest }[] = [];
  let decisions = 0;
  const control = await createCommandChatControl(database.db, {
    models: { fast: ['decision'], deep: ['decision'], vision: 'vision' },
    createProvider: model => ({
      id: 'isolated-computer-view-test',
      async generate(request) {
        requests.push({ model, request });
        return {
          model, usage: { inputTokens: 1, outputTokens: 1 },
          text: model === 'vision' ? 'الصورة تعرض لوحة الحالة.' : JSON.stringify({ ...blank, ...(++decisions === 1
            ? { tool: 'computer_view', text: 'ماذا تعرض النافذة؟' }
            : { tool: 'answer', text: 'قرأت العناصر المتاحة.', outcome: 'done' }) }),
        };
      },
    }),
    browser: { setCheckpointStore() {}, bindAccount: async () => {}, hasPage: async () => false, close: async () => {} } as unknown as AgentBrowser,
    tools: { computer: {
      view: async () => ({ title: 'نافذة محلية', canAct: false, hasPasswordField: false, jpeg: '',
        elements: [{ ref: 'w1', name: 'الحالة: جاهز', type: 'Text' }], ...overrides }),
      perform: async () => { throw new Error('No input should be attempted'); },
    } },
  });
  controls.push(control);
  const { id } = await control.create(owner, { goal: 'اقرأ نافذة البرنامج على الكمبيوتر وأخبرني بالحالة.' });
  await control.settled(id);
  expect((await database.db.selectFrom('chat_runs').select('status').where('conversation_id', '=', id).executeTakeFirstOrThrow()).status).toBe('completed');
  const prompt = requests.filter(item => item.model === 'decision').at(-1)!.request.goal;
  const visionReceipts = await database.db.selectFrom('chat_model_receipts').selectAll().where('purpose', '=', 'vision').execute();
  return { requests, prompt, visionReceipts };
}

afterEach(async () => {
  for (const control of controls.splice(0)) await control.shutdown();
  for (const database of databases.splice(0)) await database.close();
});

describe('computer view without a screenshot', () => {
  it.each(['', '   '])('keeps observed elements and avoids vision for an empty image %j', async image => {
    const result = await readScreen({ jpeg: image });
    expect(result.prompt).toContain('w1 Text "الحالة: جاهز"');
    expect(result.prompt).toContain(unavailable);
    expect(result.prompt).not.toContain('may show sign-in details');
    expect(result.requests.filter(item => item.model === 'vision')).toEqual([]);
    expect(result.visionReceipts).toEqual([]);
  });

  it.each(['', jpeg])('keeps the sensitive-window guard before image handling for %j', async image => {
    const result = await readScreen({ jpeg: image, hasPasswordField: true });
    expect(result.prompt).toContain('w1 Text "الحالة: جاهز"');
    expect(result.prompt).toContain('The image was not read because this window may show sign-in details.');
    expect(result.prompt).not.toContain(unavailable);
    expect(result.requests.filter(item => item.model === 'vision')).toEqual([]);
    expect(result.visionReceipts).toEqual([]);
  });

  it('forwards an available non-sensitive image to vision and retains its receipt', async () => {
    const result = await readScreen({ jpeg });
    const visions = result.requests.filter(item => item.model === 'vision');
    expect(visions).toHaveLength(1);
    expect(visions[0]!.request).toMatchObject({ goal: 'ماذا تعرض النافذة؟', image: { mimeType: 'image/jpeg', data: jpeg } });
    expect(result.prompt).toContain('w1 Text "الحالة: جاهز"');
    expect(result.prompt).toContain('seen: الصورة تعرض لوحة الحالة.');
    expect(result.prompt).not.toContain(unavailable);
    expect(result.visionReceipts).toHaveLength(1);
    expect(result.visionReceipts[0]).toMatchObject({ status: 'succeeded', usage_known: true, action_valid: true });
  });
});
