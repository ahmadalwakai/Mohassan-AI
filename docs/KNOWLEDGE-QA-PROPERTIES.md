# خصائص أسئلة الحقائق

يحدد محلل الأسئلة الخاصية من صيغة السؤال، ثم يبحث المنفّذ عن عبارة بهذه الخاصية في قاعدة ويكي بيانات المحلية. «متى تأسست الجامعة؟» تعني تاريخ التأسيس، و«مَن أسس الجامعة؟» تعني المؤسس. الصيغ التنفيذية والأسماء البديلة موجودة في [جدول الخصائص](../packages/knowledge-base/src/qa-properties.ts) و[محلل الأسئلة](../packages/knowledge-base/src/question-analysis.ts).

رُوجعت معرّفات الخصائص وتسمياتها العربية والإنجليزية في ويكي بيانات في 25 نوفمبر 2026. الكلمات في الجدول أمثلة لما يقبله المحلل. عمود الجواب يصف نوع قيمة العبارة قبل العد أو المقارنة. [واجهة تسميات ويكي بيانات](https://www.wikidata.org/w/api.php?action=help&modules=wbgetentities).

| الصيغة العربية | English cue | الجواب | خاصية ويكي بيانات |
| --- | --- | --- | --- |
| عاصمة | capital | عنصر | [P36](https://www.wikidata.org/wiki/Property:P36) |
| عدد سكان | population | كمية بلا وحدة | [P1082](https://www.wikidata.org/wiki/Property:P1082) |
| مساحة | area | كمية تقارن بالكيلومتر المربع | [P2046](https://www.wikidata.org/wiki/Property:P2046) |
| عملة | currency | عنصر | [P38](https://www.wikidata.org/wiki/Property:P38) |
| متى تأسست | when was it founded | تاريخ | [P571](https://www.wikidata.org/wiki/Property:P571) |
| مَن أسس | who founded it | عنصر | [P112](https://www.wikidata.org/wiki/Property:P112) |
| متى وُلد | when was the person born | تاريخ | [P569](https://www.wikidata.org/wiki/Property:P569) |
| أين وُلد | where was the person born | عنصر | [P19](https://www.wikidata.org/wiki/Property:P19) |
| متى توفي | when did the person die | تاريخ | [P570](https://www.wikidata.org/wiki/Property:P570) |
| أين توفي | where did the person die | عنصر | [P20](https://www.wikidata.org/wiki/Property:P20) |
| في أي بلد | in which country | عنصر | [P17](https://www.wikidata.org/wiki/Property:P17) |
| جنسية | country of citizenship | عنصر | [P27](https://www.wikidata.org/wiki/Property:P27) |
| المنطقة الإدارية | administrative region | عنصر | [P131](https://www.wikidata.org/wiki/Property:P131) |
| قارة | continent | عنصر | [P30](https://www.wikidata.org/wiki/Property:P30) |
| اللغة الرسمية | official language | عنصر | [P37](https://www.wikidata.org/wiki/Property:P37) |
| اللغة الأصلية للفيلم | original language of film or TV show | عنصر | [P364](https://www.wikidata.org/wiki/Property:P364) |
| مَن ألّف الكتاب | who wrote the book | عنصر | [P50](https://www.wikidata.org/wiki/Property:P50) |
| كاتب السيناريو | screenwriter | عنصر | [P58](https://www.wikidata.org/wiki/Property:P58) |
| مَن أخرج | who directed it | عنصر | [P57](https://www.wikidata.org/wiki/Property:P57) |
| مَن ابتكر | who created it | عنصر | [P170](https://www.wikidata.org/wiki/Property:P170) |
| مَن لحّن | who composed it | عنصر | [P86](https://www.wikidata.org/wiki/Property:P86) |
| مَن نشر | who published it | عنصر | [P123](https://www.wikidata.org/wiki/Property:P123) |
| متى نُشر أو صدر | when was it published or released | تاريخ | [P577](https://www.wikidata.org/wiki/Property:P577) |
| المقر الرئيسي | headquarters | عنصر | [P159](https://www.wikidata.org/wiki/Property:P159) |
| رئيس الدولة | head of state | عنصر | [P35](https://www.wikidata.org/wiki/Property:P35) |
| رئيس الحكومة | head of government | عنصر | [P6](https://www.wikidata.org/wiki/Property:P6) |
| ارتفاع عن سطح البحر | elevation above sea level | كمية تقارن بالمتر | [P2044](https://www.wikidata.org/wiki/Property:P2044) |
| ارتفاع | height | كمية تقارن بالمتر | [P2048](https://www.wikidata.org/wiki/Property:P2048) |
| طول | length | كمية تقارن بالكيلومتر | [P2043](https://www.wikidata.org/wiki/Property:P2043) |
| مَن تزوّج | who did the person marry | عنصر | [P26](https://www.wikidata.org/wiki/Property:P26) |
| أبناء | children | عنصر | [P40](https://www.wikidata.org/wiki/Property:P40) |
| عدد الأبناء | number of children | كمية بلا وحدة | [P1971](https://www.wikidata.org/wiki/Property:P1971) |
| عدد الموظفين | number of employees | كمية بلا وحدة | [P1128](https://www.wikidata.org/wiki/Property:P1128) |
| عدد الصفحات | number of pages | كمية بلا وحدة | [P1104](https://www.wikidata.org/wiki/Property:P1104) |
| الجوائز التي نالها | awards received | عنصر | [P166](https://www.wikidata.org/wiki/Property:P166) |
| مهنة | occupation | عنصر | [P106](https://www.wikidata.org/wiki/Property:P106) |
| طاقم التمثيل | cast members | عنصر | [P161](https://www.wikidata.org/wiki/Property:P161) |
| مَن اكتشف أو اخترع | who discovered or invented it | عنصر | [P61](https://www.wikidata.org/wiki/Property:P61) |
| بلد المنشأ | country of origin | عنصر | [P495](https://www.wikidata.org/wiki/Property:P495) |
| الشركة المصنعة | manufacturer | عنصر | [P176](https://www.wikidata.org/wiki/Property:P176) |
| المؤسسة الأم | parent organization | عنصر | [P749](https://www.wikidata.org/wiki/Property:P749) |
| المالك | owner | عنصر | [P127](https://www.wikidata.org/wiki/Property:P127) |
| الجهة المشغلة | operator | عنصر | [P137](https://www.wikidata.org/wiki/Property:P137) |
| المدير | director or manager | عنصر | [P1037](https://www.wikidata.org/wiki/Property:P1037) |
| سبب الوفاة | cause of death | عنصر | [P509](https://www.wikidata.org/wiki/Property:P509) |
| العمل السابق | preceding work | عنصر | [P155](https://www.wikidata.org/wiki/Property:P155) |
| البورصة | stock exchange | عنصر | [P414](https://www.wikidata.org/wiki/Property:P414) |
| نسبة المساحة المائية | water as a percentage of area | كمية | [P2927](https://www.wikidata.org/wiki/Property:P2927) |
| النوع الفني | genre | عنصر | [P136](https://www.wikidata.org/wiki/Property:P136) |
| الأجزاء | parts | عنصر | [P527](https://www.wikidata.org/wiki/Property:P527) |

- يقبل المحلل صيغًا من الفصحى ومن الاستعمال الخليجي والمصري والشامي والعراقي، مثل «وش»، و«كام»، و«وين»، و«شنو». يتعرف على صيغة السؤال كاملة، ثم يطبّع ألفاظ الأسماء والأرقام.
- يُفهم عدد السكان على أنه عدد المقيمين. كثافة السكان، والزيادة، والنسبة من السكان تحتاج إلى دلالات أخرى. في أعمال السينما والتلفزيون تميّز الصيغ الصريحة بين تأليف السيناريو والإخراج والتلحين.
- تقتصر القيود الزمنية الطبيعية هنا على السنة الميلادية واختيار الأقدم أو الأحدث من البيانات المسجلة. عبارة «في عام ٢٠٢٠» لا تُربط تلقائيًا بمرحلة بعينها في سؤال ذي أكثر من علاقة. الأسئلة عن الحالات الآنية تحتاج إلى استدلال يثبت سريان العبارة في التاريخ المطلوب.
- تتطلب المفاضلة صفة محددة، كالمساحة أو عدد السكان، أو لفظًا يدل عليها، مثل «الأكثر سكانًا». يُفهم «أكبر بلد» على أنه الأكبر مساحة. ترتيب الفئات يخص البلدان أو المدن في الفهرس. ترتيب النشر يقارن تاريخ أول نشر مسجل لكل عمل.
- «كم عدد الموظفين» يبحث عن كمية مسجلة. «كم جائزة نال» يحصي القيم المميزة في عبارات الجوائز. يذكر الجواب أن نطاقه هو القيم المسجلة.
- سؤال «ما عاصمة البلد الذي وُلد فيه فلان؟» يتبع مكان الميلاد ثم البلد المسجل حيث يلزم، ثم العاصمة. تصف علاقة البلد ما ورد في اللقطة، وقد تختلف عن الحدود يوم الميلاد.
