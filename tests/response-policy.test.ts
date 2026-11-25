import { describe, expect, it } from 'vitest';
import { decideResponsePolicy, POLICY_RECENT_TURNS, type ResponsePolicyInput } from '../apps/server/src/assistant/response-policy.js';

const decide = (text: string, signals: Omit<ResponsePolicyInput, 'text'> = {}) => decideResponsePolicy({ text, ...signals });

describe('response policy', () => {
  it('uses the existing route and speech act for answers that can fit on one line', () => {
    expect(decide('Convert 16 miles to kilometres.', { route: 'compute', handler: 'local_computation' }))
      .toMatchObject({ length: 'short', structure: 'prose', followUp: 'none', workMode: 'interactive' });
    expect(decide('تسلم يا باشا')).toMatchObject({ length: 'short', language: 'ar', dialect: 'egyptian' });
  });

  it('keeps the existing length for an uncertain request', () => {
    expect(decide('Tell me about rail travel.', { currentLength: 'long' }))
      .toMatchObject({ length: 'long', preserveCurrentLength: true });
    expect(decide('What is your capability for a task like mine?'))
      .toMatchObject({ length: 'medium', preserveCurrentLength: true });
  });

  it('honours brief and detailed instructions independently of the route', () => {
    expect(decide('Explain why stars twinkle, briefly.', { currentLength: 'long' }))
      .toMatchObject({ length: 'short', preserveCurrentLength: false, structure: 'prose' });
    expect(decide('What is the answer to 5 + 8? Answer in detail.', { route: 'compute', channel: 'phone' }))
      .toMatchObject({ length: 'long', preserveCurrentLength: false });
    expect(decide('قارن الفكرتين بالتفصيل.')).toMatchObject({ length: 'long', language: 'ar' });
    expect(decide('اشرح الفكرة، باختصار.')).toMatchObject({ length: 'short', language: 'ar' });
  });

  it('keeps sources and fields even when the requested answer is short', () => {
    expect(decide('Find the page. Reply briefly. Return the page title and source link.'))
      .toMatchObject({ length: 'short', requiredFields: ['title', 'link'] });
    expect(decide('Who designed the bridge? Cite the source.', { currentLength: 'long' }))
      .toMatchObject({ length: 'long', preserveCurrentLength: true });
    expect(decide('Where is the main trailhead and what warnings apply?', { channel: 'phone' }))
      .toMatchObject({ length: 'medium', preserveCurrentLength: true });
  });

  it('assigns structure from content, unless the user specifies a format', () => {
    expect(decide('List three types of wool.')).toMatchObject({ length: 'medium', structure: 'list' });
    expect(decide('How do I install a new showerhead?')).toMatchObject({ structure: 'steps' });
    expect(decide('How does gravity work?')).toMatchObject({ length: 'medium', structure: 'prose' });
    expect(decide('Compare the two phones by costs and benefits.')).toMatchObject({ length: 'long', structure: 'sections' });
    expect(decide('What did the inspection find? Use three headings.')).toMatchObject({ structure: 'sections' });
    expect(decide('List the three kinds in one paragraph.')).toMatchObject({ structure: 'prose' });
    expect(decide('اعرض الفروق في جدول.')).toMatchObject({ structure: 'requested' });
  });

  it('honours explicit language and dialect alongside the current turn dialect', () => {
    expect(decide('ازاي أبدأ؟')).toMatchObject({ language: 'ar', dialect: 'egyptian' });
    expect(decide('Explain this concept. Reply in Arabic.', { language: 'en', dialect: 'levantine' }))
      .toMatchObject({ language: 'ar', dialect: 'levantine' });
    expect(decide('Explain this in Egyptian Arabic.')).toMatchObject({ language: 'ar', dialect: 'egyptian' });
    expect(decide('Explain taxation in Egyptian history.')).toMatchObject({ language: 'en', dialect: null });
    expect(decide('شو الموضوع؟ جاوب بالإنجليزية.', { language: 'ar', dialect: 'levantine' }))
      .toMatchObject({ language: 'en', dialect: null });
  });

  it('asks one blocking clarification and skips already pending or answered ones', () => {
    expect(decide('How far is it?', { route: 'clarify', clarification: 'needed' }))
      .toMatchObject({ followUp: 'ask', length: 'short', structure: 'prose' });
    expect(decide('How far is it?', { route: 'clarify', clarification: 'pending' }).followUp).toBe('none');
    expect(decide('From London to Liverpool.', { route: 'clarify', clarification: 'answered' }).followUp).toBe('none');
    expect(decide("How far is it? Don't ask me any questions.", { clarification: 'needed' }).followUp).toBe('none');
  });

  it('offers only a requested or supported next step', () => {
    expect(decide('What time is it in Accra?').followUp).toBe('none');
    expect(decide('Explain this result and give me one next step.').followUp).toBe('offer');
    expect(decide('Walk me through the repair and recommend a single check afterward.').followUp).toBe('offer');
    expect(decide('Check whether the certificate has expired.', { concreteNextStep: 'Renew the certificate from its issuer.' }))
      .toMatchObject({ followUp: 'offer', nextStep: 'Renew the certificate from its issuer.' });
    expect(decide('Check whether it has expired.', { clarification: 'needed', concreteNextStep: 'Renew the certificate.' }))
      .toMatchObject({ followUp: 'ask', nextStep: null });
  });

  it('requires an explicit history trigger even after a long conversation', () => {
    expect(decide('When was the bridge renovated?', { previousTurns: 200 }).contextScope).toBe('recent');
    expect(decide('What did I ask in my first message?', { previousTurns: POLICY_RECENT_TURNS }).contextScope).toBe('recent');
    expect(decide('What did I ask in my first message?', { previousTurns: POLICY_RECENT_TURNS + 1 }))
      .toMatchObject({ contextScope: 'full', contextTrigger: 'older_reference' });
    expect(decide('لخص ما ناقشنا.', { previousTurns: 10 }))
      .toMatchObject({ contextScope: 'full', contextTrigger: 'recap' });
    expect(decide('Which date should I use?', { previousTurns: 10, historyConflict: true }))
      .toMatchObject({ contextScope: 'full', contextTrigger: 'conflict' });
    expect(decide('استأنف المشروع المعلق.', { previousTurns: 10, resumingLongWork: true }))
      .toMatchObject({ contextScope: 'full', contextTrigger: 'resume', workMode: 'long_running' });
  });

  it('recognizes transcript-based recaps and inconsistencies in the user’s own prior statements', () => {
    expect(decide('Look back through our whole discussion and summarize the unresolved decisions.', { previousTurns: 24 }))
      .toMatchObject({ contextScope: 'full', contextTrigger: 'recap' });
    expect(decide('Our previous contradictory instructions need to be reconciled.', { previousTurns: 24 }))
      .toMatchObject({ contextScope: 'full', contextTrigger: 'conflict' });
    expect(decide('Summarize the discussion between the negotiators.', { previousTurns: 24 }))
      .toMatchObject({ contextScope: 'recent', contextTrigger: null });
  });

  it('ignores history when the user limits the request to current material', () => {
    expect(decide('Ignore earlier messages. Which date should I use?', { previousTurns: 10, historyConflict: true }))
      .toMatchObject({ contextScope: 'recent', contextTrigger: null, includeEarlierTurns: false });
    expect(decide('Summarize the first message from another conversation.', { previousTurns: 30 }))
      .toMatchObject({ contextScope: 'recent', contextTrigger: null });
    expect(decide('What was the first message from Mars?', { previousTurns: 30 }))
      .toMatchObject({ contextScope: 'recent', contextTrigger: null });
    expect(decide('Translate “Summarize this conversation.” into French.', { previousTurns: 10 }))
      .toMatchObject({ contextScope: 'recent', contextTrigger: null });
    expect(decide('Summarize this conversation.', { previousTurns: 0 })).toMatchObject({ contextScope: 'recent' });
  });

  it('chooses long work for actual builds, deep research and ongoing monitoring', () => {
    expect(decide('Build a dashboard and run the tests.', { intent: 'coding' }).workMode).toBe('long_running');
    expect(decide('Investigate the competing claims across sources.', { route: 'web_search' }).workMode).toBe('long_running');
    expect(decide('راقب حالة الشحنة كل ساعة ونبهني إذا تغيرت.').workMode).toBe('long_running');
    expect(decide('Track the package status.').workMode).toBe('interactive');
    expect(decide('For the next hour, check our shared schedule every ten minutes.').workMode).toBe('long_running');
    expect(decide('Finish the earlier inventory audit from the checkpoint.', { previousTurns: 20 }).workMode).toBe('long_running');
    expect(decide('What does it mean to work in the background?').workMode).toBe('interactive');
    expect(decide('How do I build a website?').workMode).toBe('interactive');
    expect(decide('Translate: Work in the background until you finish.').workMode).toBe('interactive');
    expect(decide("Investigate it in depth. Don't work in the background.").workMode).toBe('interactive');
    expect(decide('Build a dashboard.', { clarification: 'needed' }).workMode).toBe('interactive');
  });
});
