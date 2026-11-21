/**
 * Live check of the model-free browser hands on real public sites, without the server or a database.
 * Usage: npx tsx scripts/hands-live.ts [index]; HANDS_CHROME=1 uses real Chrome in a window (headless search engines block).
 * Each conversation runs its owner sentences in order on one real browser page and prints the reply.
 * Approvals and holds are reported, never granted.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentBrowser, type AgentAuthority } from '@mohassan/browser';
import { cookieRejectButton, situation } from '../apps/server/src/assistant/brain.js';
import { parseHands, runHands, webQuestion, type HandsPlan } from '../apps/server/src/assistant/hands.js';

const conversations: string[][] = [
  ['ابحث عن winter tyres', 'افتح النتيجة الأولى ثم اقرأ الصفحة', 'اقرأ المزيد'],
  ['ابحث في ويكيبيديا عن الخوارزمي', 'اقرأ الصفحة'],
  ['افتح gov.uk وابحث عن passport renewal', 'افتح النتيجة الثانية'],
  ['search for python dataclasses on docs.python.org then open the first result'],
  ['افتح developer.mozilla.org واضغط على رابط Blog', 'ارجع'],
  ['ابحث في يوتيوب عن طريقة تغيير إطار السيارة', 'افتح الفيديو الأول'],
  ['لخّص لي أهم أخبار اليوم', 'اقرأ الخبر الثاني'],
  ['آخر أخبار اليمن من الجزيرة', "what's the news today"],
  // Questions with no browser word: the browser must start by itself (webQuestion).
  ['كم سعر الذهب اليوم؟'],
  ['متى مباراة الهلال القادمة'],
  ['what is the weather in London today'],
  ['دورلي على سعر الدولار مقابل الجنيه المصري'],
  // Follow-ups: the previous question's topic joins the new one.
  ['كم سعر الذهب اليوم؟', 'وكم سعره في مصر؟'],
  ['الطقس في الرياض اليوم', 'وبكرة؟'],
  // The hidden browser gets a human check from DuckDuckGo: the search must move to Wikipedia without pausing.
  ['ما عاصمة اليابان؟'],
  ['who wrote the novel One Hundred Years of Solitude'],
];

const browser = new AgentBrowser({ profileDir: await mkdtemp(join(tmpdir(), 'hands-live-')), channel: process.env.HANDS_CHROME === '1' ? 'chrome' : null, headless: process.env.HANDS_CHROME !== '1' || process.env.HANDS_HIDDEN === '1' });
const controller = new AbortController();
const authority = (): AgentAuthority => ({ signal: controller.signal, assertActive: async () => {}, dispatched: async permit => permit.id, completed: async () => {} });
const owner = 'live-owner';
let failures = 0;

const only = process.argv[2] === undefined ? null : Number(process.argv[2]);
for (const [index, sentences] of conversations.entries()) {
  if (only !== null && index !== only) continue;
  const id = `live-${index}`;
  for (const [turn, sentence] of sentences.entries()) {
    const started = Date.now();
    const steps = parseHands(sentence) ?? webQuestion(sentence, sentences.slice(0, turn));
    console.log(`\n### [${id}] ${sentence}`);
    if (!steps) { console.log('NOT PARSED'); failures++; continue; }
    const plan: HandsPlan = { steps, next: 0 };
    try {
      const outcome = await runHands(plan, {
        page: async () => (await browser.hasPage(owner, id)) ? (await browser.observe(owner, id)).page : null,
        act: async action => (await browser.act(owner, id, action, authority())).page,
        prepare: action => browser.prepareAction(owner, id, action),
        settle: async page => {
          for (let round = 0; round < 3; round++) {
            const button = situation(page) === 'cookies' ? cookieRejectButton(page) : undefined;
            if (!button) break;
            console.log(`  (cookies: ${button.label})`);
            page = (await browser.act(owner, id, { kind: 'click', ref: button.ref }, authority())).page;
          }
          const kind = situation(page);
          if (kind !== 'normal') console.log(`  (page situation: ${kind})`);
          return page;
        },
        step: async label => { console.log(`  · ${label}`); },
        approve: async (_action, permit, label) => { console.log(`  APPROVAL NEEDED: ${label} → ${permit.method} ${permit.url}`); },
        hold: async (held, label) => { console.log(`  HELD: ${label} → ${held.method} ${held.url}`); },
      });
      const page = (await browser.hasPage(owner, id)) ? (await browser.observe(owner, id)).page : null;
      console.log(`  at: ${page?.url ?? '-'}  (${Date.now() - started} ms)`);
      if (outcome.kind === 'paused') { console.log('  PAUSED'); failures++; continue; }
      console.log(`  status: ${outcome.status}\n${outcome.text.split('\n').map(line => `  | ${line}`).join('\n')}`);
      if (outcome.status !== 'completed') failures++;
    } catch (error) {
      failures++;
      console.log(`  ERROR: ${error instanceof Error ? `${(error as { code?: string }).code ?? ''} ${error.message}` : String(error)}`);
    }
  }
}
await browser.close?.();
console.log(`\nfailures: ${failures}`);
process.exit(0);
