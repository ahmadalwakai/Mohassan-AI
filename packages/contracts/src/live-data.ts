export type LiveLanguage = 'ar' | 'en';

export interface CivilDate {
  year: number;
  month: number;
  day: number;
}

export interface LivePlace {
  name: string;
  latitude: number;
  longitude: number;
  timezone: string;
  countryCode?: string;
  country?: string;
  admin1?: string;
}

export type PrayerMethod = 'umm-al-qura' | 'mwl' | 'egypt' | 'karachi' | 'isna';
export type AsrSchool = 'standard' | 'hanafi';
export type HighLatitudeRule = 'angle-based' | 'one-seventh' | 'middle-of-night';

export interface HijriIntent {
  kind: 'hijri';
  language: LiveLanguage;
  direction: 'today' | 'to-hijri' | 'to-gregorian';
  date?: CivilDate;
}

export interface PrayerIntent {
  kind: 'prayer';
  language: LiveLanguage;
  place?: string;
  dayOffset?: number;
  date?: CivilDate;
  method?: PrayerMethod;
  asr?: AsrSchool;
  highLatitude?: HighLatitudeRule;
}

export interface WeatherIntent {
  kind: 'weather';
  language: LiveLanguage;
  place?: string;
  period: 'current' | 'hourly' | 'daily';
}

export interface ExchangeIntent {
  kind: 'exchange';
  language: LiveLanguage;
  amount: string;
  from: string;
  to: string;
  rateOnly?: boolean;
}

export interface ExchangeQuoteIntent {
  kind: 'exchange-quote';
  language: LiveLanguage;
  from: string;
}

export interface UnsupportedMarketIntent {
  kind: 'unsupported-market';
  language: LiveLanguage;
  asset: 'gold' | 'crypto' | 'stocks' | 'currency';
}

export type LiveDataIntent = HijriIntent | PrayerIntent | WeatherIntent | ExchangeIntent | ExchangeQuoteIntent | UnsupportedMarketIntent;
