import type { LiveDataIntent, LiveLanguage } from '@mohassan/contracts';
import { addCivilDays, answerHijri, civilDateInZone, validCivilDate } from './calendar-answer.js';
import { gregorianToHijri } from './hijri.js';
import { placeLabel, resolvePlace } from './places.js';
import { calculatePrayerTimes, renderPrayerTimes } from './prayer.js';
import { getRates } from './rates.js';
import { type createLiveRequestClient, liveRequestClient, LiveDataTimeout } from './request.js';
import { getWeather } from './weather.js';

type LiveReply = { text: string; status: 'completed' | 'partial' | 'blocked' };
type Outcome = { kind: 'answer'; reply: LiveReply } | { kind: 'fallback'; notice: string };

function sourceNotice(source: string, language: LiveLanguage, error: unknown) {
  const timedOut = error instanceof LiveDataTimeout;
  return language === 'ar'
    ? timedOut ? `انتهت مهلة ${source} بعد 3 ثوانٍ. سأتابع بمسار البحث المعتاد.` : `تعذّر الحصول على بيانات صالحة من ${source}. سأتابع بمسار البحث المعتاد.`
    : timedOut ? `${source} timed out after 3 seconds. I’ll continue with the usual lookup.` : `Could not retrieve usable data from ${source}. I’ll continue with the usual lookup.`;
}

const answer = (text: string, status: LiveReply['status'] = 'completed'): Outcome => ({ kind: 'answer', reply: { text, status } });

export async function answerLiveData(intent: LiveDataIntent, {
  now = new Date(), timeZone, signal, allowSource = true, client = liveRequestClient,
}: {
  now?: Date;
  timeZone?: string;
  signal?: AbortSignal;
  allowSource?: boolean;
  client?: ReturnType<typeof createLiveRequestClient>;
} = {}): Promise<Outcome> {
  const ar = intent.language === 'ar';
  if (intent.kind === 'hijri') return { kind: 'answer', reply: answerHijri(intent, now, timeZone) };
  if (intent.kind === 'unsupported-market') {
    const reasons = {
      gold: ['نشرة البنك المركزي الأوروبي تنشر أسعار صرف العملات، وتخلو من أسعار الذهب.', 'The ECB currency reference feed does not cover gold.'],
      crypto: ['نشرة البنك المركزي الأوروبي لا تشمل أسعار العملات الرقمية.', 'The ECB currency reference feed does not cover crypto.'],
      stocks: ['نشرة البنك المركزي الأوروبي لا تشمل أسعار الأسهم.', 'The ECB currency reference feed does not cover equities.'],
      currency: ['العملة المطلوبة خارج التغطية الموثقة المتاحة لهذا المسار.', 'The requested currency is outside the documented coverage of this service.'],
    };
    const ecbSource = 'https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html';
    return answer(`لا يوجد مصدر حي موثوق. ${reasons[intent.asset][ar ? 0 : 1]}\n${ar
      ? `حدود التغطية في [بيانات البنك المركزي الأوروبي](${ecbSource}).`
      : `Coverage [ECB reference rates](${ecbSource}).`}`, 'blocked');
  }
  if (intent.kind === 'exchange-quote') {
    return answer(ar ? `ما العملة التي تريد مقارنة ${intent.from} بها؟` : `Which currency should I quote ${intent.from} against?`, 'blocked');
  }
  if (!allowSource) return answer(ar ? 'يتطلب هذا الطلب الاتصال بمصدر بيانات خارجي.' : 'This request requires access to an external data source.', 'blocked');

  let source = intent.kind === 'exchange' ? ar ? 'البنك المركزي الأوروبي' : 'the ECB' : 'Open-Meteo';
  try {
    return await client.run(async scope => {
      if (intent.kind === 'exchange') return { kind: 'answer', reply: await getRates(scope, intent) };
      if (!intent.place) return answer(ar ? 'اذكر اسم المدينة والبلد.' : 'Specify a city and country.', 'blocked');
      source = ar ? 'خدمة تحديد المواقع من Open-Meteo' : 'Open-Meteo geocoding';
      const place = await resolvePlace(scope, intent.place, intent.language);
      if (!place) return answer(ar
        ? 'لم أجد هذه المدينة في خدمة تحديد المواقع من Open-Meteo. أرسل اسم المدينة مع البلد في طلب جديد.'
        : 'Open-Meteo geocoding did not find that city. Include the country with the city in a new request.', 'blocked');
      if (intent.kind === 'weather') {
        source = 'Open-Meteo';
        return answer(await getWeather(scope, place, intent, now));
      }
      const date = intent.date ?? addCivilDays(civilDateInZone(now, place.timezone).date, intent.dayOffset ?? 0);
      if (!validCivilDate(date)) return answer(ar ? 'تاريخ الصلاة غير صالح.' : 'Specify a valid date for the prayer timetable.', 'blocked');
      // The published Umm al-Qura timetable applies Ramadan Isha by the schedule's civil date.
      const ramadan = gregorianToHijri(date)?.date.month === 9;
      const calculated = calculatePrayerTimes(date, place, { ...intent, ramadan });
      const status = Object.values(calculated.times).every(time => time !== null) ? 'completed' : 'partial';
      return answer(renderPrayerTimes(calculated, placeLabel(place, intent.language), intent.language), status);
    }, signal);
  } catch (error) {
    signal?.throwIfAborted();
    return { kind: 'fallback', notice: sourceNotice(source, intent.language, error) };
  }
}
