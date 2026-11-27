export type LocalizedText = { en: string; ar: string };

export interface StatisticsIndicator extends LocalizedText {
  worldBank?: { code: string; unit: LocalizedText; upstream: string };
  imf?: { code: string; unit: LocalizedText };
}

export interface StatisticsObservation {
  value: number;
  year: number;
  url: string;
  source: string;
  unit: LocalizedText;
  projection?: boolean;
  /** The source series may include estimates for periods before its projection boundary. */
  estimate?: boolean;
}

export type StatisticsRequest = (url: URL, signal: AbortSignal) => Promise<unknown>;
