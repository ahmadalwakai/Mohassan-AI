// In these noun phrases, “current” names a physical quantity or flow. Mask it
// for freshness detection only. The original question still goes to search.
const physicalCurrent = /\b((?:electric(?:al)?|alternating|direct|leakage|inrush|displacement|fault|short[- ]circuit|ocean|oceanic|tidal)\s+)current\b/giu;

export function webFreshnessText(question: string): string {
  return question.replace(physicalCurrent, '$1');
}
