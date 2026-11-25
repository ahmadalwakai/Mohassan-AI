# Offline currency conversion

An owner-supplied rate table is used when `MOHASSAN_REASONING=1`. From the repository root, place the JSON file at `.data/reasoning/exchange-rates.json`. The server reads it when it handles a currency conversion. Replace it atomically to update the snapshot. The `.data` directory is ignored by Git.

```json
{
  "asOf": "2025-02-20",
  "source": "Example only — replace with the publisher and dataset or reference URL",
  "base": "EUR",
  "rates": { "USD": "1.25", "GBP": "0.80" }
}
```

The example uses illustrative rates. Use an ISO calendar date, an attributable source, supported three-letter currency codes and positive decimal strings. Rates are units of the quoted currency per unit of the base. The base is implicitly `1`. For `Convert 20 USD to GBP`, the calculation is `20 × (GBP rate ÷ USD rate)`. It rounds to the target currency’s minor unit, with ties rounded away from zero. A request for the rate alone displays up to 12 decimal places. Replies display the recorded date and source.

## Owner decision

The local calculator ships without a populated rate table and has no network fetch or automatic refresh. It reports a gap for a missing or invalid file, a missing currency, or an explicit request for a current rate. Before adding a live feed, the owner would need to choose the provider, approve its display and redistribution terms, and decide rate type, publication schedule, acceptable age, and behavior during outages.

موحسن يحسب التحويل من جدول يضعه المالك، ويعرض تاريخ السعر ومصدره. مثلًا، يحوّل الدولار إلى الجنيه الإسترليني باستخدام السعرين في الجدول نفسه. إذا طلب المستخدم سعر اليوم صراحةً، يوضح موحسن أن المسار المحلي يوفّر أسعارًا مؤرّخة فقط.
