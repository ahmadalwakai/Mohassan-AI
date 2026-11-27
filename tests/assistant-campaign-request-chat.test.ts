import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentAction, AgentBrowser, SearchProvider } from '@mohassan/browser';
import { createDatabase, migrate } from '@mohassan/database';
import { createCommandChatControl, type CommandChatConfig } from '../apps/server/src/command-chat.js';
import type { AdsBrief, AdsModelChat } from '../apps/server/src/assistant/ads-model-chat.js';

/**
 * Campaign requests through the real chat controller with no chat model (assistant/campaign-request.ts). With the owner's Ads
 * model configured they reach it, not the calculator, a refused search or the letter writer; without it they get the Ads
 * route's own «not available» reply. The wording is this test's own.
 */
const owner = 'isolated-campaign-owner';
let database: Awaited<ReturnType<typeof createDatabase>> | undefined;
let control: Awaited<ReturnType<typeof createCommandChatControl>> | undefined;
afterEach(async () => { await control?.shutdown(); await database?.close(); control = undefined; database = undefined; });

async function harness(withAdsModel: boolean, overrides: Pick<CommandChatConfig, 'adsModel' | 'chromeExtension' | 'tools'> = {}) {
  database = await createDatabase();
  await migrate(database.db);
  const searched: string[] = [], actions: AgentAction[] = [], toAds: string[] = [];
  const browser = {
    setCheckpointStore() {}, async bindAccount() {},
    async hasPage() { return false; },
    async observe() { throw new Error('No page in this test.'); },
    async act(_owner: string, _id: string, action: AgentAction) { actions.push(action); throw new Error(`Unexpected browser action: ${action.kind}`); },
    async close() {},
  } as unknown as AgentBrowser;
  const searchProvider: SearchProvider = { name: 'isolated-campaign-search', async search(query) { searched.push(query); return []; } };
  const adsModel: AdsModelChat = { async handle(request) { toAds.push(request); return { status: 'partial', text: 'ADS PATH REACHED' }; } };
  control = await createCommandChatControl(database.db, { browser, models: { fast: [], deep: [], vision: '' }, searchProvider,
    ...(withAdsModel ? { adsModel } : {}), ...overrides });
  return { control, searched, actions, toAds };
}
async function ask(goal: string, withAdsModel: boolean) {
  const { control, searched, actions, toAds } = await harness(withAdsModel);
  const { id } = await control.create(owner, { goal });
  await control.settled(id);
  const detail = await control.detail(owner, id);
  expect(detail.error).toBeNull();
  return { reply: detail.messages.filter(message => message.role === 'assistant').at(-1)!.text, searched, actions, toAds };
}

describe('campaign requests keep the Ads path', () => {
  it.each([
    ['a budget the calculator used to take', 'Ads for my tree surgery firm, area: Derby, 35 pounds a week, I want phone calls'],
    ['a business brief the search used to refuse', 'I have a nail salon in Bristol, want more clients, spend 10 pounds per day'],
    ['«advertise» the search used to refuse', 'Advertise my dog grooming business in Bath, 50 pounds a month'],
    ['«create a campaign for» the letter writer used to take', 'create a campaign for petfood.example selling cat food in Leeds, budget 20 pounds a day'],
  ])('reaches the owner\'s Ads model: %s', async (_case, goal) => {
    const { reply, searched, actions, toAds } = await ask(goal, true);
    expect(toAds).toEqual([goal]);
    expect(reply).toBe('ADS PATH REACHED');
    expect(searched).toEqual([]);
    expect(actions).toEqual([]);
  });

  // Draft details and prohibition adapted from dev-google-ads-171, retrieved 2026-11-27.
  // https://github.com/ahmadalwakai/Mohassan-AI/blob/a258b3d47e39b5a2c03c71d4a9eb01107ae3d97f/tests/fixtures/agent-capability-bench/development.json
  it.each([
    { transport: 'chrome', asksFirst: false },
    { transport: 'api', asksFirst: true },
  ] as const)('keeps an unpublished draft in chat with $transport selected', async ({ transport, asksFirst }) => {
    const draft = 'Google Ads search campaign draft for violin lessons in York at £7 daily.';
    const keepUnpublished = 'Keep it unpublished.';
    const brief: AdsBrief = { url: null, service: null, serviceChoices: [], locations: ['York'], country: 'GB',
      budget: { amount: '7', currency: '£', period: 'day' }, goal: null, asked: ['service'], rounds: 1 };
    const unused = async (): Promise<never> => { throw new Error('Unexpected Ads port call'); };
    const queueCampaign = vi.fn(unused);
    const createPaused = vi.fn(unused);
    const handle = vi.fn<AdsModelChat['handle']>(async (_request, _io, saved) => {
      if (asksFirst && !saved) return { status: 'waiting_user', text: 'What lessons should the campaign promote?', brief };
      return { status: 'completed', text: draft, campaign: 'SERVICE: violin lessons' };
    });
    const { control } = await harness(true, {
      adsModel: { handle },
      chromeExtension: {
        status: async () => ({ preferredTransport: transport, connected: true, binding: null, lastSeenAt: null, latestJob: null }),
        queueCampaign,
      },
      tools: { ads: { status: unused, report: unused, draft: unused, createPaused } },
    });
    const goal = asksFirst ? 'Build a Google Ads search campaign in York at £7 daily.' : `Build a Google Ads search campaign draft for violin lessons in York at £7 daily. ${keepUnpublished}`;
    const { id } = await control.create(owner, { goal });
    await control.settled(id);
    if (asksFirst) {
      expect((await control.detail(owner, id)).status).toBe('waiting_user');
      await control.send(owner, id, { text: `Violin lessons. ${keepUnpublished}` });
      await control.settled(id);
      expect(handle).toHaveBeenCalledTimes(2);
    }
    const detail = await control.detail(owner, id);
    expect(detail.error).toBeNull();
    expect(detail.status).toBe('idle');
    expect(detail.messages.at(-1)?.text).toContain(draft);
    expect(queueCampaign).not.toHaveBeenCalled();
    expect(createPaused).not.toHaveBeenCalled();
  });

  it('stops a waiting letter card when the next message is a whole campaign request, then takes that request as a new one', async () => {
    const { control, toAds } = await harness(true);
    const { id } = await control.create(owner, { goal: 'اكتب رسالة بريد احترافية' });
    await control.settled(id);
    expect((await control.detail(owner, id)).status).toBe('waiting_user');
    const campaign = 'create a campaign for petfood.example selling cat food in Leeds, budget 20 pounds a day';
    await control.send(owner, id, { text: campaign });
    await control.settled(id);
    const stopped = (await control.detail(owner, id)).messages.filter(message => message.role === 'assistant').at(-1)!.text;
    expect(stopped).toBe('I stopped the letter: your last message is a new advertising campaign request, not an answer to its questions. Send the campaign request again and I will start it as a new request.');
    expect(stopped).not.toContain('[اكتب التفاصيل هنا]');
    expect(toAds).toEqual([]);
    await control.send(owner, id, { text: campaign });
    await control.settled(id);
    expect((await control.detail(owner, id)).messages.filter(message => message.role === 'assistant').at(-1)!.text).toBe('ADS PATH REACHED');
    expect(toAds).toEqual([campaign]);
  });

  it('still writes the letter from an ordinary answer to its card', async () => {
    const { control } = await harness(false);
    const { id } = await control.create(owner, { goal: 'اكتب رسالة بريد احترافية' });
    await control.settled(id);
    await control.send(owner, id, { text: 'إلى أحمد، لتأكيد موعد اجتماع الثلاثاء، مع التحية من سارة' });
    await control.settled(id);
    const letter = (await control.detail(owner, id)).messages.filter(message => message.role === 'assistant').at(-1)!.text;
    expect(letter).toMatch(/^\*\*الموضوع:\*\*/u);
    expect(letter).not.toMatch(/^توقفت/u);
  });

  it('gets the Ads route\'s own reply when no Ads model is configured, never a letter card or a calculation', async () => {
    const { reply, searched } = await ask('create a campaign for petfood.example selling cat food in Leeds, budget 20 pounds a day', false);
    expect(reply).toBe('I haven’t performed this request. Preparing the advertising campaign is unavailable with the capabilities configured for this conversation.');
    expect(searched).toEqual([]);
    const budget = await ask('Ads for my tree surgery firm, area: Derby, 35 pounds a week, I want phone calls', false);
    expect(budget.reply).toBe('I haven’t performed this request. Preparing the advertising campaign is unavailable with the capabilities configured for this conversation.');
  });
});
