# تسليم: ربط باني المواقع بالمحادثة (2026-11-22)

جلسة باني المواقع (Claude) تضيف أسطراً قليلة إلى ملفات مشتركة يعدّلها وكلاء آخرون اليوم. كل المنطق في ملفات
جديدة؛ هذه قائمة الأسطر المشتركة بالضبط كي يُعاد تطبيقها إن طُمست.

## ملفات جديدة (ملك جلسة باني المواقع)
- `apps/server/src/assistant/site-builder.ts` — `siteTask`، `siteCard`، `siteAnswers`، `buildSiteReply`، `siteCommandTurn`، `SitesChatPort`.
- `apps/server/src/sites.ts`، `apps/server/src/sites-publish.ts`، `packages/sites/**`، `packages/contracts/src/sites.ts`، `apps/web/components/sites-workspace.*`، `tests/sites-*.test.ts`.

## الأسطر المضافة إلى الملفات المشتركة

### `apps/server/src/assistant/brain.ts` (داخل `BrainState` بعد `planner?`)
```ts
  /** A website being collected or edited in this conversation (packages/sites, no model). Only code sets this. */
  site?: import('./site-builder.js').SiteChatState | null;
  siteId?: string | null;
  sitePendingWant?: { want: import('@mohassan/contracts').SiteWant; title?: string } | null;
```

### `apps/server/src/assistant/hands.ts`
- استيراد: `import { isSiteRequest } from '@mohassan/sites';`
- في `notWebReason`: إضافة `'site'` إلى نوع الإرجاع، وبعد فحص `empty` مباشرة: `if (isSiteRequest(text)) return 'site';`
  (قبل `isDocumentRequest`، لأن «اكتب لي موقع» يلتقطها كاتب الرسائل والمستندات.)

### `apps/server/src/command-chat.ts`
- استيراد: `import { buildSiteReply, siteAnswers, siteCard, siteCommandTurn, siteTask, type SitesChatPort } from './assistant/site-builder.js';`
- `CommandChatConfig`: `sites?: SitesChatPort;`
- قوائم الحراسة: إضافة `!state.site` إلى `freshLiteral`، `desktopFresh`، `intrinsicAllowed`، وشرط البحث الافتراضي؛ و`state.site ||` إلى شرط «طلب جارٍ».
- شرط `questionAnswer` عند الاستئناف: `(state.writer || state.planner || state.document || state.site)`.
- كتلة الموقع **قبل** كتلة التوضيح («ما الشيء الذي تقصده؟») وقبل مسار البحث الافتراضي (مُعلَّمة بـ `A website without a model`):
  «فيه الأسئلة الشائعة» تعود على الموقع، و«غيّر اللون إلى أزرق» بعد البناء تعديل لا بحث.
- في `send()` عند إنشاء `initialState` لرسالة جديدة: نقل `siteId` و`sitePendingWant` من `previousRun.state` كي تبقى المحادثة على موقعها.

### `apps/server/src/app.ts`
- `sites` control: `createSitesControl` + `registerSiteRoutes` قبل `registerMemberRoutes`؛ `sitesAvailable:()=>true`.
- في `createCommandChatControl`: `sites:{createFromBrief,command,detail,roleOf}` بعد `...(adsModel?{adsModel}:{}),`.

### `apps/server/src/members.ts`
- `PUBLIC_ROUTES`: `GET /api/sites/:id/p/:token/*`؛ `MEMBER_ROUTES`: مسارات `/api/sites` عدا `publish`؛ خدمة `sites` في `/api/access`.

### `apps/web`
- `workspace.tsx`: عرض `sites` + عنصر القائمة + `#sites=<id>`؛ `members.tsx`: قسم المواقع للأعضاء؛ `app/api/[...path]/route.ts`: حدّ 1.5 MB لصور المواقع و256 KB للبريف ومهلة 300 ث للنشر.

## الاختبارات
`npx vitest run tests/sites-recognize.test.ts tests/sites-plan.test.ts tests/sites-commands.test.ts tests/sites-theme-copy.test.ts tests/sites-compose.test.ts tests/sites-api.test.ts tests/sites-chat.test.ts tests/members-access.test.ts`
