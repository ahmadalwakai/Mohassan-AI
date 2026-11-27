export type ReplyLanguage = 'ar' | 'en';

// Existing detector retrieved 2026-11-27.
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/apps/server/src/assistant/reply-directive.ts#L194
/** Select the language by the letters in the user's request. */
export const requestLanguage = (text: string): ReplyLanguage => /\p{Script=Arabic}/u.test(text) ? 'ar' : 'en';

type BilingualMessage = Readonly<Record<ReplyLanguage, string>>;

// The Arabic copy comes from the production handlers at 29448ae, retrieved 2026-11-27.
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/apps/server/src/command-chat.ts
export const replyMessages = {
  runTimeLimit: {
    ar: 'استغرقت هذه المهمة وقتًا طويلًا. أرسل «تابع» وسأكمل من حيث توقفت.',
    en: 'This task took too long. Send “continue” and I’ll pick up where I left off.',
  },
  runFailure: {
    ar: 'حدث خطأ أثناء العمل. أرسل «تابع» وسأحاول مجددًا.',
    en: 'Something went wrong while I was working. Send “continue” and I’ll try again.',
  },
  toolFailure: { ar: 'تعذر إكمال هذه الخطوة.', en: 'I couldn’t complete this step.' },
  memorySearch: { ar: 'البحث في الذاكرة', en: 'Searching memory' },
  memoryMiss: { ar: 'لم أجد في الذاكرة قيمة مطابقة للطلب.', en: 'I couldn’t find a matching value in memory.' },
  memoryUnverified: { ar: 'لم أتمكن من التحقق من قيمة مطابقة في الذاكرة.', en: 'I couldn’t verify a matching value in memory.' },
  indexedCopy: { ar: 'نسخة مفهرسة بتاريخ', en: 'indexed copy from' },
  rate_limited: { ar: 'تجاوز حد الطلبات', en: 'rate limited' },
  invalid_response: { ar: 'استجابة غير صالحة', en: 'invalid response' },
  unavailable: { ar: 'غير متاح', en: 'unavailable' },
} satisfies Record<string, BilingualMessage>;

// Browser engine error pairs retrieved 2026-11-27.
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448aea3fa10d226ef82ec5bf0a65e723d6ec39/packages/browser/src/engine.ts
const browserNavigationFailure = {
  codes: ['BROWSER_NAVIGATION_FAILED'],
  ar: 'تعذر فتح الصفحة ضمن الوقت والنطاق المسموح.',
  en: 'The page could not be opened within the allowed time and scope.',
} as const;

// A navigation failure can carry the exact message of an earlier route denial.
const BROWSER_ERRORS: readonly (BilingualMessage & { readonly codes: readonly string[] })[] = [
  browserNavigationFailure,
  {
    codes: ['BROWSER_UNAVAILABLE'],
    ar: 'تعذر تشغيل Chromium المستقل. تأكد من تثبيت متصفح Playwright.',
    en: 'Could not start the standalone Chromium browser. Check that the Playwright browser is installed.',
  },
  {
    codes: ['BROWSER_RESOURCE_LIMIT'],
    ar: 'أغلق جلسة متصفح قبل إنشاء جلسة إضافية.',
    en: 'Close a browser session before starting another one.',
  },
  {
    codes: ['BROWSER_SESSION_CLOSED', 'BROWSER_NAVIGATION_FAILED'],
    ar: 'انتهى تفويض الجلسة.',
    en: 'The session authorization has expired.',
  },
  {
    codes: ['BROWSER_REQUEST_LIMIT', 'BROWSER_NAVIGATION_FAILED'],
    ar: 'تجاوزت الصفحة عدد طلبات الجلسة المسموح.',
    en: 'The page exceeded the session\'s request limit.',
  },
  {
    codes: ['BROWSER_SUBMIT_DENIED', 'BROWSER_NAVIGATION_FAILED'],
    ar: 'تنقل الصفحة أو الإرسال التلقائي يحتاج فعلًا محددًا من جلسة المتصفح.',
    en: 'Page navigation or automatic submission requires a specific action from the browser session.',
  },
  {
    codes: ['BROWSER_SUBMIT_DENIED', 'BROWSER_NAVIGATION_FAILED'],
    ar: 'طلب إرسال بلا موافقة مطابقة للوجهة والقيم.',
    en: 'The destination and values of the submission do not match an approval.',
  },
  {
    codes: ['BROWSER_RESOURCE_DENIED', 'BROWSER_NAVIGATION_FAILED'],
    ar: 'هذا المورد خارج نطاق جلسة القراءة.',
    en: 'This resource is outside the scope of the read session.',
  },
  {
    codes: ['BROWSER_SUBMIT_DENIED', 'BROWSER_NAVIGATION_FAILED'],
    ar: 'لم يُعد إرسال النموذج إلى وجهة تحويل جديدة؛ يلزم إذن مستقل.',
    en: 'The form was not resubmitted to the redirect destination. That destination requires separate approval.',
  },
  {
    codes: ['BROWSER_SUBMIT_DENIED', 'BROWSER_NAVIGATION_FAILED'],
    ar: 'لم يُكرر طلب إرسال أثناء تحويل مورد الصفحة.',
    en: 'The submission was not repeated during the resource redirect.',
  },
  {
    codes: ['BROWSER_REDIRECT_LIMIT', 'BROWSER_NAVIGATION_FAILED'],
    ar: 'تجاوز المورد حد إعادة التوجيه.',
    en: 'The resource exceeded the redirect limit.',
  },
  {
    codes: ['BROWSER_SESSION_STALE'],
    ar: 'انتهت جلسة التشغيل. افتح العنوان مجددًا لاستئناف القراءة بجلسة مستقلة.',
    en: 'The browser session has expired. Reopen the address to continue reading in a new session.',
  },
  {
    codes: ['BROWSER_PAGE_TIMEOUT'],
    ar: 'لم تستجب الصفحة ضمن المهلة. أُغلقت جلسة التشغيل وبقيت الأدلة السابقة محفوظة.',
    en: 'The page did not respond in time. The browser session was closed and the earlier evidence was saved.',
  },
  {
    codes: ['BROWSER_NAVIGATION_FAILED'],
    ar: 'تجاوز فتح الصفحة والتحويلات المهلة المسموحة.',
    en: 'Opening the page and following redirects exceeded the time limit.',
  },
  {
    codes: ['BROWSER_REDIRECT_LIMIT'],
    ar: 'تجاوزت الصفحة حد إعادة التوجيه.',
    en: 'The page exceeded the redirect limit.',
  },
  {
    codes: ['BROWSER_OBSERVATION_CHANGED'],
    ar: 'تغير الحقل أو ارتباطه بالصفحة؛ اقرأ الصفحة مجددًا قبل التعبئة.',
    en: 'The field or its connection to the page changed. Read the page again before filling it in.',
  },
  {
    codes: ['BROWSER_SENSITIVE_FORM'],
    ar: 'الحقل غير قابل للتعبئة أو يحتوي بيانات دخول أو دفع أو بيانات حساسة.',
    en: 'This field cannot be filled in or contains sensitive, sign-in, or payment information.',
  },
  {
    codes: ['BROWSER_FORM_INVALID'],
    ar: 'قيمة القائمة غير موجودة في الحقل.',
    en: 'The selected option is not available in this field.',
  },
  {
    codes: ['BROWSER_FORM_CHANGED'],
    ar: 'تغير الحقل أثناء التعبئة؛ لم يُرسل نموذج.',
    en: 'The field changed while it was being filled in. No form was submitted.',
  },
  {
    codes: ['BROWSER_FORM_CHANGED'],
    ar: 'تغير النموذج أو زر الإرسال أو ترميزه؛ اقرأ الصفحة وراجع الوجهة من جديد.',
    en: 'The form, submit button, or encoding changed. Read the page and review the destination again.',
  },
  {
    codes: ['BROWSER_FORM_ENCODING'],
    ar: 'تجاوز جسم النموذج حد الإرسال المسموح.',
    en: 'The form body exceeded the size limit for submission.',
  },
  {
    codes: ['BROWSER_OBSERVATION_CHANGED'],
    ar: 'تغيرت الصفحة أو النموذج؛ اقرأ الصفحة مجددًا قبل طلب الموافقة.',
    en: 'The page or form changed. Read the page again before asking for approval.',
  },
  {
    codes: ['BROWSER_FORM_INVALID'],
    ar: 'قيم النموذج خارج الحقول المرصودة أو تتجاوز الحد.',
    en: 'The values fall outside the observed form fields or exceed the allowed limit.',
  },
  {
    codes: ['BROWSER_SENSITIVE_FORM'],
    ar: 'النموذج يحتوي حقول دخول أو دفع تتطلب نطاق صلاحية مستقلًا.',
    en: 'The form contains sign-in or payment fields that require separate authorization.',
  },
  {
    codes: ['BROWSER_SENSITIVE_FORM'],
    ar: 'لا تقبل هذه الجلسة كلمات المرور أو بيانات الدفع أو الحقول الحساسة.',
    en: 'This session does not accept passwords, payment details, or sensitive fields.',
  },
  {
    codes: ['BROWSER_FORM_INVALID'],
    ar: 'قيمة القائمة غير موجودة في النموذج.',
    en: 'The selected option is not available in this form.',
  },
  {
    codes: ['BROWSER_OBSERVATION_CHANGED'],
    ar: 'تغير زر الإرسال أو ارتباطه بالنموذج.',
    en: 'The submit button or its connection to the form changed.',
  },
  {
    codes: ['BROWSER_BUTTON_DENIED'],
    ar: 'هذا الزر لا يملك إرسال نموذج معروفًا يمكن مراجعته والموافقة عليه.',
    en: 'This button has no known form submission to review and approve.',
  },
  {
    codes: ['BROWSER_BUTTON_DENIED'],
    ar: 'الزر لا يرتبط بنموذج إرسال معروف؛ لم يُنقر الزر.',
    en: 'The button is not associated with a known form submission, so it was not clicked.',
  },
  {
    codes: ['BROWSER_FORM_CHANGED'],
    ar: 'تغيرت القيم أو زر الإرسال بعد الموافقة؛ لم يُرسل الطلب.',
    en: 'The values or submit button changed after approval. The request was not sent.',
  },
  {
    codes: ['BROWSER_FORM_CHANGED'],
    ar: 'تغير جسم النموذج بعد مراجعته؛ لم يُرسل الطلب.',
    en: 'The form body changed after review. The request was not sent.',
  },
  {
    codes: ['BROWSER_SUBMIT_UNKNOWN'],
    ar: 'بدأت محاولة الطلب ولم تثبت نتيجتها. راجع الصفحة قبل أي إرسال جديد؛ لن يكرر النظام الطلب.',
    en: 'The request was attempted, but its outcome could not be confirmed. Review the page before submitting again. The system will not repeat the request.',
  },
  {
    codes: ['BROWSER_SUBMIT_FAILED'],
    ar: 'لم يثبت إرسال النموذج؛ اقرأ الصفحة واطلب موافقة جديدة.',
    en: 'The form submission could not be confirmed. Read the page and ask for approval again.',
  },
  // Snapshot policy error and its navigation wrapper, retrieved 2026-11-27.
  // https://github.com/ahmadalwakai/Mohassan-AI/blob/2a4498e1de09edf9c4a7b2847754d197e5146b85/packages/browser/src/effect-policy.ts#L42
  {
    codes: ['GOOGLE_ADS_TYPED_API_REQUIRED', 'BROWSER_NAVIGATION_FAILED'],
    ar: 'تغييرات Google Ads تحتاج التكامل الرسمي المربوط بالحساب والموافقة والقراءة اللاحقة؛ استخدم مسار Google Ads لإعداد التغيير ومراجعته. لم يُرسل طلب المتصفح.',
    en: 'Changes to Google Ads require the official integration with a linked account, approval, and verification afterward. Use the Google Ads flow to prepare and review the change. No browser request was sent.',
  },
];

export function browserErrorReply(error: { code: string; message: string }, lang: ReplyLanguage): string | undefined {
  const message = BROWSER_ERRORS.find(({ codes, ar }) => codes.includes(error.code) && ar === error.message);
  if (message) return message[lang];
  // Navigation can wrap a lower-level Arabic network diagnostic. Keep the generic English navigation reply.
  if (lang === 'en' && error.code === 'BROWSER_NAVIGATION_FAILED' && requestLanguage(error.message) === 'ar') {
    return browserNavigationFailure.en;
  }
  return undefined;
}

export type ReplyMessageKey = keyof typeof replyMessages;

export function replyMessage(request: string, key: ReplyMessageKey): string {
  return replyMessages[key][requestLanguage(request)];
}

// An error carries the original diagnostics. Display text is resolved separately at the reply boundary.
const errorReplies = new WeakMap<Error, BilingualMessage>();

export function withReplyMessage<T extends Error>(error: T, message: ReplyMessageKey | BilingualMessage): T {
  errorReplies.set(error, typeof message === 'string' ? replyMessages[message] : message);
  return error;
}

export function replyMessageForError(error: Error, language: ReplyLanguage): string | undefined {
  return errorReplies.get(error)?.[language];
}

export function indexedCopySnippet(request: string, fetchedAt: string | undefined, snippet: string): string {
  return fetchedAt ? `${replyMessage(request, 'indexedCopy')} ${fetchedAt}. ${snippet}` : snippet;
}

export type SearchFailure = { provider: string; kind: 'rate_limited' | 'invalid_response' | 'unavailable' };

export function searchFailureDetails(failures: readonly SearchFailure[], lang: ReplyLanguage): string {
  return failures.map(({ provider, kind }) => `${provider}: ${replyMessages[kind][lang]}`).join(lang === 'ar' ? '، ' : ', ');
}

// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/apps/server/src/assistant/hands.ts#L1361-L1363 (retrieved 2026-11-27)
export function searchFailureReply(query: string, failures: readonly SearchFailure[], lang = requestLanguage(query)): string {
  const details = searchFailureDetails(failures, lang);
  const description = details ? ` (${details})` : '';
  return lang === 'ar'
    ? `تعذّر البحث عن «${query}»: مصادر البحث لم تستجب الآن${description}. هذا فشل في الطلب، لا بحث بلا نتائج. أعد المحاولة بعد قليل.`
    : `The search for “${query}” failed: the search sources did not answer just now${description}. This is a failed request, not a search without results. Please try again shortly.`;
}

/** PDF edit diagnostics and their English equivalents. The worker's codes and statuses remain in the PDF package. */
// Original diagnostics retrieved 2026-11-27:
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448aea3fa10d226ef82ec5bf0a65e723d6ec39/packages/pdf/src/edit.ts#L19-L27
export function pdfEditMessages(limits: { pages: number; inputFiles: number; inputBytes: number }) {
  return {
    worker: {
      PDF_INVALID: { ar: 'ملف PDF غير صالح أو تعذرت قراءته.', en: 'The PDF is invalid or could not be read.' },
      PDF_ENCRYPTED: { ar: 'ملفات PDF المشفرة أو المحمية بكلمة مرور غير مدعومة.', en: 'Encrypted or password-protected PDFs are unsupported.' },
      PDF_PAGE_LIMIT: { ar: `عدد الصفحات يتجاوز ${limits.pages} صفحة.`, en: `The PDF exceeds the limit of ${limits.pages} pages.` },
      PDF_PAGE_RANGE: { ar: 'أرقام الصفحات خارج نطاق الملف.', en: 'The page numbers are outside the range of the PDF.' },
      PDF_OUTPUT_LIMIT: { ar: 'الملف الناتج أكبر من المسموح.', en: 'The resulting file is larger than allowed.' },
      PDF_PARAMS: { ar: 'معاملات التعديل غير صالحة.', en: 'The PDF edit parameters are invalid.' },
      PDF_EDIT_FAILED: { ar: 'تعذر تعديل ملف PDF.', en: 'The PDF could not be edited.' },
    },
    invalidInput: (position: number) => ({ ar: `الملف ${position} ليس ملف PDF.`, en: `File ${position} is not a PDF.` }),
    oversizedInput: (position: number) => ({ ar: `حجم الملف ${position} يتجاوز ${Math.round(limits.inputBytes / 1_000_000)} ميغابايت.`, en: `File ${position} exceeds the ${Math.round(limits.inputBytes / 1_000_000)} MB limit.` }),
    inputCount: { ar: `يمكن معالجة من ملف واحد إلى ${limits.inputFiles} ملفًا في العملية الواحدة.`, en: `Process between one and ${limits.inputFiles} files per operation.` },
    aborted: { ar: 'أُلغي تعديل PDF.', en: 'The PDF edit was cancelled.' },
    busy: { ar: 'معالجة الملفات مشغولة؛ أعد المحاولة بعد قليل.', en: 'The PDF service is busy. Try again shortly.' },
    timeout: { ar: 'تجاوز تعديل PDF المهلة المسموحة.', en: 'The PDF edit exceeded the time limit.' },
    resources: { ar: 'تعذر تعديل PDF ضمن حدود الموارد.', en: 'The PDF could not be edited within the resource limits.' },
    earlyExit: { ar: 'توقفت معالجة PDF قبل اكتمالها.', en: 'PDF processing stopped before it finished.' },
    mergeCount: { ar: 'الدمج يحتاج ملفين على الأقل.', en: 'Merging requires at least two files.' },
    noPages: { ar: 'لم أجد أرقام صفحات في الطلب.', en: 'I could not find any page numbers in the request.' },
  };
}

// English equivalents of existing render and document diagnostics, retrieved 2026-11-27:
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448aea3fa10d226ef82ec5bf0a65e723d6ec39/packages/pdf/src/render.ts#L86-L131
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448aea3fa10d226ef82ec5bf0a65e723d6ec39/apps/server/src/documents.ts#L80-L162
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448aea3fa10d226ef82ec5bf0a65e723d6ec39/apps/server/src/assistant/document-reader.ts#L45-L62
const PDF_PROBLEMS: Readonly<Record<string, string>> = {
  PDF_RENDER_CLOSED: 'The PDF service is shutting down.',
  PDF_RENDER_UNAVAILABLE: 'The PDF renderer could not start. Install Chromium with `npx playwright install chromium`.',
  PDF_RENDER_INPUT: 'The provided content could not be used to create a PDF.',
  PDF_RENDER_ABORTED: 'PDF creation was cancelled.',
  PDF_RENDER_FAILED: 'The PDF could not be created from this content.',
  PDF_RENDER_TIMEOUT: 'PDF creation exceeded the time limit.',
  DOCUMENT_NOT_FOUND: 'I could not find the requested PDF.',
  DOCUMENT_INPUT_COUNT: 'This operation requires exactly one file.',
  DOCUMENT_MISSING: 'The PDF is no longer on disk.',
  DOCUMENT_CHANGED: 'The file changed on disk and could not be delivered.',
  DOCUMENT_PATH_DENIED: 'The PDF is outside the files I am allowed to read.',
  DOCUMENT_FORMAT: 'The path must point to a .pdf file.',
  DOCUMENT_LINK_DENIED: 'Symbolic links cannot be used as a PDF source.',
  DOCUMENT_NAME_AMBIGUOUS: 'Several PDFs have that name in this conversation. Specify which copy to use.',
};

export function pdfProblemMessage(request: string, error: Error & { code: string }, limits: Parameters<typeof pdfEditMessages>[0]): string {
  const lang = requestLanguage(request);
  const edit = replyMessageForError(error, lang);
  if (edit !== undefined) return edit;
  const { worker } = pdfEditMessages(limits);
  if (Object.hasOwn(worker, error.code)) return worker[error.code as keyof typeof worker][lang];
  if (error.code === 'PDF_SIZE_LIMIT' && lang === 'en') return `The PDF exceeds the ${Math.round(limits.inputBytes / 1_000_000)} MB limit.`;
  if (Object.hasOwn(PDF_PROBLEMS, error.code) || error.code === 'PDF_SIZE_LIMIT') {
    if (lang === 'ar' && requestLanguage(error.message) === 'ar') return error.message;
    if (lang === 'en') return PDF_PROBLEMS[error.code]!;
  }
  return lang === 'ar' ? 'تعذر إكمال خطوة معالجة ملف PDF.' : 'The PDF step did not complete.';
}

// Source refusal and guard diagnostics retrieved 2026-11-27:
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448aea3fa10d226ef82ec5bf0a65e723d6ec39/apps/server/src/assistant/unsupported-request.ts#L165-L173
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448aea3fa10d226ef82ec5bf0a65e723d6ec39/apps/server/src/command-chat.ts#L343-L353
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448aea3fa10d226ef82ec5bf0a65e723d6ec39/packages/browser/src/search/engine.ts#L44-L46
const SEARCH_REFUSALS: Readonly<Record<string, { ar: string; en: string }>> = {
  ASSISTANT_SEARCH_PROVENANCE: {
    ar: 'لم أستطع ربط بعض كلمات البحث بطلبك أو بمصدر عام قرأته. استخدم كلمات الطلب أو المصادر العامة المتاحة.',
    en: 'I could not trace some search terms back to your request or to a public source I read. Use terms from the request or an available public source.',
  },
  RESEARCH_QUERY_INVALID: {
    ar: 'اكتب موضوعًا محددًا للبحث، واستخدم site: مع اسم نطاق صالح فقط.',
    en: 'Enter a specific search topic. If you use site:, give a valid domain name.',
  },
  RESEARCH_QUERY_SECRET: {
    ar: 'أزل بيانات الاعتماد من الاستعلام قبل البحث العام.',
    en: 'Remove credentials from the query before searching the public web.',
  },
};

export function searchRefusalMessage(request: string, query: string, code: string): string {
  const lang = requestLanguage(request);
  if (code === 'ASSISTANT_SEARCH_SOURCE') {
    const shown = query.trim().slice(0, 80);
    return lang === 'ar'
      ? `لم أبحث في الويب عن «${shown}»: يبدو الطلب متعلقًا بمعلومات خاصة، أو بمرجع غير محدد، أو بفعل لا أنفّذه بنفسي، ولا أحوّل مثل هذا إلى بحث عام.\n\nإن كان سؤالًا عامًا فاكتبه سؤالًا كاملًا مثل «ما هو …؟»، أو أرسل رابط الموقع المقصود وأقرأه لك.`
      : `I did not search the web for “${shown}”: the request looks tied to private information, an unspecified reference, or an action I do not perform myself, and I do not turn such requests into a public search.\n\nIf it is a general question, write it in full, such as “what is …?”, or send the website’s link and I will read it for you.`;
  }
  if (Object.hasOwn(SEARCH_REFUSALS, code)) return SEARCH_REFUSALS[code]![lang];
  return lang === 'ar' ? 'لم أتمكن من استخدام هذا الاستعلام في البحث العام.' : 'I could not use this query to search the public web.';
}

// Agent-browser and model failure diagnostics retrieved 2026-11-27. These defaults cover errors that
// do not carry a catalogue entry and whose diagnostic text is in a different language from the request.
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/packages/browser/src/agent-browser.ts
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/apps/server/src/assistant/model-failure.ts
const TERMINAL_ERRORS: Readonly<Record<string, BilingualMessage>> = {
  AGENT_BROWSER_UNAVAILABLE: {
    ar: 'تعذر تشغيل المتصفح. ثبّت كروميوم بالأمر `npx playwright install chromium`.',
    en: 'The browser could not start. Check that Chromium is installed. Run `npx playwright install chromium` if needed.',
  },
  AGENT_NAVIGATION_FAILED: {
    ar: 'تعذر فتح الصفحة. قد يكون الموقع متوقفًا أو الرابط خاطئًا.',
    en: 'I could not open the page. The website may be down or the link may be incorrect.',
  },
  AGENT_NETWORK_DENIED: {
    ar: 'تعذر فتح العنوان ضمن صلاحيات هذه الجلسة.',
    en: 'I could not open that address within the permissions for this session.',
  },
  AGENT_EFFECT_UNKNOWN: {
    ar: 'بدأت محاولة الطلب ولم تُحسم النتيجة. راجع أثره قبل إعادة التنفيذ.',
    en: 'The request was attempted and its outcome is uncertain. Review the result before trying again.',
  },
  AGENT_EFFECT_DENIED: {
    ar: 'حُجب الإجراء لأنه يحتاج موافقة مطابقة. لم يُرسل الطلب.',
    en: 'The action requires matching approval. The request was not sent.',
  },
  AGENT_APPROVAL_STALE: {
    ar: 'لم تعد الموافقة صالحة لهذا الطلب. لم يُرسل الطلب.',
    en: 'The approval is no longer valid for this request. The request was not sent.',
  },
  AGENT_RECOVERY_REVIEW_REQUIRED: {
    ar: 'يوجد أثر غير محسوم؛ اقرأ نتيجته وراجعها قبل أي فعل جديد.',
    en: 'A previous action has an uncertain outcome. Review its result before taking another action.',
  },
  CHAT_ACTION_REVIEW_REQUIRED: {
    ar: 'لم أتحقق من سجل إجراءات صالح يسمح بمتابعة هذا الإجراء.',
    en: 'I could not verify an action history that allows this step to continue.',
  },
  CHAT_GATEWAY_UNREACHABLE: {
    ar: 'بوابة النماذج المجانية لا تستجيب. راجع إعدادات الاتصال ثم أرسل «تابع».',
    en: 'The FreeLLMAPI gateway is unreachable, so the request did not reach a model. Check the gateway connection and send “continue”.',
  },
  CHAT_GATEWAY_NO_PROVIDERS: {
    ar: 'بوابة النماذج المجانية متصلة، لكن لا يوجد فيها مفتاح مزود.',
    en: 'FreeLLMAPI is connected, but it has no provider key. Add a provider key and send “continue”.',
  },
  CHAT_PROVIDER_REJECTED: {
    ar: 'رفض مزود النموذج مفتاح الاتصال أو صلاحية الحساب.',
    en: 'The model provider rejected the key or account permissions. Update the connection settings and send “continue”.',
  },
  CHAT_PROVIDER_NOT_CONFIGURED: {
    ar: 'لم يُهيأ مزود نموذج للمحادثة على الخادم.',
    en: 'No chat model provider is configured on the server. Check Advanced tools → Connections.',
  },
  CHAT_MODEL_UNAVAILABLE: {
    ar: 'النموذج المحدد غير متاح لدى المزود أو لا يدعم هذا الطلب.',
    en: 'The selected model is unavailable or does not support this request. Check the model name in the server settings.',
  },
  CHAT_PROVIDER_QUOTA: {
    ar: 'نفدت الحصة المتاحة لدى مزود النموذج. حُفظت الصفحة والخطوات.',
    en: 'The model provider’s quota is exhausted. The page and steps were saved.',
  },
  ASSISTANT_MODEL_BUSY: {
    ar: 'النماذج المتاحة مشغولة الآن. حُفظت الصفحة والخطوات.',
    en: 'The available models stayed busy through the automatic wait. The page and steps were saved.',
  },
  CHAT_PROVIDER_UNREACHABLE: {
    ar: 'انقطع الاتصال بمزود النموذج أو انتهت مهلته قبل الرد. أرسل «تابع» للمحاولة مجددًا.',
    en: 'The model provider connection closed or timed out. Send “continue” to try again.',
  },
  CHAT_MODEL_INVALID: {
    ar: 'أعاد النموذج ردًا غير صالح، ولم يُنفذ أي إجراء. أرسل «تابع» للمحاولة مجددًا.',
    en: 'The model returned an invalid response. No action was taken. Send “continue” to try again.',
  },
  CHAT_NO_ELIGIBLE_PROVIDER: {
    ar: 'لا يوجد مزود نموذج مسموح لهذا الطلب حسب الإعدادات الحالية.',
    en: 'The current provider settings allow no model provider for this request. Check Advanced tools → Connections.',
  },
  CHAT_PROVIDER_FAILED: {
    ar: 'تعذر الحصول على رد من النموذج. أرسل «تابع» وسأحاول مجددًا.',
    en: 'I could not get a response from the model. Send “continue” and I’ll try again.',
  },
};

export function terminalErrorMessage(error: Error & { code: string }, lang: ReplyLanguage): string {
  const display = browserErrorReply(error, lang) ?? replyMessageForError(error, lang);
  if (display !== undefined) return display;
  // Render only the catalogue copy for diagnostics that contain a shell command or provider code.
  if (error.code === 'AGENT_BROWSER_UNAVAILABLE' || error.code === 'CHAT_PROVIDER_FAILED') return TERMINAL_ERRORS[error.code][lang];
  if (/\p{L}/u.test(error.message) && requestLanguage(error.message) === lang) return error.message;
  return Object.hasOwn(TERMINAL_ERRORS, error.code) ? TERMINAL_ERRORS[error.code][lang] : replyMessages.toolFailure[lang];
}
