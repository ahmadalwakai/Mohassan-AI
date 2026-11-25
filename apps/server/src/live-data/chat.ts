import { randomUUID } from 'node:crypto';
import type { ChatQuestion } from '@mohassan/contracts';
import { cityName, recognizeLiveData } from './recognize.js';
import { answerLiveData } from './service.js';

export async function routeLiveDataChat({ request, evaluatedAt, signal, trail, allowSource, reply, ask, notice }: {
  request: string;
  evaluatedAt: number;
  signal: AbortSignal;
  trail: readonly { action: string; result: string }[];
  allowSource: boolean;
  reply: (text: string, status: 'completed' | 'partial' | 'blocked') => Promise<void>;
  ask: (question: ChatQuestion) => Promise<void>;
  notice: (text: string) => Promise<void>;
}): Promise<boolean> {
  const intent = recognizeLiveData(request);
  if (!intent || trail.some(entry => entry.action !== 'asked the user')) return false;
  const needsLocation = intent.kind === 'prayer' || intent.kind === 'weather';
  // Leave requests with an external-source veto to the normal constrained chat path.
  if (!allowSource && (needsLocation || intent.kind === 'exchange')) return false;
  const ar = intent.language === 'ar';
  if (needsLocation && !intent.place) {
    if (!trail.length) {
      const prompt = ar ? 'ما المدينة التي تريدها؟ يمكنك كتابة اسم البلد معها.' : 'Which city would you like? You can include its country.';
      await ask({ id: randomUUID(), prompt, options: [{ id: 'stop', label: ar ? 'توقف هنا' : 'Stop here' }] });
      return true;
    }
    const last = trail.at(-1)?.result;
    intent.place = last?.startsWith('user answered: ') ? cityName(last.slice('user answered: '.length)) : undefined;
    if (!intent.place) {
      await reply(ar ? 'لم أتمكن من قراءة اسم مدينة. أرسل الطلب مع اسم المدينة والبلد.' : 'I couldn’t read a city name. Include the city and country in your request.', 'blocked');
      return true;
    }
  }
  const outcome = await answerLiveData(intent, { now: new Date(evaluatedAt), signal, allowSource });
  if (outcome.kind === 'fallback') {
    await notice(outcome.notice);
    return false;
  }
  await reply(outcome.reply.text, outcome.reply.status);
  return true;
}
