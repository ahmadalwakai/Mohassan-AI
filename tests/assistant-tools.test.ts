import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { snapshotHash } from '@mohassan/coding';
import { createApplication } from '../apps/server/src/app.js';
import { asksToRemember, chooseTier, decisionJsonSchema, decisionSchema, newBrainState, systemPrompt, TOOLS } from '../apps/server/src/assistant/brain.js';
import { elementCenter } from '../apps/server/src/assistant/tools.js';
import { createMockGroq } from './fixtures/planning.js';

const blank = { thought: null, plan: null, note: null, url: null, ref: null, text: null, submit: null, options: null, sensitive: null, outcome: null };

describe('which tools the model is offered', () => {
  it('stays exactly as it was when no module is connected', () => {
    expect(systemPrompt('2026-11-05')).toBe(systemPrompt('2026-11-05', false, false, []));
    expect(decisionJsonSchema()).toBe(decisionJsonSchema(false, false, []));
    expect(decisionSchema().safeParse({ ...blank, tool: 'code_change' }).success).toBe(false);
    expect(TOOLS).not.toContain('code_change');
  });
  it('offers and describes only what is connected', () => {
    expect(decisionSchema(false, false, ['memory_search']).safeParse({ ...blank, tool: 'memory_search' }).success).toBe(true);
    expect(decisionSchema(false, false, ['memory_search']).safeParse({ ...blank, tool: 'code_change' }).success).toBe(false);
    const prompt = systemPrompt('2026-11-05', false, false, ['memory_search']);
    expect(prompt).toContain('memory_search:');
    expect(prompt).not.toContain('code_change:');
    expect(prompt).not.toContain('computer_click:');
  });
  it('treats only the owner\'s own words as a request to remember', () => {
    expect(asksToRemember('تذكر أن اجتماعي يوم الأحد')).toBe(true);
    expect(asksToRemember('remember that I prefer Arabic')).toBe(true);
    expect(asksToRemember('لخص هذه الصفحة')).toBe(false);
  });
  it('reports a work tool\'s result with the stronger model', () => {
    const state = { ...newBrainState(), steps: 3 };
    expect(chooseTier(state)).toBe('fast');
    expect(chooseTier({ ...state, trail: [{ step: 3, action: 'click "Save"', result: 'clicked', changed: true }] })).toBe('fast');
    expect(chooseTier({ ...state, trail: [{ step: 3, action: 'code_change تعديل', result: 'done', changed: true }] })).toBe('deep');
  });
  it('converts a UI rectangle to the coordinates the companion clicks', () => {
    expect(elementCenter({ x: 100, y: 40, width: 100, height: 20 }, { width: 400, height: 200 })).toEqual({ x: 0.375, y: 0.25 });
    expect(elementCenter({ x: 390, y: 190, width: 100, height: 100 }, { width: 400, height: 200 })).toEqual({ x: 1, y: 1 });
  });
});

describe('the assistant reaching the real modules', () => {
  let application: Awaited<ReturnType<typeof createApplication>>;
  let directory = '', cookie = '', projectId = '', deviceId = '', deviceKey = '';
  let script: Record<string, unknown>[] = [];
  let prompts: string[] = [];
  let holdSandbox: Promise<void> | null = null;
  const secret = 'assistant-tools-fixture-internal-secret-01', origin = 'http://127.0.0.1:3000';
  const headers = { 'x-mohassan-internal': secret, origin };
  const mock = createMockGroq();
  const scripted: typeof fetch = async (input, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (body.response_format?.json_schema?.name !== 'decision') return mock.fetch(input, init);
    prompts.push(`${body.messages[0].content}\n${body.messages.at(-1).content}`);
    const decision = { ...blank, ...(script.shift() ?? { tool: 'answer', text: 'انتهيت.', outcome: 'done' }) };
    return Response.json({ model: body.model, choices: [{ message: { content: JSON.stringify(decision) }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20 } });
  };
  const api = (method: 'GET' | 'POST', url: string, payload?: unknown, session = cookie) => application.app.inject({ method, url, headers: { ...headers, cookie: session }, ...(payload === undefined ? {} : { payload: payload as object }) });
  const delay = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));

  async function settled(id: string, session = cookie) {
    for (let attempt = 0; attempt < 600; attempt++) {
      const detail = (await api('GET', `/api/chat/conversations/${id}`, undefined, session)).json();
      if (detail.status !== 'running') return detail;
      await delay(25);
    }
    throw new Error('the conversation never settled');
  }
  async function ask(goal: string, session = cookie) {
    // Any chat request names the active session; the route's own limit is not under test here.
    await api('GET', '/api/chat/conversations', undefined, session);
    return settled((await application.chat.create(owner(), { goal })).id, session);
  }
  const approve = async (conversation: any, approved: boolean) => {
    const response = await api('POST', `/api/chat/conversations/${conversation.id}/approve`, { approvalId: conversation.approval.id, approved });
    expect(response.statusCode).toBe(200);
    return settled(conversation.id);
  };
  const tasks = async () => (await application.runtime.snapshot(owner())).tasks;
  let ownerId = '';
  const owner = () => ownerId;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'mohassan-assistant-tools-'));
    application = await createApplication({
      authSecret: 'assistant-tools-fixture-auth-secret-0001', internalSecret: secret, setupToken: 'assistant-tools-fixture-setup-token-001', webOrigin: origin, production: false, runWorker: true, testRequestLimit: 2000,
      groqApiKey: 'unit-only-fixture-key', aiFetch: scripted, codingDataDir: directory, codingAllowedRoots: [directory], browserChannel: null,
      sandboxRunner: {
        available: async () => ({ available: true, provider: 'unit-fixture', message: 'injected unit test only' }),
        run: async request => {
          await holdSandbox;
          return { exitCode: request.files.some(file => file.path === 'src/sum.mjs' && file.content.includes('a - b')) ? 1 : 0, stdout: 'unit fixture receipt; no project code is executed here', stderr: '', timedOut: false, durationMs: 1, provider: 'unit-fixture', network: 'denied', isolation: 'appcontainer', isolationVerified: true, snapshotHash: snapshotHash(request.files) };
        },
      },
    });
    await application.app.inject({ method: 'POST', url: '/api/setup', headers, payload: { name: 'مالك أدوات المساعد', email: 'assistant-tools@example.test', password: 'Assistant-Fixture-Password-42', setupToken: 'assistant-tools-fixture-setup-token-001' } });
    const login = await application.app.inject({ method: 'POST', url: '/api/auth/sign-in/email', headers, payload: { email: 'assistant-tools@example.test', password: 'Assistant-Fixture-Password-42' } });
    cookie = (Array.isArray(login.headers['set-cookie']) ? login.headers['set-cookie'] : [login.headers['set-cookie']]).filter(Boolean).map(value => String(value).split(';')[0]).join('; ');
    ownerId = (await application.database.db.selectFrom('user').select('id').executeTakeFirstOrThrow()).id as string;
    projectId = (await api('POST', '/api/coding/projects/demo', {})).json().id;
  });
  afterAll(async () => {
    await application?.app.close();
    if (directory) {
      const base = await realpath(tmpdir()), target = await realpath(directory), inside = relative(base, target);
      if (!isAbsolute(inside) && inside.startsWith('mohassan-assistant-tools-')) await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  });
  beforeEach(() => { script = []; prompts = []; });

  describe('memory', () => {
    it('saves what the owner asked it to remember and finds it again', async () => {
      script = [{ tool: 'memory_save', text: 'اجتماع الفريق كل أحد الساعة العاشرة' }];
      expect((await ask('تذكر أن اجتماع الفريق كل أحد الساعة العاشرة')).status).toBe('idle');
      script = [{ tool: 'memory_search', text: 'اجتماع الفريق' }];
      await ask('متى اجتماع الفريق؟');
      expect(prompts.at(-1)).toContain('اجتماع الفريق كل أحد الساعة العاشرة');
    });
    it('keeps the owner\'s own words so a search in their language finds an English note', async () => {
      script = [{ tool: 'memory_save', text: 'favorite_city: Muscat' }];
      await ask('تذكر أن مدينتي المفضلة هي مسقط');
      expect((await application.memory.search(owner(), { query: 'مدينتي المفضلة' })).items).toHaveLength(1);
    });
    it('does not repeat a save when the model does', async () => {
      const fact = 'موعد التجديد في أول مارس';
      script = [{ tool: 'memory_save', text: fact }, { tool: 'memory_save', text: fact }, { tool: 'memory_save', text: fact }];
      const result = await ask('تذكر أن موعد التجديد في أول مارس');
      expect(result.status).toBe('idle');
      expect((await application.memory.search(owner(), { query: 'التجديد' })).items).toHaveLength(1);
      expect(prompts.some(prompt => prompt.includes('not repeated'))).toBe(true);
    });
    it('caps how much one request can save', async () => {
      script = [1, 2, 3, 4, 5].map(index => ({ tool: 'memory_save', text: `بند الحصة رقم ${index}` }));
      await ask('احفظ كل هذه البنود');
      expect((await application.memory.search(owner(), { query: 'بند الحصة' })).items).toHaveLength(3);
    });
    it('saves nothing when the model gives no fact', async () => {
      script = [{ tool: 'memory_save', text: null }];
      await ask('تذكر هذا الشيء الفارغ');
      expect((await application.memory.search(owner(), { query: 'الفارغ' })).items).toEqual([]);
    });
    it('asks again when the model answers with nothing', async () => {
      script = [{ tool: 'answer', text: null, outcome: 'done' }, { tool: 'answer', text: 'رد كامل', outcome: 'done' }];
      expect((await ask('سؤال بسيط')).messages.at(-1).text).toBe('رد كامل');
    });
    it('refuses a save nobody asked for, such as one a page suggested', async () => {
      script = [{ tool: 'memory_save', text: 'كلمة زرعتها صفحة خبيثة' }];
      await ask('لخص هذه الصفحة');
      expect(prompts.at(-1)).toContain('memory_save needs the user to ask');
      expect((await application.memory.search(owner(), { query: 'زرعتها' })).items).toEqual([]);
    });
    it('rejects credentials before they reach memory', async () => {
      script = [{ tool: 'memory_save', text: 'password=fixture-secret-value' }];
      await ask('احفظ هذا');
      expect((await application.memory.search(owner(), { query: 'fixture-secret-value' })).items).toEqual([]);
    });
  });

  describe('coding through the Runtime', () => {
    const change = () => ({ tool: 'code_change', url: projectId, text: 'أصلح دالة الجمع في المشروع.' });

    it('lists the projects it can work on', async () => {
      script = [{ tool: 'workspace_list' }];
      await ask('ما مشاريعي؟');
      expect(prompts.at(-1)).toContain(projectId);
    });
    it('changes nothing until approved, then reports the verified result', async () => {
      script = [change()];
      const waiting = await ask('أصلح مشروعي');
      expect(waiting.status).toBe('waiting_approval');
      expect(waiting.approval.prompt).toContain('أصلح دالة الجمع');
      const task = (await tasks()).find(item => item.capabilityId === 'coding.change');
      expect(task?.status).toBe('waiting_approval');
      const done = await approve(waiting, true);
      expect(done.status).toBe('idle');
      expect(prompts.at(-1)).toContain('outcome: ready_for_review');
      expect(done.messages.at(-1).text).toBe('انتهيت.');
      expect(prompts.at(-1)).toContain('nothing was merged');
      const detail = await application.runtime.detail(owner(), task!.id);
      expect(detail.task.status).toBe('completed');
      const project = (await application.coding.workspace(owner())).projects[0]!;
      expect(await readFile(join(project.path, 'src', 'sum.mjs'), 'utf8')).toContain('a - b');
    });
    it('cancels the task when the owner refuses', async () => {
      script = [change()];
      const waiting = await ask('أصلح مشروعي مرة أخرى');
      const taskId = (await tasks()).find(item => item.status === 'waiting_approval')!.id;
      await approve(waiting, false);
      expect((await application.runtime.detail(owner(), taskId)).task.status).toBe('cancelled');
      expect(prompts.at(-1)).toContain('refused');
    });
    it('cancels the task when the conversation is stopped before approval', async () => {
      script = [change()];
      const waiting = await ask('أصلح المشروع الآن');
      const taskId = (await tasks()).find(item => item.status === 'waiting_approval')!.id;
      expect((await api('POST', `/api/chat/conversations/${waiting.id}/cancel`, {})).statusCode).toBe(200);
      expect((await application.runtime.detail(owner(), taskId)).task.status).toBe('cancelled');
    });
    it('stops the running work when the conversation is stopped', async () => {
      let release = () => {};
      holdSandbox = new Promise(resolve => { release = resolve; });
      script = [change()];
      const waiting = await ask('أصلح المشروع الآن من فضلك');
      const taskId = (await tasks()).find(item => item.status === 'waiting_approval')!.id;
      await api('POST', `/api/chat/conversations/${waiting.id}/approve`, { approvalId: waiting.approval.id, approved: true });
      for (let attempt = 0; attempt < 200 && (await application.runtime.detail(owner(), taskId)).task.status === 'waiting_approval'; attempt++) await delay(25);
      expect((await api('POST', `/api/chat/conversations/${waiting.id}/cancel`, {})).statusCode).toBe(200);
      holdSandbox = null; release();
      for (let attempt = 0; attempt < 200; attempt++) {
        const { task } = await application.runtime.detail(owner(), taskId);
        if (task.cancellationRequested || task.status === 'cancelled') break;
        await delay(25);
      }
      const { task } = await application.runtime.detail(owner(), taskId);
      expect(task.cancellationRequested || task.status === 'cancelled').toBe(true);
    });
    it('reports a mistyped request as a failure instead of crashing', async () => {
      script = [{ tool: 'code_change', url: 'not-an-id', text: 'أصلح الدالة المعطلة' }];
      const result = await ask('أصلح شيئًا');
      expect(result.status).toBe('idle');
      expect(prompts.at(-1)).toContain('مدخلات الأداة غير صالحة');
    });
  });

  describe('the owner\'s PC through a session grant', () => {
    const key = 'b'.repeat(64);
    let nonce = randomUUID(), localControl = true, password = false;
    let acks: { id: string; status: string; code: string }[] = [], commands: any[] = [], running = false, loop: Promise<void> | undefined;
    const frameFor = () => ({
      id: randomUUID(), targetKey: key, capturedAt: new Date().toISOString(), width: 400, height: 200,
      jpeg: Buffer.concat([Buffer.from([255, 216, 255]), Buffer.alloc(150), Buffer.from([255, 217])]).toString('base64'),
      elements: [
        { name: 'Open file', type: 'ControlType.Button', x: 100, y: 40, width: 100, height: 20, password: false },
        { name: 'Delete account', type: 'ControlType.Button', x: 10, y: 80, width: 80, height: 20, password: false },
        ...(password ? [{ name: '[password]', type: 'ControlType.Edit', x: 10, y: 120, width: 80, height: 20, password: true }] : []),
      ],
    });
    const poll = async (withFrame = true) => {
      const response = await application.app.inject({
        method: 'POST', url: '/api/windows/companion/poll', headers: { authorization: `Bearer ${deviceId}.${deviceKey}` },
        payload: { nonce: randomUUID(), sentAt: new Date().toISOString(), state: { approvalNonce: nonce, sessionId: 1, safeDesktop: true, localView: true, localControl, target: { key, mode: 'window', title: 'Fixture window', width: 400, height: 200 }, status: 'fixture' }, frame: withFrame ? frameFor() : null, ack: acks.shift() ?? null },
      });
      expect(response.statusCode).toBe(200);
      const command = response.json().command;
      if (command) { commands.push(command); acks.push({ id: command.id, status: 'applied', code: 'APPLIED' }); }
    };
    /** Stands in for the companion: it reports the window and confirms input. It sends nothing to the OS. */
    const startCompanion = () => { running = true; loop = (async () => { while (running) { await poll(); await delay(450); } })(); };
    const stopCompanion = async () => { running = false; await loop; };
    const grant = async (scope: 'view' | 'control', session = cookie) => {
      await poll(false);
      const response = await api('POST', `/api/windows/devices/${deviceId}/grants`, { scope, durationSeconds: 120, targetKey: key, approvalNonce: nonce }, session);
      expect(response.statusCode).toBe(200);
      await poll();
    };

    beforeAll(async () => {
      const pair = await api('POST', '/api/windows/pairing', {});
      const paired = await application.app.inject({ method: 'POST', url: '/api/windows/companion/pair', payload: { code: pair.json().code, name: 'Fixture device' } });
      deviceId = paired.json().deviceId; deviceKey = paired.json().deviceKey;
    });
    beforeEach(() => { nonce = randomUUID(); localControl = true; password = false; commands = []; acks = []; });

    it('asks the owner for a grant instead of reaching for the device', async () => {
      script = [{ tool: 'computer_view' }];
      const result = await ask('ماذا يظهر على كمبيوتري؟');
      expect(result.status).toBe('waiting_input');
      expect(result.secure.kind).toBe('hands_on');
      expect(result.secure.prompt).toContain('Groq');
      await api('POST', `/api/chat/conversations/${result.id}/cancel`, {});
    });
    it('honours a grant only for the session that holds it', async () => {
      const second = await application.app.inject({ method: 'POST', url: '/api/auth/sign-in/email', headers, payload: { email: 'assistant-tools@example.test', password: 'Assistant-Fixture-Password-42' } });
      const otherSession = (Array.isArray(second.headers['set-cookie']) ? second.headers['set-cookie'] : [second.headers['set-cookie']]).filter(Boolean).map(value => String(value).split(';')[0]).join('; ');
      expect(otherSession).not.toBe(cookie);
      await grant('view', otherSession);
      script = [{ tool: 'computer_view' }];
      const result = await ask('ماذا يظهر على كمبيوتري؟');
      expect(result.status).toBe('waiting_input');
      await api('POST', `/api/chat/conversations/${result.id}/cancel`, {});
    });
    it('reads the elements but never a password field', async () => {
      password = true;
      await grant('view');
      script = [{ tool: 'computer_view', text: 'ماذا ترى؟' }];
      startCompanion();
      await ask('ماذا يظهر على كمبيوتري؟');
      await stopCompanion();
      const prompt = prompts.at(-1)!;
      expect(prompt).toContain('"Open file"');
      expect(prompt).toContain('view only');
      expect(prompt).not.toContain('[password]');
      expect(prompt).toContain('The image was not read');
    });
    it('cannot act under a view grant', async () => {
      await grant('view');
      script = [{ tool: 'computer_view' }, { tool: 'computer_click', ref: 'w1' }];
      startCompanion();
      await ask('افتح الملف على كمبيوتري');
      await stopCompanion();
      expect(commands).toEqual([]);
      expect(prompts.at(-1)).toContain('هذا الإذن لا يسمح بالإدخال');
    });
    it('clicks an ordinary control where it actually is and audits the origin', async () => {
      await grant('control');
      script = [{ tool: 'computer_view' }, { tool: 'computer_click', ref: 'w1' }];
      startCompanion();
      await ask('افتح الملف على كمبيوتري');
      await stopCompanion();
      expect(commands).toHaveLength(1);
      expect(commands[0].action).toMatchObject({ type: 'click', x: 0.375, y: 0.25 });
      const events = (await api('GET', '/api/windows')).json().events;
      expect(events.find((event: any) => event.type === 'input_requested').detail.origin).toBe('assistant');
      expect(events.some((event: any) => event.type === 'assistant_view')).toBe(true);
    });
    it('stops at a sensitive control until the owner approves', async () => {
      await grant('control');
      script = [{ tool: 'computer_view' }, { tool: 'computer_click', ref: 'w2' }];
      startCompanion();
      const waiting = await ask('احذف الحساب من البرنامج');
      expect(waiting.status).toBe('waiting_approval');
      expect(commands).toEqual([]);
      await approve(waiting, true);
      await stopCompanion();
      expect(commands).toHaveLength(1);
    });
    it('does nothing when the owner refuses a sensitive control', async () => {
      await grant('control');
      script = [{ tool: 'computer_view' }, { tool: 'computer_click', ref: 'w2' }];
      startCompanion();
      const waiting = await ask('احذف الحساب من البرنامج');
      await approve(waiting, false);
      await stopCompanion();
      expect(commands).toEqual([]);
    });
    it('treats keys that can activate the focused control as sensitive', async () => {
      await grant('control');
      script = [{ tool: 'computer_key', text: 'Enter' }];
      startCompanion();
      const waiting = await ask('اضغط إدخال على كمبيوتري');
      expect(waiting.status).toBe('waiting_approval');
      await api('POST', `/api/chat/conversations/${waiting.id}/cancel`, {});
      await stopCompanion();
      expect(commands).toEqual([]);
    });
    it('will not type into a window that has a password field', async () => {
      password = true;
      await grant('control');
      script = [{ tool: 'computer_type', text: 'نص تجريبي' }];
      startCompanion();
      await ask('اكتب في البرنامج');
      await stopCompanion();
      expect(commands).toEqual([]);
      expect(prompts.at(-1)).toContain('كلمة مرور');
    });
  });
});
