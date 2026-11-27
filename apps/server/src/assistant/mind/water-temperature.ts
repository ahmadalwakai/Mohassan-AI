const REFERENCE_POINT = /^(?:(?:what is|what['’]s)\s+(?:the\s+)?(boiling|freezing)\s+point of water\s+in\s+|(?:ما(?: هي)?|كم)\s+درج[ةه]\s+(غليان|تجمد)\s+الماء\s+(?:ب\s*|في\s+))(.+)$/iu;
export const WATER_TEMPERATURE_CUE = /\bpoint of water\b|(?<!\p{L})(?:غليان|تجمد)\s+الماء(?!\p{L})/iu;

/** Reads a whole question. The calculator still validates the requested scale. */
export function waterTemperatureQuestion(input: string) {
  const match = REFERENCE_POINT.exec(input);
  if (!match) return null;
  const boiling = match[1]?.toLowerCase() === 'boiling' || match[2] === 'غليان';
  // Standard reference points, rounded to whole degrees at 1 atm.
  // https://www.nist.gov/pml/owm/si-units-temperature (retrieved 2026-11-27).
  return { boiling, celsius: boiling ? 100 : 0, label: match[3]! };
}
