# تنفيذ Windows والعزل — 8 نوفمبر 2026

**متابعة أحدث:** [جولة 9 نوفمبر](LOCAL-FOLLOWUP-2026-11-09.md) اجتازت اختبار الإدخال في النافذة الأصلية المخصصة، مع استمرار تعثر LPAC. يبقى هذا الملف سجل الإخفاقات والقبول المحدود في 8 نوفمبر دون إعادة تصنيفها.

## النتيجة

**اجتازت حصة القرص الصلبة G2 اختبارًا أصليًا، وبقيت G5 وG8 محجوبتين. التحكم التفاعلي بالنافذة لم يجتز بسبب رفض التركيز.** لا يعني هذا التقرير إكمال البند 3 كله أو تمكين المهارات التنفيذية المستوردة.

## حالة الجهاز النهائية

- وحدتا VHD ثابتتان، كل واحدة 134217728 بايت (128 MiB)، تحت `C:\ProgramData\MohassanAI\quota`؛ مركبتان في `C:\MohassanQuota\slot-0` و`slot-1`.
- مهمة Windows المسجلة `MohassanQuotaAttach` في حالة `Ready` لإعادة وصل الوحدتين عند بدء التشغيل. لم يُختبر إعادة التشغيل الفعلية في هذه الجولة.
- جذر كل وحدة مقيد إلى مستخدم التطبيق وSYSTEM وAdministrators. جرى ضبط **جذر Volume GUID الحقيقي** إضافة إلى نقطة التركيب؛ صلاحية نقطة التركيب وحدها لم تنتقل إلى الملفات داخل VHD.
- سجل الموارد ونسخ DACL محفوظة في `C:\ProgramData\MohassanAI\isolation-admin\state.json`، ومجلده مقيد إلى SYSTEM وAdministrators.
- أُضيف `SANDBOX_QUOTA_ROOT=C:\MohassanQuota` إلى `.env` المحلي، مع الحفاظ على بقية محتواه ودون طباعة إعدادات أخرى. لم يبدأ التطبيق أو عامل إنتاج أو ترحيل قاعدة بيانات.
- **منحة Winsock التجريبية أُزيلت** بإعادة DACL السابق حرفيًا. لا توجد منحة إضافية باقية من هذه الجولة على مفتاح Winsock.

القراءة المرتفعة الأخيرة في `artifacts/isolation-admin-state.json` تثبت تركيب الوحدتين وجاهزية المهمة و`winsockRecorded:false`. تقرير التراجع `artifacts/isolation-winsock-restoration.json` يسجل `success:true` و`restoredExact:true` واحتفاظ الحصة.

## دليل العزل

الفحص الثابت لا يقرأ `.env` ولا يبدأ API أو يتصل بقاعدة بيانات:

```powershell
node --import tsx scripts/check-isolation-completion.ts
```

تقرير `artifacts/windows-isolation-live.json` المنتهي عند `23:01:55 UTC`:

| المجال | النتيجة |
|---|---|
| خط الأساس AppContainer | `available:true` |
| G1، G3، G4، G6، G7 | متحققة ضمن fixtures الثابتة الحالية |
| G2 | `ENOSPC` بعد كتابة 120586240 بايت؛ السعة التي قرأها المشغل الأصلي من Windows تساوي 133099520 بايت |
| G5 | علامة LPAC الأصلية مثبتة، لكن Node لم يبدأ وأعاد `WSAStartup 10107` |
| G8 | غير مقبولة؛ مستقبلات المضيف عملت قبل وبعد، لكن عدم بدء Node تحت LPAC يمنع إثبات المنع داخل العملية |
| المهارات المستوردة | `enabled:false` |

أُجري هذا الفحص أثناء وجود منحة Winsock المحددة. أُعيدت المنحة بعد ثبوت عدم فائدتها، ثم أُعيد **فحص بدء LPAC فقط** في `artifacts/windows-lpac-after-restore.json` عند `23:03:24 UTC`: المصدر ثابت، `lowPrivilege:true`، و`started:false`، والخطأ نفسه 10107. لا يُنسب فحص شامل جديد إلى ما بعد التراجع؛ الحصة ومهمة تركيبها لم تتغير بالتراجع.

```powershell
node --import tsx scripts/check-isolation-completion.ts --lpac-only
```

لم تُضف قدرة `registryRead` أو قدرة شبكة، ولم تُخفف متطلبات G5/G8 أو يُحوّل غياب الرسائل الشبكية إلى نجاح.

## الإصلاحات المنفذة

1. **قراءة/كتابة ACL في Windows PowerShell 5.1:** كان `Get-Acl` يبلغ `PathNotFound` لمفتاح Winsock الموجود. استُخدم Registry64 وواجهات .NET للمفتاح الثابت فقط، مع إبقاء نسخ DACL ومقارنة التعارض والتراجع الدقيق.
2. **صلاحيات VHD:** كان السكربت يعدل نقطة التركيب، بينما ترث الملفات داخل الوحدة DACL مختلفة من جذرها الحقيقي. جرى التحقق من DiskImage والسعة وPartition ونقطة التركيب، ثم ضبط Volume GUID المسجل. سجلت الصلاحيات الأصلية والمتوقعة قبل الكتابة.
3. **تحقق DACL المحضرة:** يضيف Windows العلامة `AI` بعد تطبيق DACL محمية. يقبل الفاحص تلك الإضافة وحدها مع بقاء علامة الحماية `P` وكل ACE مطابقة؛ يرفض إضافة أي صلاحية أو إزالة الحماية. يُحفظ descriptor الفعلي بعد التحقق.
4. **جذر VHD الفارغ في Node:** أعاد `readdir` خطأ `ENOENT` للجذر الفارغ رغم وجوده وإمكان إنشاء مجلد فيه. يعامل موفر الحصص هذه الحالة كفراغ على Windows فقط بعد `stat` يؤكد أن الجذر دليل موجود. يبقى المشغل الأصلي ملزمًا بإثبات أنه وحدة منفصلة محدودة قبل بدء أي كود.

جميع حالات التثبيت الجزئي شُخّصت وأُكملت؛ الحالة النهائية ليست تثبيتًا جزئيًا مجهولًا. منحة Winsock غير النافعة عادت إلى أصلها، والحصة المثبتة بقيت معدة.

## التحكم بالنافذة

أعاد الاختبار الأصلي `FOCUS_DENIED` لكل من الفأرة والكتابة، و`clicks:0` ونصًا فارغًا. التقط UIA وJPEG بنجاح، لكن هذا لا يثبت صلاحية الإدخال. التقارير في `artifacts/windows-native-before.json` و`windows-native-interactive.json`.

التغييرات في `apps/windows/Companion.cs`:

- انتظار محدود لـ`WM_NULL` بعد طلب التركيز، مع رفض timeout؛ لا إلحاق input queues أو حقن مفاتيح لانتزاع التركيز.
- إعادة التحقق من هوية الهدف والتركيز والصلاحية ومفاتيح التعديل مباشرة قبل `SendInput`.
- فحص النافذة الواقعة تحت نقطة النقر أو التمرير، وتوجيه التمرير إلى داخل النافذة المستهدفة.
- إعادة التحقق من انتهاء الأمر وحداثة الصورة خلال callback الصلاحية، بما يشمل انتظار التركيز.
- نافذة fixture تتيح انتظارًا محدودًا للتنشيط المعتاد؛ انتهاء الانتظار يبقى إخفاقًا حقيقيًا.

توضح [وثائق Microsoft](https://devblogs.microsoft.com/oldnewthing/20161118-00/?p=94745/) أن تنشيط نافذة على thread آخر قد يتأخر عن عودة `SetForegroundWindow`، وتبقى [قيود Windows على منح التركيز](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setforegroundwindow) واجبة. هذه إصلاحات للحراسة والتوقيت، **وليست إثباتًا أن رفض التركيز البيئي حُلّ**.

علقت محاولة تنشيط fixture بمهارة Computer Use ثم أُجهضت. لم تتكرر، ولم تُستخدم للتحكم في نافذة مستخدم أو لقبول UAC. لا توجد عملية fixture باقية من تلك المحاولة وفق فحص العمليات اللاحق.

نجح تجميع المصدر الأصلي النهائي بـC#؛ البصمة في `artifacts/windows-native-build-final.json`. لم يُعد الاختبار التفاعلي على النسخة النهائية بعد تعذر أداة التنشيط؛ يلزم إعادة قبول حي في جلسة تسمح بتنشيط نافذة fixture.

## الاختبارات غير التفاعلية

```powershell
npm test -- packages/windows/src/windows.test.ts packages/sandbox/src/quota.test.ts tests/isolation-admin-plan.test.ts -t 'Windows device permissions|quota slot leases|native helper proves|administrator isolation plan' --reporter=json --outputFile=artifacts/windows-noninteractive-final.json
```

النتيجة: **22 نجاحًا، صفر إخفاقات، واختبار GUI واحد مستبعد باختيار الأسماء من أصل 23**. التقرير يجمع اختبارات صلاحيات الجهاز والنقل، وتأجير الحصص والرفض الأصلي للمجلد غير المحدود، وخطة المسؤول واستعادة ACL ورفض التغييرات الخارجية. الاستبعاد ليس نجاحًا ولا يلغي إخفاق GUI السابق. لا تُجمع أعداد الجولات المتداخلة.

## الإعداد والتراجع

لتهيئة الحصة على جهاز Windows آخر، يراجع المسؤول `-PlanOnly` ثم ينفذ **الحصة فقط**:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\isolation-admin-setup.ps1 -Quota -PlanOnly
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\isolation-admin-setup.ps1 -Quota
```

`-LpacWinsock` خيار تشخيصي منفصل ثبت أنه غير كافٍ لهذه البيئة؛ لا يوصى باعتباره إعدادًا يحل LPAC. ملفات launch/inspect/complete/restore الإضافية توثق إجراءات هذه الجولة بمساراتها الثابتة، ولا يستدعيها التطبيق تلقائيًا.

إن اختار المالك إزالة الحصة لاحقًا، يوقف عمال العزل أولًا ثم يستخدم من PowerShell مرتفع:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\isolation-admin-setup.ps1 -Quota -Undo
```

يفحص التراجع manifest وهوية الوحدات وأقفال التشغيل وDACL وبصمة سكربت المهمة؛ لا يحذف موارد غير مسجلة أو يعيد تهيئة قرص. يُزال إعداد `SANDBOX_QUOTA_ROOT` بعد نجاحه. لم يُنفذ تراجع الحصة في هذه الجولة لأن G2 اجتازت.

المتبقي: تشخيص توافق Node/LPAC دون توسيع صلاحيات السجل على أساس تخمين، ثم إثبات G5/G8؛ وقبول التحكم الحي بالنافذة بصورة مستقلة. المهارات المستوردة تبقى محجوبة حتى ذلك.
