import { describe, expect, it } from 'vitest';
import type { LiveDataIntent } from '@mohassan/contracts';
import { recognizeLiveData } from '../apps/server/src/live-data/recognize.js';

type Positive = [string, LiveDataIntent['kind']];

const arabic: Positive[] = [
  ['ما تاريخ اليوم بالهجري؟', 'hijri'],
  ['ما هو التاريخ الهجري اليوم؟', 'hijri'],
  ['اليوم كم بالتقويم الهجري؟', 'hijri'],
  ['لو سمحت، التاريخ الهجري لليوم', 'hijri'],
  ['احسب التاريخ الهجري', 'hijri'],
  ['ما تاريخ اليوم هجريًا؟', 'hijri'],
  ['حوّل ٢٠٢٥-٠٣-٠١ إلى الهجري', 'hijri'],
  ['حوّل ١ رمضان ١٤٤٦ إلى الميلادي', 'hijri'],
  ['١ رمضان ١٤٤٦ كم يوافق بالميلادي؟', 'hijri'],
  ['ما التاريخ الهجري الموافق 1 مارس 2025؟', 'hijri'],
  ['حول من الهجري إلى الميلادي: ١٤٤٦/٩/١', 'hijri'],
  ['ما مواقيت الصلاة في مكة اليوم؟', 'prayer'],
  ['أوقات الصلاة اليوم في الرياض', 'prayer'],
  ['مواعيد الأذان في لندن غدًا', 'prayer'],
  ['موعد صلاة الفجر في القاهرة', 'prayer'],
  ['مواقيت الصلاة في لندن حسب طريقة أم القرى', 'prayer'],
  ['مواعيد الصلوات في لاهور، العصر الحنفي', 'prayer'],
  ['مواقيت الصلاة في باريس وفق رابطة العالم الإسلامي', 'prayer'],
  ['أريد مواقيت الصلاة في لندن بتاريخ ٢٠٢٦-٠٦-٢١ بقاعدة منتصف الليل', 'prayer'],
  ['مواقيت الصلاة', 'prayer'],
  ['مواقيت الصلاة في مدينتي', 'prayer'],
  ['الطقس في القاهرة', 'weather'],
  ['كيف الطقس اليوم في دبي؟', 'weather'],
  ['كيف الجو في عمّان الآن؟', 'weather'],
  ['حالة الطقس في لندن للـ٢٤ ساعة القادمة', 'weather'],
  ['توقعات الطقس في الرياض للأسبوع القادم', 'weather'],
  ['درجة الحرارة في أبو ظبي', 'weather'],
  ['طقس الإسكندرية', 'weather'],
  ['توقعات الطقس في الكويت خلال ٢٤ ساعة', 'weather'],
  ['سعر صرف الدولار مقابل اليورو اليوم', 'exchange'],
  ['حوّل ١٠٠ دولار إلى ريال سعودي', 'exchange'],
  ['كم سعر الذهب اليوم؟', 'unsupported-market'],
  ['ما سعر صرف اليورو مقابل الجنيه المصري؟', 'exchange'],
];

const english: Positive[] = [
  ["What’s today's Hijri date?", 'hijri'],
  ['Today in the Islamic calendar', 'hijri'],
  ['Give me the Hijri date for today', 'hijri'],
  ['What is the Hijri equivalent of March 1, 2025?', 'hijri'],
  ['Convert 2025-03-01 to Hijri', 'hijri'],
  ['Convert 1 Ramadan 1446 to Gregorian', 'hijri'],
  ['Convert from Hijri to Gregorian: 1446-09-01', 'hijri'],
  ['1446-09-01 AH in the Gregorian calendar', 'hijri'],
  ['What is 1 March 2025 in the Hijri calendar?', 'hijri'],
  ['Calculate a date in the Hijri calendar.', 'hijri'],
  ['Prayer times for Cairo', 'prayer'],
  ['Show me prayer times tomorrow in Dubai', 'prayer'],
  ['What time is Fajr in Mecca?', 'prayer'],
  ['When does Fajr start in Cairo?', 'prayer'],
  ['When is Isha in London?', 'prayer'],
  ['Prayer times in Karachi using ISNA', 'prayer'],
  ['Salah times at Makkah using Umm al-Qura', 'prayer'],
  ['Prayer timetable for London on 2026-06-21 with Hanafi Asr', 'prayer'],
  ['Prayer schedule in London using the middle of the night', 'prayer'],
  ['Prayer times in my city', 'prayer'],
  ['Today’s prayer times', 'prayer'],
  ["What's the weather in London?", 'weather'],
  ['Current weather in Paris', 'weather'],
  ['Show me the weather conditions in São Paulo', 'weather'],
  ['Weather today in New York', 'weather'],
  ['24-hour forecast for London', 'weather'],
  ['7-day weather forecast in Cairo', 'weather'],
  ['Weather in Rome for the next 7 days', 'weather'],
  ['Weather in Tokyo for the next ٢٤ hours', 'weather'],
  ['Weather near me', 'weather'],
  ['How much is $100 in euros?', 'exchange'],
  ['Exchange rate from USD to EUR today', 'exchange'],
  ['What is the price of Bitcoin?', 'unsupported-market'],
];

const lookAlikes = [
  'ما معنى كلمة طقس؟', 'تاريخ الدولة العثمانية', 'صرف الطالب من المدرسة',
  'طقس المعمودية', 'اشرح تاريخ التقويم الهجري', 'كيف تطورت مواقيت الصلاة؟',
  'اكتب مقالًا عن أحوال الطقس', 'حول ٢٠ سم إلى م', 'ما معنى سعر الصرف؟',
  'اقرأ «ما تاريخ اليوم بالهجري؟»', 'كم يوما بين 1446-01-01 و1446-02-01 بالهجري؟',
  'Weather in poetry', 'Weather in literature and art', 'What does weather mean?',
  'What is the history of the Hijri calendar?', 'Explain the Gregorian calendar',
  'When were Islamic prayer times first established?', 'How are prayer times calculated?',
  'Forecast for retail sales', 'How do exchange rates work?', 'Exchange students in France',
  'How much is 100 km in miles?', 'Quote “weather in Cairo”', 'Weather in https://example.org',
  'What is 2 + 3 in Arabic?', 'Convert 10 pounds to kilograms.',
  'Weather station', 'الطقس في دبي بعد غد',
];

describe('recognizes whole live-data questions', () => {
  it.each(arabic)('%s is an Arabic %s intent', (request, kind) => {
    expect(recognizeLiveData(request)).toMatchObject({ kind, language: 'ar' });
  });
  it.each(english)('%s is an English %s intent', (request, kind) => {
    expect(recognizeLiveData(request)).toMatchObject({ kind, language: 'en' });
  });
  it.each(lookAlikes)('leaves “%s” to ordinary routing', request => {
    expect(recognizeLiveData(request)).toBeNull();
  });
  it('preserves a place spelling and reads the number and period independently of reply language', () => {
    expect(recognizeLiveData('الطقس في عمّان، الأردن خلال ٢٤ ساعة')).toMatchObject({
      place: 'عمّان، الأردن', period: 'hourly',
    });
    expect(recognizeLiveData('Weather in Tokyo for the next ٢٤ hours')).toMatchObject({ language: 'en', period: 'hourly' });
    expect(recognizeLiveData('توقعات الطقس في الرياض للأسبوع القادم')).toMatchObject({ place: 'الرياض', period: 'daily' });
    expect(recognizeLiveData('حوّل ١٬٢٣٤٫٥٠ دولار إلى يورو')).toMatchObject({ amount: '1234.50', from: 'USD', to: 'EUR' });
  });
  it('uses whole dates and does not interpret a place as a method', () => {
    expect(recognizeLiveData('مواقيت الصلاة في لندن بتاريخ ٢٠٢٦-٠٦-٢١ بقاعدة منتصف الليل')).toMatchObject({
      place: 'لندن', date: { year: 2026, month: 6, day: 21 }, highLatitude: 'middle-of-night',
    });
    expect(recognizeLiveData('Prayer times in Karachi using ISNA with Hanafi Asr, one-seventh')).toMatchObject({
      place: 'Karachi', method: 'isna', asr: 'hanafi', highLatitude: 'one-seventh',
    });
    expect(recognizeLiveData('Prayer times tomorrow in Karachi')).toMatchObject({ dayOffset: 1, place: 'Karachi' });
    expect(recognizeLiveData('حوّل ١ رمضان ١٤٤٦ إلى الميلادي')).toMatchObject({
      direction: 'to-gregorian', date: { year: 1446, month: 9, day: 1 },
    });
  });
});
