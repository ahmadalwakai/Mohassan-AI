import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { builtinSkills, compileInstructionContext, inspectSkill, routeInstructionSkills, sha256 } from '@mohassan/skills';
import { createApplication } from '../apps/server/src/app.js';
import { ADS_DRAFT_NOTE, ADS_LIMITS, ADS_SKILL_SLUG, adsLength, checkAdsDraft } from '../apps/server/src/assistant/ads-check.js';
import { systemPrompt } from '../apps/server/src/assistant/brain.js';
import { createMockGroq } from './fixtures/planning.js';
import { fixtureLocalModel } from './fixtures/local-model.js';

const repeat = (kind: string, count: number) => Array.from({ length: count }, (_, index) => `${kind}: Text ${index + 1}`);
const ad = [...repeat('H', 3), ...repeat('D', 2)];

describe('ads_check counts what models miscount', () => {
  it('rejects the over-limit headlines from the Glasgow draft', () => {
    const long = 'Man and Van Glasgow Same Day Moves!', other = 'Affordable House Removals Glasgow';
    expect([long.length, other.length]).toEqual([35, 33]);
    const report = checkAdsDraft([`H: ${long}`, `H: ${other}`, 'H: Fast Glasgow Removals', ...repeat('D', 2)].join('\n'));
    expect(report.passed).toBe(false);
    expect(report.text).toContain('headline 1 is 35 characters, limit 30');
    expect(report.text).toContain('headline 2 is 33 characters, limit 30');
    expect(report.text).not.toContain('headline 3');
  });
  it('accepts exactly the limit and rejects one more', () => {
    const line = (kind: string, size: number) => `${kind}: ${'a'.repeat(size)}`;
    const draft = (headline: number, description: number, path: number) => checkAdsDraft([line('H', headline), 'H: b', 'H: c', line('D', description), 'D: e', line('P', path)].join('\n')).passed;
    expect(draft(ADS_LIMITS.headline, ADS_LIMITS.description, ADS_LIMITS.path)).toBe(true);
    expect(draft(ADS_LIMITS.headline + 1, ADS_LIMITS.description, ADS_LIMITS.path)).toBe(false);
    expect(draft(ADS_LIMITS.headline, ADS_LIMITS.description + 1, ADS_LIMITS.path)).toBe(false);
    expect(draft(ADS_LIMITS.headline, ADS_LIMITS.description, ADS_LIMITS.path + 1)).toBe(false);
  });
  it('counts Arabic as one and Chinese, Japanese and Korean as two', () => {
    expect(adsLength('نقل أثاث')).toBe(8);
    expect(adsLength('搬家')).toBe(4);
    expect(adsLength('引っ越し')).toBe(8);
    expect(adsLength('이사')).toBe(4);
  });
  it('splits display paths written together', () => {
    expect(checkAdsDraft('P: moving/glasgow').approved).toBe(checkAdsDraft('P: moving\nP: glasgow').approved);
    expect(checkAdsDraft('P: a/b/c').text).toContain('at most 2');
  });
  it('enforces how many items an ad holds', () => {
    expect(checkAdsDraft(ad.join('\n')).passed).toBe(true);
    expect(checkAdsDraft([...repeat('H', 2), ...repeat('D', 2)].join('\n')).text).toContain('at least 3');
    expect(checkAdsDraft([...repeat('H', 16), ...repeat('D', 2)].join('\n')).text).toContain('at most 15');
    expect(checkAdsDraft([...repeat('H', 3), ...repeat('D', 1)].join('\n')).text).toContain('at least 2');
    expect(checkAdsDraft([...repeat('H', 3), ...repeat('D', 5)].join('\n')).text).toContain('at most 4');
    expect(checkAdsDraft([...ad, ...repeat('P', 3)].join('\n')).text).toContain('at most 2');
  });
  it('allows the current match types and rejects broad match modifier', () => {
    expect(checkAdsDraft('K: moving services\nK: "moving services"\nK: [moving services]').passed).toBe(true);
    expect(checkAdsDraft('K: +moving +services').text).toContain('broad match modifier');
    expect(checkAdsDraft('K: moving +services').passed).toBe(false);
    expect(checkAdsDraft('N: free\nN: jobs').approved).toContain('الكلمات السلبية');
    expect(checkAdsDraft('N: +jobs').passed).toBe(false);
  });
  it('rejects claims nobody stated, and keeps the ones the owner or the page did', () => {
    const draft = 'H: Free Quotes\nH: 24/7 Service\nH: Local Movers\nD: Save 20% today.\nD: Call us now.';
    const invented = checkAdsDraft(draft, 'حملة لشركة نقل');
    expect(invented.passed).toBe(false);
    for (const claim of ['"Free"', '"24/7"', '"Save"', '"20%"']) expect(invented.text).toContain(claim);
    expect(checkAdsDraft(draft, 'We offer free quotes, 24/7 service and save 20% in winter.').passed).toBe(true);
    expect(checkAdsDraft('H: نقل مجاني\nH: اثنان\nH: ثلاثة\nD: واحد\nD: اثنان', 'شركة نقل').passed).toBe(false);
    expect(checkAdsDraft(draft).passed).toBe(true);
    for (const invented of ['خبرة 10 سنوات', 'خصم خاص لأول طلب', '20% off', 'Big discount']) expect(checkAdsDraft(`H: ${invented}`, 'شركة نقل').text).toContain('was not stated');
  });
  it('hands a failed draft back so the model can fix it', () => {
    expect(checkAdsDraft('H: One\nD: Two').text).toContain('The draft you sent:\nH: One\nD: Two');
  });
  it('never lets anything through unread', () => {
    expect(checkAdsDraft('').passed).toBe(false);
    expect(checkAdsDraft('Headline one is great\nH: ok').text).toContain('line not understood');
    expect(checkAdsDraft('H1: One\n- H2: Two\nH3: three\nD1: Four\nD2: Five').passed).toBe(true);
    expect(checkAdsDraft('H: Same\nH: same\nH: Other\nD: One\nD: Two').text).toContain('repeats');
    expect(checkAdsDraft('H: {KeyWord:Removals}\nH: Two\nH: Three\nD: One\nD: Two').text).toContain('cannot be counted');
  });
});

describe('the google-ads-campaign skill', () => {
  const skill = builtinSkills.find(entry => entry.contract.slug === ADS_SKILL_SLUG)!;
  const metadata = (entry: typeof skill) => ({ id: entry.contract.slug, slug: entry.contract.slug, name: entry.contract.name, description: entry.contract.description, category: entry.contract.category, version: entry.contract.version, contentHash: sha256(entry.instructions) });

  it('stays instruction level and declares the money it can touch', () => {
    expect(skill.contract).toMatchObject({ level: 'instruction', sideEffects: 'financial', category: 'marketing' });
  });
  it('sends campaigns through the checked path, never the browser', () => {
    expect(skill.instructions).toContain('Never build, publish, enable or change a campaign or budget through the browser');
    expect(skill.instructions).not.toContain('hands_on');
  });
  it('passes the same inspection as an imported skill', () => {
    const { verdict, findings } = inspectSkill(skill.contract, [{ path: 'SKILL.md', kind: 'instructions', content: skill.instructions }]);
    expect(findings).toEqual([]);
    expect(verdict).toBe('pass');
  });
  it('fits whole in the default context budget', () => {
    const file = { path: 'SKILL.md', kind: 'instructions', content: skill.instructions, contentHash: sha256(skill.instructions) };
    const compiled = compileInstructionContext([{ metadata: metadata(skill), files: [file] }], 'google ads');
    expect(compiled.sources).toMatchObject([{ truncated: false }]);
  });
  it.each(['جهز لي حملة Google Ads لنقل الأثاث في غلاسكو', 'أريد حملة إعلانات جوجل', 'اكتب إعلان لخدمة النقل', 'write google ads headlines for my van hire', 'اعلانات قوقل لشركتي'])('is chosen first for: %s', goal => {
    const routed = routeInstructionSkills(goal, builtinSkills.map(metadata));
    expect(routed[0]?.slug).toBe(ADS_SKILL_SLUG);
  });
  it('is not chosen for unrelated requests', () => {
    expect(routeInstructionSkills('ترجم هذه الفقرة إلى الإنجليزية', builtinSkills.map(metadata)).map(entry => entry.slug)).not.toContain(ADS_SKILL_SLUG);
  });
  it('adds nothing to the prompt until the skill brings the tool', () => {
    expect(systemPrompt('2026-11-06', true, false, ['memory_search'])).not.toContain('ads_check');
    expect(systemPrompt('2026-11-06', true, false, ['ads_check'])).toContain('ads_check:');
  });
});

describe('the assistant with the skill active', () => {
  const blank = { thought: null, plan: null, note: null, url: null, ref: null, text: null, submit: null, options: null, sensitive: null, outcome: null };
  const passing = ['H: Glasgow Removals', 'H: Careful Moves', 'H: Local Quotes', 'D: Local movers you can trust.', 'D: Book your move today.', 'K: "man and van glasgow"'].join('\n');
  const secret = 'google-ads-fixture-internal-secret-000001', origin = 'http://127.0.0.1:3000', setupToken = 'google-ads-fixture-setup-token-000001';

  async function scenario(script: Record<string, unknown>[], goal: string, activate = true) {
    const directory = await mkdtemp(join(tmpdir(), 'mohassan-google-ads-'));
    const mock = createMockGroq(), seen: { system: string; prompt: string; tools: string[] }[] = [];
    let application: Awaited<ReturnType<typeof createApplication>> | undefined, cookie = '';
    const scripted: typeof fetch = async (input, init) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (body.response_format?.json_schema?.name !== 'decision') return mock.fetch(input, init);
      seen.push({ system: body.messages[0].content, prompt: body.messages.at(-1).content, tools: body.response_format.json_schema.schema.properties.tool.enum });
      const next = script.shift() ?? { tool: 'answer', text: 'انتهيت.', outcome: 'done' };
      if (typeof next.rejectedAs === 'string') return Response.json({ error: { code: 'json_validate_failed', message: 'Generated JSON does not match the expected schema.', failed_generation: next.rejectedAs } }, { status: 400 });
      const decision = { ...blank, ...next };
      return Response.json({ model: body.model, choices: [{ message: { content: JSON.stringify(decision) }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20 } });
    };
    const headers = () => ({ 'x-mohassan-internal': secret, origin, ...(cookie ? { cookie } : {}) });
    try {
      application = await createApplication({ authSecret: 'google-ads-fixture-auth-secret-00000001', internalSecret: secret, setupToken, webOrigin: origin, production: false, runWorker: false, skillEngineEnabled: true, codingAllowedRoots: [directory], browserProfileDir: join(directory, 'profile'), browserChannel: null, ...fixtureLocalModel(scripted) });
      const app = application.app, account = { email: 'google-ads@example.test', password: 'Google-ads-fixture-password-42' };
      await app.inject({ method: 'POST', url: '/api/setup', headers: headers(), payload: { ...account, name: 'Ads fixture', setupToken } });
      const login = await app.inject({ method: 'POST', url: '/api/auth/sign-in/email', headers: headers(), payload: account });
      cookie = [login.headers['set-cookie']].flat().filter(Boolean).map(value => String(value).split(';')[0]).join('; ');
      const listed = (await app.inject({ url: '/api/skills?category=marketing', headers: headers() })).json();
      let skill = listed.items.find((item: { slug: string }) => item.slug === ADS_SKILL_SLUG);
      expect(skill.status).toBe('quarantined');
      if (activate) {
        skill = (await app.inject({ method: 'POST', url: `/api/skills/${skill.id}/inspect`, headers: headers(), payload: { expectedRevision: skill.revision } })).json().skill;
        const activated = await app.inject({ method: 'POST', url: `/api/skills/${skill.id}/activate`, headers: headers(), payload: { expectedRevision: skill.revision, approve: true } });
        expect(activated.statusCode, activated.body).toBe(200);
      }
      const created = await app.inject({ method: 'POST', url: '/api/chat/conversations', headers: headers(), payload: { goal } });
      expect(created.statusCode, created.body).toBe(200);
      await application.chat.settled(created.json().id);
      const detail = (await app.inject({ url: `/api/chat/conversations/${created.json().id}`, headers: headers() })).json();
      return { detail, seen };
    } finally {
      await application?.app.close();
      const target = await realpath(directory), base = await realpath(tmpdir()), inside = relative(base, target);
      if (isAbsolute(inside) || inside.startsWith('..') || !inside.startsWith('mohassan-google-ads-')) throw new Error('Unsafe fixture cleanup');
      await rm(target, { recursive: true, force: true });
    }
  }

  it('shows the model the program\'s count and lets a fixed draft finish', async () => {
    const { detail, seen } = await scenario([
      { tool: 'ads_check', text: 'H: Man and Van Glasgow Same Day Moves!\nH: Two\nH: Three\nD: One\nD: Two' },
      { tool: 'ads_check', text: passing },
      { tool: 'answer', text: 'هذا شرح قصير.', outcome: 'done' },
    ], 'جهز حملة Google Ads لنقل الأثاث في غلاسكو');
    expect(seen[0].tools).toContain('ads_check');
    expect(seen[0].prompt).toContain('google-ads-campaign');
    // The program removes the forbidden "!" itself, then reports the length of what is left and the unsupported claim.
    expect(seen[1].prompt).toContain('headline 1 is 34 characters, limit 30');
    expect(seen[1].prompt).toContain('"Same Day" was not stated');
    expect(seen[2].prompt).toContain('PASS:');
    expect(seen[1].tools).toContain('ads_check');
    expect(seen[2].tools).not.toContain('ads_check');
    expect(seen).toHaveLength(3);
    expect(detail.messages.at(-1).text).toBe(`هذا شرح قصير.\n\n${checkAdsDraft(passing).approved}${ADS_DRAFT_NOTE}`);
  }, 60_000);

  it('prints no second copy when the reply already holds every approved line', async () => {
    const { detail } = await scenario([
      { tool: 'ads_check', text: passing },
      { tool: 'answer', text: passing, outcome: 'done' },
    ], 'اكتب حملة Google Ads');
    expect(detail.messages.at(-1).text).toBe(`${passing}${ADS_DRAFT_NOTE}`);
  }, 60_000);

  // The local model's grammar keeps every field, so a rejected request is never mined for a
  // decision: it fails closed, with no second call, even when its text looks complete.
  it('never acts on text from a request the local model rejected, and does not call again', async () => {
    const { detail, seen } = await scenario([
      { rejectedAs: JSON.stringify({ tool: 'ads_check', text: passing }) },
      { tool: 'answer', text: 'شرح.', outcome: 'done' },
    ], 'اكتب حملة Google Ads');
    expect(seen).toHaveLength(1);
    expect(detail.status).toBe('failed');
  }, 60_000);

  it('still fails when the rejected text is cut off', async () => {
    const { detail, seen } = await scenario([{ rejectedAs: '{"tool":"ads_check","text":"H: Glas' }], 'اكتب حملة Google Ads');
    expect(seen).toHaveLength(1);
    expect(detail.status).toBe('failed');
  }, 60_000);

  it('stays silent about the draft in a reply that never reached a check', async () => {
    const { detail } = await scenario([
      { tool: 'answer', text: 'حد العنوان 30 حرفًا.', outcome: 'done' },
      { tool: 'answer', text: 'حد العنوان 30 حرفًا.', outcome: 'done' },
    ], 'ما حد عنوان Google Ads؟');
    expect(detail.messages.at(-1).text).toBe('حد العنوان 30 حرفًا.');
  }, 60_000);

  it('sends a done answer back once when nothing was checked', async () => {
    const { detail, seen } = await scenario([
      { tool: 'answer', text: 'العنوان: Man and Van Glasgow Same Day Moves!', outcome: 'done' },
      { tool: 'ads_check', text: passing },
      { tool: 'answer', text: 'تم الفحص.', outcome: 'done' },
    ], 'اكتب حملة Google Ads');
    expect(seen[1].prompt).toContain('run ads_check on them first');
    expect(detail.messages.at(-1).text).toBe(`تم الفحص.\n\n${checkAdsDraft(passing).approved}${ADS_DRAFT_NOTE}`);
  }, 60_000);

  it('offers no ads tool while the skill is not activated', async () => {
    const { seen } = await scenario([{ tool: 'answer', text: 'انتهيت.', outcome: 'done' }], 'جهز حملة Google Ads', false);
    expect(seen[0].tools).not.toContain('ads_check');
    expect(seen[0].system).not.toContain('ads_check');
  }, 60_000);
});
