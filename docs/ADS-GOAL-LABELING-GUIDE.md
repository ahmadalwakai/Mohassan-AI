# Ads goal labeling guide (ads.goal.v2)

دليل توسيم طلبات إعلانات جوجل. يلتزم به مولّد بيانات التدريب وكاتب الاختبار المستقل معاً،
حتى يُحكم على النموذج بقواعد مكتوبة لا باجتهاد كل كاتب.

One chat sentence becomes one `Goal`. Every value is copied from the sentence; nothing is
guessed. `checkGoal` in `scripts/ads-training/goal.ts` must accept every label, and
`goalToPointer` in `scripts/ads-training/pointer.ts` must be able to represent it.

```ts
{ intent: 'create_campaign' | 'other', url: string | null, service: string | null,
  locations: string[], budget: { amount: string, currency: '£'|'$'|'€'|'SAR'|'AED'|'EGP'|null,
  period: 'day'|'week'|'month' } | null, goal: 'calls'|'bookings'|'leads'|null }
```

## 1. intent

- `create_campaign`: the user asks for a **new** campaign or new ads, as a command, a wish or a
  question ("Could you arrange Google advertising…", "بدي حملة…"). Missing details do not change
  the intent: "Create a search campaign; I will send the website later" is `create_campaign`
  with every other field empty.
- `other`: everything else. Questions about advertising, reports, pausing/editing/stopping an
  existing campaign, checking a website, unrelated tasks, and any sentence that says **not** to
  create ("Do not create any campaign", "لا تنشئ حملة الآن"). A sentence that edits an existing
  campaign and says not to create another is `other`.
- With `other`, every other field is empty (`null`, `[]`), even when the sentence names a city,
  a website or an amount.

## 2. url

- The website exactly as written, with its scheme and path, without the punctuation around it.
- Two different websites with no clear choice: `null`.
- "The website is not ready", "I will send the link later": `null`.

## 3. service

The business activity or product, in the user's words, as the shortest phrase that names it.

- Drop articles and possessives: `my`, `our`, `a`, `the`.
- Drop a **singular** container word next to the activity: `business`, `company`, `service`,
  `firm`; `خدمة`, `نشاط`, `شركة`, `مجال`. "my piano repairs business" → `piano repairs`;
  "لخدمة تنظيف السجاد" → `تنظيف السجاد`.
- Keep a **plural** `services` / `خدمات` when it is part of the name: `legal services`,
  `خدمات الترجمة`.
- Keep words that name the kind of offering: `classes`, `lessons`, `shop`, `workshop`, `studio`,
  `salon`, `clinic`; `دروس`, `صالون`, `عيادة`. "my dog training classes" → `dog training classes`;
  "a pottery workshop" → `pottery workshop`; "my repair shop" → `repair shop`.
- Arabic `محل` / `مركز` / `ورشة` / `متجر`: when **one** word follows, keep both (`محل ورد`,
  `ورشة خزف`); when an activity of two or more words follows, the service is the activity only
  ("لمحل إصلاح الساعات" → `إصلاح الساعات`, "لمركز دروس الموسيقى" → `دروس الموسيقى`).
- Keep a modifier that describes the offering (`handmade lamps`, `mobile bike servicing`,
  `antique clock repairs`). Drop a modifier that describes the business itself: `small`, `new`,
  `local`, `family`; `جديد/جديدة`, `صغير/صغيرة`. "a small bakery" → `bakery`;
  "ورشة خزف جديدة" → `ورشة خزف`.
- The service is never a word of the request itself (`Google`, `ads`, `campaign`, `حملة`, `إعلان`).
- An Arabic service written after an attached `ل` / `ب` / `و` is the exact rest of the word:
  "لخياطة الملابس" → `خياطة الملابس`; "للحلاقة" → `حلاقة` (the letters after `لل`).
- No service named: `null`. Never derive a service from the domain name.

## 4. locations

- Every place the user wants targeted, exactly as written, **in the order of mention**.
- A multi-word name is one location: `North London`, `Newcastle upon Tyne`, `أبو ظبي`,
  `رأس الخيمة`. A hyphenated name stays one word: `Stoke-on-Trent`.
- Without prepositions or attached letters: "بالخبر" → `الخبر`, "والمدينة" → `المدينة`,
  "ودبي" → `دبي`. The article `ال` stays when it is written and can be kept.
- Without words around the name: "York residents only" → `York`; "all of Scotland" → `Scotland`;
  "in the Leeds area" → `Leeds`.
- A place the user excludes is not a location: "do not target Leeds; use Harrogate" → `Harrogate`;
  "Bath instead of Bristol" → `Bath`; "عجمان بدلاً من دبي" → `عجمان`.
- "No location chosen yet": `[]`.

## 5. budget

A budget exists only when the sentence gives **one** amount **and** its period.

- `amount`: the number as digits, without grouping separators, keeping decimals as written:
  "£1,250.50" → `1250.50`; "١٬٥٠٠٫٥٠" → `1500.50`; "۷۵" → `75`.
- `period`: `day`, `week` or `month`, only when stated. No period, or an undecided period
  ("daily or monthly, not sure"): the whole budget is `null`.
- `currency`: only when stated: `£` (pounds, quid, GBP, جنيه إسترليني), `$` (dollars, USD, دولار),
  `€` (euros, EUR, يورو), `SAR` (ريال سعودي), `AED` (درهم إماراتي), `EGP` (جنيه مصري).
  An amount and a period without a currency ("240 per month, currency to be decided"):
  `currency: null`. A bare "ريال" or "درهم" or "جنيه" without its country is **not** a stated
  currency: avoid it in test sentences.
- Two amounts with no decision ("£20 or £40 daily"): `null`.
- A correction keeps the final amount: "from £25 to £32 per day" → `32`.
- "I have not chosen a budget": `null`.
- A number inside a domain name (`linen20.com`) is never an amount.

## 6. goal

- `calls`: calls, phone calls, the phone ringing; مكالمات، اتصالات.
- `bookings`: bookings, appointments, reservations; حجوزات، مواعيد.
- `leads`: leads, enquiries, quote requests, contact form; استفسارات، طلبات عروض أسعار، طلبات تواصل.
- Only a goal the user **wants**. "Appointments, not calls" → `bookings`; "No phone calls; bookings only" → `bookings`.
- No goal named: `null`. Two different wanted goals in one sentence: avoid in test sentences.

## 7. What a test sentence must satisfy

- `checkGoal(message, expected)` returns no issues.
- `goalToPointer(message, expected)` is not `null`.
- Each labelled value appears once in the sentence where the label means it (the pointer names
  the first unused match).
