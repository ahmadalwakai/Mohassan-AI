import type {
  AsrSchool, CivilDate, HighLatitudeRule, LiveLanguage, LivePlace, PrayerMethod,
} from '../../../../packages/contracts/src/live-data.js';

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const HALF_DAY_MINUTES = 12 * 60;
const RADIANS = Math.PI / 180;
const NOAA = 'https://gml.noaa.gov/grad/solcalc/calcdetails.html';
const PRAY_TIMES = 'https://praytimes.org/docs/calculation';

interface MethodSettings {
  label: Record<LiveLanguage, string>;
  fajrAngle: number;
  isha: { angle: number } | { minutes: number; ramadanMinutes: number };
}

// PrayTimes calculation documentation, retrieved 2026-11-25. The table
// specifies depression angles (degrees), Umm al-Qura's Isha intervals, the
// Asr shadow factors, and the three ways of dividing a high-latitude night.
const METHODS: Record<PrayerMethod, MethodSettings> = {
  'umm-al-qura': { label: { ar: 'أم القرى', en: 'Umm al-Qura' }, fajrAngle: 18.5, isha: { minutes: 90, ramadanMinutes: 120 } },
  mwl: { label: { ar: 'رابطة العالم الإسلامي', en: 'Muslim World League' }, fajrAngle: 18, isha: { angle: 17 } },
  egypt: { label: { ar: 'الهيئة المصرية العامة للمساحة', en: 'Egyptian General Authority of Survey' }, fajrAngle: 19.5, isha: { angle: 17.5 } },
  karachi: { label: { ar: 'جامعة العلوم الإسلامية في كراتشي', en: 'University of Islamic Sciences, Karachi' }, fajrAngle: 18, isha: { angle: 18 } },
  isna: { label: { ar: 'الجمعية الإسلامية لأمريكا الشمالية (ISNA)', en: 'Islamic Society of North America (ISNA)' }, fajrAngle: 15, isha: { angle: 15 } },
};

// Geographic defaults for the supported conventions. Other countries use MWL.
const COUNTRY_METHODS: Readonly<Partial<Record<string, PrayerMethod>>> = {
  SA: 'umm-al-qura', EG: 'egypt', PK: 'karachi', US: 'isna', CA: 'isna',
};

const RULE_LABELS: Record<HighLatitudeRule, Record<LiveLanguage, string>> = {
  'angle-based': { ar: 'نسبة زاوية الشفق', en: 'angle-based' },
  'one-seventh': { ar: 'سُبع الليل', en: 'one-seventh of the night' },
  'middle-of-night': { ar: 'منتصف الليل', en: 'middle of the night' },
};

const PRAYER_LABELS = {
  fajr: { ar: 'الفجر', en: 'Fajr' },
  sunrise: { ar: 'الشروق', en: 'Sunrise' },
  dhuhr: { ar: 'الظهر', en: 'Dhuhr' },
  asr: { ar: 'العصر', en: 'Asr' },
  maghrib: { ar: 'المغرب', en: 'Maghrib' },
  isha: { ar: 'العشاء', en: 'Isha' },
};

type PrayerName = keyof typeof PRAYER_LABELS;
type TwilightPrayer = 'fajr' | 'isha';
type PrayerPlace = Pick<LivePlace, 'latitude' | 'longitude' | 'timezone' | 'countryCode'>;

export interface PrayerOptions {
  method?: PrayerMethod;
  asr?: AsrSchool;
  highLatitude?: HighLatitudeRule;
  ramadan?: boolean;
}

export interface PrayerTimes {
  date: CivilDate;
  timezone: string;
  method: PrayerMethod;
  asr: AsrSchool;
  highLatitude: HighLatitudeRule;
  adjusted: TwilightPrayer[];
  times: Record<PrayerName, number | null>;
}

// NOAA Global Monitoring Laboratory Solar Calculator, retrieved 2026-11-25.
// https://gml.noaa.gov/grad/solcalc/main.js (solar declination and equation of time)
// https://gml.noaa.gov/grad/solcalc/solareqns.PDF (hour angle and horizon refraction)
// t is Julian centuries from J2000.0. Declination is in radians and the
// equation of time is in minutes. Longitudes are positive east of Greenwich.
function solarPosition(timestamp: number) {
  const t = (timestamp / DAY_MS + 2_440_587.5 - 2_451_545) / 36_525;
  const meanLongitude = 280.46646 + t * (36_000.76983 + t * 0.0003032);
  const anomaly = (357.52911 + t * (35_999.05029 - 0.0001537 * t)) * RADIANS;
  const eccentricity = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
  const center = (1.914602 - t * (0.004817 + 0.000014 * t)) * Math.sin(anomaly)
    + (0.019993 - 0.000101 * t) * Math.sin(2 * anomaly) + 0.000289 * Math.sin(3 * anomaly);
  const omega = (125.04 - 1934.136 * t) * RADIANS;
  const apparentLongitude = (meanLongitude + center - 0.00569 - 0.00478 * Math.sin(omega)) * RADIANS;
  const seconds = 21.448 - t * (46.815 + t * (0.00059 - t * 0.001813));
  const obliquity = (23 + (26 + seconds / 60) / 60 + 0.00256 * Math.cos(omega)) * RADIANS;
  const twiceLongitude = 2 * meanLongitude * RADIANS;
  const y = Math.tan(obliquity / 2) ** 2;
  const equation = y * Math.sin(twiceLongitude) - 2 * eccentricity * Math.sin(anomaly)
    + 4 * eccentricity * y * Math.sin(anomaly) * Math.cos(twiceLongitude)
    - y ** 2 * Math.sin(2 * twiceLongitude) / 2 - 1.25 * eccentricity ** 2 * Math.sin(2 * anomaly);
  return { declination: Math.asin(Math.sin(obliquity) * Math.sin(apparentLongitude)), equationMinutes: 4 * equation / RADIANS };
}

function dateLabel({ year, month, day }: CivilDate) {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function zonedDay(timezone: string) {
  const formatter = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
  return (timestamp: number) => {
    const parts = formatter.formatToParts(timestamp);
    const part = (type: string) => parts.find(item => item.type === type)!.value;
    return `${part('year').padStart(4, '0')}-${part('month')}-${part('day')}`;
  };
}

function localSolarDay(midnight: number, longitude: number) {
  function solarTime(apparentMinutes: number) {
    const mean = midnight + (apparentMinutes - 4 * longitude) * MINUTE_MS;
    const estimate = mean - solarPosition(mean).equationMinutes * MINUTE_MS;
    return mean - solarPosition(estimate).equationMinutes * MINUTE_MS;
  }
  return { dawnLimit: solarTime(0), noon: solarTime(HALF_DAY_MINUTES), duskLimit: solarTime(2 * HALF_DAY_MINUTES) };
}

function solarAltitude(latitude: number, longitude: number, timestamp: number) {
  const { declination, equationMinutes } = solarPosition(timestamp);
  const utcMinutes = (timestamp % DAY_MS) / MINUTE_MS;
  const hourAngle = ((utcMinutes + equationMinutes) / 4 + longitude - 180) * RADIANS;
  const sineAltitude = Math.sin(latitude) * Math.sin(declination)
    + Math.cos(latitude) * Math.cos(declination) * Math.cos(hourAngle);
  return Math.asin(Math.max(-1, Math.min(1, sineAltitude)));
}

function altitudeCrossing(altitude: (time: number) => number, target: number, start: number, end: number) {
  const startsBelow = altitude(start) < target;
  if (startsBelow === (altitude(end) < target)) return null;
  // Resolve the geometric altitude crossing to under a second before display rounding.
  while (end - start > 1000) {
    const middle = (start + end) / 2;
    if ((altitude(middle) < target) === startsBelow) start = middle;
    else end = middle;
  }
  return (start + end) / 2;
}

function nightFraction(rule: HighLatitudeRule, angle: number) {
  if (rule === 'angle-based') return angle / 60;
  return rule === 'one-seventh' ? 1 / 7 : 1 / 2;
}

export function calculatePrayerTimes(date: CivilDate, place: PrayerPlace, options: PrayerOptions = {}): PrayerTimes {
  const { longitude, timezone, countryCode } = place;
  const latitude = place.latitude * RADIANS;
  const method = options.method ?? COUNTRY_METHODS[countryCode?.toUpperCase() ?? ''] ?? 'mwl';
  const settings = METHODS[method];
  const asr = options.asr ?? 'standard';
  const highLatitude = options.highLatitude ?? 'angle-based';
  const expectedDate = dateLabel(date);
  const midnight = new Date(`${expectedDate}T00:00:00Z`).getTime();
  const toLocalDay = zonedDay(timezone);
  const anchor = Number.isFinite(midnight) ? [midnight, midnight - DAY_MS, midnight + DAY_MS]
    .find(day => toLocalDay(localSolarDay(day, longitude).noon) === expectedDate) : undefined;
  const adjusted: TwilightPrayer[] = [];
  const result = { date, timezone, method, asr, highLatitude, adjusted };
  if (anchor === undefined) {
    return { ...result, times: { fajr: null, sunrise: null, dhuhr: null, asr: null, maghrib: null, isha: null } };
  }

  const bounds = localSolarDay(anchor, longitude);
  const altitude = (time: number) => solarAltitude(latitude, longitude, time);
  const horizon = -0.833 * RADIANS;
  const morning = (angle: number) => altitudeCrossing(altitude, angle, bounds.dawnLimit, bounds.noon);
  const evening = (angle: number) => altitudeCrossing(altitude, angle, bounds.noon, bounds.duskLimit);
  const sunrise = morning(horizon);
  const maghrib = evening(horizon);
  const noonShadow = Math.tan(Math.abs(latitude - solarPosition(bounds.noon).declination));
  const afternoon = noonShadow >= 0 ? evening(Math.atan(1 / (noonShadow + (asr === 'hanafi' ? 2 : 1)))) : null;

  let fajr = morning(-settings.fajrAngle * RADIANS);
  if (fajr === null && sunrise !== null) {
    const previous = localSolarDay(anchor - DAY_MS, longitude);
    const sunset = altitudeCrossing(altitude, horizon, previous.noon, previous.duskLimit);
    if (sunset !== null) {
      fajr = sunrise - (sunrise - sunset) * nightFraction(highLatitude, settings.fajrAngle);
      adjusted.push('fajr');
    }
  }

  let isha: number | null = null;
  if ('angle' in settings.isha) {
    isha = evening(-settings.isha.angle * RADIANS);
    if (isha === null && maghrib !== null) {
      const next = localSolarDay(anchor + DAY_MS, longitude);
      const nextSunrise = altitudeCrossing(altitude, horizon, next.dawnLimit, next.noon);
      if (nextSunrise !== null) {
        isha = maghrib + (nextSunrise - maghrib) * nightFraction(highLatitude, settings.isha.angle);
        adjusted.push('isha');
      }
    }
  } else if (maghrib !== null) {
    isha = maghrib + (options.ramadan ? settings.isha.ramadanMinutes : settings.isha.minutes) * MINUTE_MS;
  }

  return { ...result, times: { fajr, sunrise, dhuhr: bounds.noon, asr: afternoon, maghrib, isha } };
}

export function renderPrayerTimes(result: PrayerTimes, placeName: string, language: LiveLanguage): string {
  const { times, timezone, method, asr, highLatitude, adjusted } = result;
  const date = dateLabel(result.date);
  const arabic = language === 'ar';
  const clock = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const localDay = zonedDay(timezone);
  const lines = (Object.keys(PRAYER_LABELS) as PrayerName[]).map(prayer => {
    const time = times[prayer];
    const name = PRAYER_LABELS[prayer][language];
    if (time === null) return `- ${name} — ${arabic ? 'غير متاح فلكيًا' : 'unavailable astronomically'}`;
    const rounded = Math.round(time / MINUTE_MS) * MINUTE_MS;
    const eventDate = localDay(rounded);
    return `- ${name} — ${clock.format(rounded)}${eventDate === date ? '' : ` (${eventDate})`}`;
  });
  const methodName = METHODS[method].label[language];
  const factor = asr === 'hanafi' ? 2 : 1;
  const rule = RULE_LABELS[highLatitude][language];
  const estimated = adjusted.map(prayer => PRAYER_LABELS[prayer][language]).join(arabic ? '، ' : ', ');
  const notes = arabic ? [
    `تاريخ الحساب المحلي ${date} (${timezone}).`,
    `الطريقة ${methodName}، والعصر ${asr === 'hanafi' ? 'حنفي' : 'قياسي'} (معامل الظل ${factor}).`,
    `قاعدة خطوط العرض العليا ${rule}${estimated ? `، استُخدمت لتقدير ${estimated}` : '، لم تُستخدم في هذا اليوم'}.`,
    `المصدر [معادلات الشمس لدى NOAA](${NOAA})، [توثيق طرق الصلاة](${PRAY_TIMES})، وإحداثيات GeoNames عبر [Open-Meteo](https://open-meteo.com/en/docs/geocoding-api).`,
  ] : [
    `Local calculation date ${date} (${timezone}).`,
    `Method ${methodName}, with ${asr === 'hanafi' ? 'Hanafi' : 'standard'} Asr (shadow factor ${factor}).`,
    `High-latitude rule ${rule}${estimated ? `, used to estimate ${estimated}` : ', unused on this date'}.`,
    `Sources [NOAA solar equations](${NOAA}), [prayer calculation conventions](${PRAY_TIMES}), and GeoNames coordinates via [Open-Meteo](https://open-meteo.com/en/docs/geocoding-api).`,
  ];
  return [`${arabic ? 'مواقيت الصلاة في' : 'Prayer times in'} ${placeName}`, ...lines, '', ...notes].join('\n');
}
