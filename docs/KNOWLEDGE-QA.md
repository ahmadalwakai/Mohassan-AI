# أسئلة الحقائق من قاعدة موحسن المحلية

يحلل موحسن السؤال بالعربية أو الإنجليزية، ويربط الاسم بعنصر في فهرس ويكي بيانات، ثم يبحث عن الخاصية المطلوبة. في سؤال «كم عدد سكان بلجيكا في عام ٢٠٢٠؟» يبحث عن بلجيكا وعن العبارات التي ينطبق تاريخ قياسها على ٢٠٢٠. يظهر رابط نسخة العنصر وتاريخ اللقطة في نص الجواب، وتبقى العبارة الأصلية ومراجعها ومؤهلاتها في نتيجة الاستعلام.

عند تشابه الأسماء يعرض المحلل خيارين إلى أربعة مع الأوصاف ومعرفات ويكي بيانات. ترتيب الخيارات يستفيد من مطابقة الاسم واللغة وعدد وصلات ويكيميديا. عند غياب الحقيقة يظهر «لم أجد في قاعدة المعرفة» مع الاسم والخاصية والسنة التي شملها البحث. تعتمد التجربة على ملف SQLite الذي يفتحه المستدعي للقراءة في وضع عدم الاتصال. تشغيلها اختياري، وقرار تنزيل اللقطات الكاملة موثق في [قاعدة المعرفة المحلية](OFFLINE-KNOWLEDGE-2026-11-25.md).

## API

```ts
import { createKnowledgeQa, createKnowledgeQaShadow, openKnowledgeBase } from '@mohassan/knowledge-base';

const knowledge = openKnowledgeBase('/path/to/wikidata.sqlite');
const qa = createKnowledgeQa(knowledge);
const result = qa.answer('كم عدد سكان بلجيكا في عام ٢٠٢٠؟');

const shadow = createKnowledgeQaShadow({ knowledge, log: report => console.log(JSON.stringify(report)) });
shadow.observe({ question: 'كم عدد سكان بلجيكا في عام ٢٠٢٠؟', answer: 'Current public answer', runId: 'local-eval' });
await shadow.flush();
knowledge.close();
```

- `analyzeKnowledgeQuestion` returns a typed question with a property, entity mentions, a requested answer type and any supported constraints. It follows the question-shape approach in [PR #23](https://github.com/ahmadalwakai/Mohassan-AI/pull/23). Dates and exact decimal amounts are distinct values, following the typed evidence approach in [PR #18](https://github.com/ahmadalwakai/Mohassan-AI/pull/18).
- `answer` returns `answered`, `choice` or `abstained`. A choice includes the original logical form, the unresolved mention and candidate IDs. An evaluation caller can supply the chosen ID in that mention and pass the form to `execute`. The owner can use a preferred language explicitly. If the resolved target label is unavailable, the response uses the other indexed language or the Wikidata ID.
- Every contributing fact includes the raw statement and reference groups, the revision source URL, the snapshot date and any statement or reference date snaks. An undated statement still has the explicitly labeled snapshot date. A path includes evidence for each edge. For a question about the capital of someone's birth country, the executor uses place of birth, its recorded country when required, and capital. The recorded country can reflect present-day boundaries for a historical birthplace.
- A year uses the Gregorian point-in-time or interval qualifiers in the store. Earliest and latest use comparable Gregorian dates from the statement or its temporal qualifiers, at day granularity. A comparison requires matching units or an exact supported length or area conversion. Date comparisons use stated precision and a common calendar. Conflicting values or incomplete comparison evidence lead to abstention.
- Category superlatives require comparable evidence for the indexed members of the category and state the size of that index scope. A count uses a dedicated quantity property when the question maps to one. Counts over recorded statements deduplicate their values and state their recorded scope. A missing list does not establish a zero count.
- Snapshot creation indexes additional cross-script spelling keys and the Wikidata sitelink count. Earlier snapshots retain direct names and limited cross-script spelling fallbacks. Rebuilding enables full indexed cross-script matching. Existing lookup, import, Wikipedia, and shadow APIs remain available.
- The new shadow adapter accepts an explicit question and an approved baseline answer from the caller. Its log pairs both results with the snapshot identity. Flush the logger before closing the store. It has no live caller.

The reviewed property table records the supported phrases and their Wikidata IDs. The measurement reports include reconstruction commands, held-out results by language and question type, and the capability benchmark's factual-area comparison. [Property mapping](KNOWLEDGE-QA-PROPERTIES.md) · [Public evaluation and data card](KNOWLEDGE-QA-EVALUATION-2026-11-25.md) · [Capability benchmark](KNOWLEDGE-QA-CAPABILITY.md)
