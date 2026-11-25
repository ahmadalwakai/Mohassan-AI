import type { LiveLanguage, LivePlace, WeatherIntent } from '@mohassan/contracts';
import { z } from 'zod';
import { GEOCODING_ATTRIBUTION, placeLabel } from './places.js';
import type { RequestScope } from './request.js';

// Default Best Match selects numerical weather sources in this documented implementation (retrieved 2026-11-25).
// https://github.com/open-meteo/open-meteo/blob/136e19679af2393a0106e04f201510aad910e33c/Sources/App/Controllers/ForecastapiController.swift#L2036
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const WEATHER_TTL_MS = 15 * 60 * 1000;
const FORECAST_DAYS = 7;
const FORECAST_HOURS = 24;

// WMO Weather interpretation codes in https://open-meteo.com/en/docs (retrieved 2026-11-25).
const conditions: Readonly<Record<number, readonly [arabic: string, english: string]>> = {
  0: ['سماء صافية', 'Clear sky'],
  1: ['صافٍ غالبًا', 'Mainly clear'],
  2: ['غائم جزئيًا', 'Partly cloudy'],
  3: ['غائم كليًا', 'Overcast'],
  45: ['ضباب', 'Fog'],
  48: ['ضباب يكوّن صقيعًا', 'Depositing rime fog'],
  51: ['رذاذ خفيف', 'Light drizzle'],
  53: ['رذاذ متوسط', 'Moderate drizzle'],
  55: ['رذاذ كثيف', 'Dense drizzle'],
  56: ['رذاذ متجمّد خفيف', 'Light freezing drizzle'],
  57: ['رذاذ متجمّد كثيف', 'Dense freezing drizzle'],
  61: ['مطر خفيف', 'Slight rain'],
  63: ['مطر متوسط', 'Moderate rain'],
  65: ['مطر غزير', 'Heavy rain'],
  66: ['مطر متجمّد خفيف', 'Light freezing rain'],
  67: ['مطر متجمّد غزير', 'Heavy freezing rain'],
  71: ['تساقط ثلوج خفيف', 'Slight snowfall'],
  73: ['تساقط ثلوج متوسط', 'Moderate snowfall'],
  75: ['تساقط ثلوج كثيف', 'Heavy snowfall'],
  77: ['حبيبات ثلجية', 'Snow grains'],
  80: ['زخات مطر خفيفة', 'Slight rain showers'],
  81: ['زخات مطر متوسطة', 'Moderate rain showers'],
  82: ['زخات مطر شديدة', 'Violent rain showers'],
  85: ['زخات ثلجية خفيفة', 'Slight snow showers'],
  86: ['زخات ثلجية كثيفة', 'Heavy snow showers'],
  95: ['عاصفة رعدية', 'Thunderstorm'],
  96: ['عاصفة رعدية مع بَرَد خفيف', 'Thunderstorm with slight hail'],
  97: ['عاصفة رعدية شديدة', 'Heavy thunderstorm'],
  99: ['عاصفة رعدية مع بَرَد كثيف', 'Thunderstorm with heavy hail'],
};

export function weatherCondition(code: number | null, language: LiveLanguage): string {
  if (code === null) return '—';
  return conditions[code]?.[language === 'ar' ? 0 : 1]
    ?? (language === 'ar' ? `رمز طقس غير موصوف (WMO ${code})` : `Undescribed weather code (WMO ${code})`);
}

const timestamp = z.number().int().nonnegative().max(8_640_000_000_000);
const times = z.array(timestamp).min(1).max(FORECAST_DAYS * FORECAST_HOURS + 1)
  .refine(values => values.every((value, index) => index === 0 || value > values[index - 1]));
const code = z.number().int().nonnegative();
const percent = z.number().min(0).max(100);
const temp = z.number();
const nonnegative = z.number().nonnegative();

const forecastResponse = z.object({
  utc_offset_seconds: z.number().int().min(-86_400).max(86_400),
  current: z.object({
    time: timestamp,
    temperature_2m: temp,
    apparent_temperature: temp.nullable(),
    relative_humidity_2m: percent.nullable(),
    precipitation: nonnegative.nullable(),
    wind_speed_10m: nonnegative.nullable(),
    weather_code: code.nullable(),
  }),
  hourly: z.object({
    time: times,
    temperature_2m: z.array(temp.nullable()),
    precipitation_probability: z.array(percent.nullable()),
    weather_code: z.array(code.nullable()),
  }),
  daily: z.object({
    time: times,
    temperature_2m_min: z.array(temp.nullable()),
    temperature_2m_max: z.array(temp.nullable()),
    precipitation_probability_max: z.array(percent.nullable()),
    weather_code: z.array(code.nullable()),
  }),
});

function localFormatter(timezone: string, showTime = false): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    ...(showTime ? { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' } : {}),
  });
}

function unit(value: number | null, units: string): string {
  return value === null ? '—' : `${value}${units}`;
}

function forecastTable(headers: readonly string[], rows: string[][]): string {
  return [headers, headers.map(() => '---'), ...rows].map(row => `| ${row.join(' | ')} |`).join('\n');
}

async function readWeather(scope: RequestScope, place: LivePlace, now: Date) {
  const { latitude, longitude, timezone } = place;
  // Open-Meteo starts forecast days at local midnight. Refresh a cache entry that spans midnight
  // so the first forecast date remains today's date and a full seven days are available.
  const date = localFormatter(timezone).format(now);
  return scope.withCache(`weather:${latitude}:${longitude}:${timezone}:${date}`, WEATHER_TTL_MS, async () => {
    const url = new URL(FORECAST_URL);
    url.search = new URLSearchParams({
      latitude: String(latitude), longitude: String(longitude), timezone, timeformat: 'unixtime',
      current: 'temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m',
      hourly: 'temperature_2m,precipitation_probability,weather_code',
      daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
      temperature_unit: 'celsius', wind_speed_unit: 'kmh', precipitation_unit: 'mm', forecast_days: String(FORECAST_DAYS),
    }).toString();
    const response = await scope.fetch(url);
    if (!response.ok) throw new Error(`Open-Meteo forecast HTTP ${response.status}`);
    const data = forecastResponse.parse(await response.json());
    for (const series of [data.hourly, data.daily]) {
      if (Object.values(series).some(values => values.length !== series.time.length)) {
        throw new Error('Open-Meteo returned mismatched forecast series');
      }
    }
    // Daily boundaries use the offset at the time of the API request, including across DST transitions.
    const days = data.daily.time.map(time => new Date((time + data.utc_offset_seconds) * 1000).toISOString().slice(0, 10));
    if (days.length !== FORECAST_DAYS || days[0] !== date
      || data.daily.time.some((time, index) => index > 0 && time - data.daily.time[index - 1] !== 86_400)) {
      throw new Error('Open-Meteo did not return seven local forecast days');
    }
    return { data, days, requestedAt: now };
  });

}

export async function getCurrentWeatherMetric(scope: RequestScope, place: LivePlace, metric: 'temperature' | 'precipitation' | 'wind', now: Date) {
  const { data } = await readWeather(scope, place, now);
  const key = { temperature: 'temperature_2m', precipitation: 'precipitation', wind: 'wind_speed_10m' }[metric] as
    'temperature_2m' | 'precipitation' | 'wind_speed_10m';
  return { value: data.current[key], at: new Date(data.current.time * 1000).toISOString(), source: FORECAST_URL };
}

export async function getWeather(scope: RequestScope, place: LivePlace, request: WeatherIntent, now = new Date()): Promise<string> {
  const { timezone } = place;
  const { data, days, requestedAt } = await readWeather(scope, place, now);
  const { language, period } = request;
  const ar = language === 'ar';
  const local = localFormatter(timezone, true);
  const location = placeLabel(place, language);
  let body: string;
  let dataTime: string;
  if (period === 'current') {
    const { current } = data;
    const condition = weatherCondition(current.weather_code, language);
    const temperature = unit(current.temperature_2m, ' °C');
    const feelsLike = unit(current.apparent_temperature, ' °C');
    const humidity = unit(current.relative_humidity_2m, '%');
    const wind = unit(current.wind_speed_10m, ar ? ' كم/س' : ' km/h');
    const precipitation = unit(current.precipitation, ar ? ' ملم' : ' mm');
    body = ar
      ? `**الطقس الآن في ${location}**\n${condition}، ${temperature}، والمحسوسة ${feelsLike}. الرطوبة ${humidity}، الرياح ${wind}، والهطول ${precipitation}.`
      : `**Current weather in ${location}**\n${condition}, ${temperature}, feels like ${feelsLike}. Humidity ${humidity}, wind ${wind}, precipitation ${precipitation}.`;
    const validAt = local.format(current.time * 1000);
    dataTime = ar ? `وقت بيانات الحالة الحالية ${validAt}` : `Current conditions valid at ${validAt}`;
  } else {
    const forecastTime = local.format(requestedAt);
    dataTime = ar ? `وقت طلب التوقع ${forecastTime}` : `Forecast requested at ${forecastTime}`;
    if (period === 'hourly') {
      const { hourly } = data;
      // Unix timestamps preserve real hourly intervals through DST changes and fractional offsets.
      const start = hourly.time.findIndex(time => time * 1000 > now.getTime());
      const selectedTimes = start < 0 ? [] : hourly.time.slice(start, start + FORECAST_HOURS);
      if (selectedTimes.length !== FORECAST_HOURS
        || selectedTimes[0] * 1000 - now.getTime() > 3_600_000
        || selectedTimes.some((time, index) => index > 0 && time - selectedTimes[index - 1] !== 3600)) {
        throw new Error('Open-Meteo did not return the next 24 hourly forecasts');
      }
      const rows = selectedTimes.map((time, index) => [
        local.format(time * 1000), weatherCondition(hourly.weather_code[start + index], language),
        unit(hourly.temperature_2m[start + index], ' °C'), unit(hourly.precipitation_probability[start + index], '%'),
      ]);
      const headers = ar ? ['الوقت المحلي', 'الحالة', 'الحرارة', 'احتمال الهطول']
        : ['Local time', 'Conditions', 'Temperature', 'Precipitation chance'];
      body = `${ar ? `**طقس الساعات الـ24 المقبلة في ${location}**` : `**Next 24 hours in ${location}**`}\n\n${forecastTable(headers, rows)}`;
    } else {
      const { daily } = data;
      const rows = days.map((day, index) => [
        day, weatherCondition(daily.weather_code[index], language),
        unit(daily.temperature_2m_min[index], ' °C'), unit(daily.temperature_2m_max[index], ' °C'),
        unit(daily.precipitation_probability_max[index], '%'),
      ]);
      const headers = ar ? ['اليوم', 'الحالة', 'الصغرى', 'العظمى', 'أعلى احتمال للهطول']
        : ['Date', 'Conditions', 'Low', 'High', 'Peak precipitation chance'];
      body = `${ar ? `**طقس 7 أيام في ${location}**` : `**7-day forecast for ${location}**`}\n\n${forecastTable(headers, rows)}`;
    }
  }
  const method = ar ? 'توقعات الأرصاد باختيار Open-Meteo التلقائي (Best Match)، مع ترجمة رموز WMO'
    : 'Open-Meteo’s automatic forecast selection (Best Match), with WMO codes rendered as descriptions';
  // https://open-meteo.com/en/licence (retrieved 2026-11-25).
  const attribution = ar ? `بيانات الطقس من [Open-Meteo](https://open-meteo.com/) وبيانات الموقع من ${GEOCODING_ATTRIBUTION}`
    : `Weather data by [Open-Meteo](https://open-meteo.com/) and location data by ${GEOCODING_ATTRIBUTION}`;
  return `${body}\n\n${dataTime} (${timezone}). ${method}.\n${attribution} · [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).`;
}
