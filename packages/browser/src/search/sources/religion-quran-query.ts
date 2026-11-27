type QuranQuery = { tafsir: boolean; language: 'ar' | 'en' } & (
  | { kind: 'reference'; surah: number; ayah: number; label?: string }
  | { kind: 'name'; name: string; ayah?: number }
  | { kind: 'words'; words: string; tryName?: boolean }
);

const arabicLetters = /(?=\p{L})\p{Script=Arabic}/u;
const marks = /[\u0640\p{M}\p{Cf}]/gu;
// Longest normalized name fields in https://api.alquran.cloud/v1/surah, checked 2026-11-27.
const bareNameWordLimit = { ar: 2, en: 6 };

/** Search normalization is applied only to comparison keys. */
export function normalizeQuranText(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(marks, '')
    .replace(/[أإآٱ]/gu, 'ا').replace(/ؤ/gu, 'و').replace(/[ئى]/gu, 'ي').replace(/ء/gu, '').replace(/ة/gu, 'ه')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

export function matchesSurahName(name: string, surah: { name: string; englishName: string; englishNameTranslation: string }): boolean {
  if (arabicLetters.test(name)) {
    const withoutSurah = (value: string) => normalizeQuranText(value).replace(/^سوره\s+/u, '');
    return withoutSurah(name) === withoutSurah(surah.name);
  }
  const english = normalizeQuranText(name).replace(/^(?:surah?|chapter)\s+/u, '');
  const translation = (value: string) => value.replace(/^the\s+/u, '');
  const transliteration = (value: string) => value.replace(/^al\s+/u, '').replaceAll(' ', '')
    .replace(/([aeiou])\1+/gu, '$1').replace(/ah$/u, 'a');
  return translation(english) === translation(normalizeQuranText(surah.englishNameTranslation))
    || transliteration(english) === transliteration(normalizeQuranText(surah.englishName));
}

const quranMarker = /\b(?:surah?|ayah|ayats?|tafs(?:i|ee)r|qur[’'ʼ]?an|koran)\b|(?:^|[^\p{L}])(?:[وف]?(?:ال)?(?:قر[اآ]ن|تفسير|سور[ةه]|[اآأإ]ي[ةه]|[اآأإ]يات)|قول(?:ه)?\s+تعالى)(?=$|[^\p{L}])/iu;
const hadithMarker = /\b(?:hadith|hadeeth|sunnah)\b|(?:^|[^\p{L}])(?:(?:ال)?(?:حديث|[اأ]حاديث)|السن[ةه])(?=$|[^\p{L}])/iu;
const tafsirMarker = /\b(?:tafs(?:i|ee)r|exegesis|explain|explanation|means?|meaning|interpret(?:ation)?)\b|(?:^|[^\p{L}])(?:ال)?(?:تفسير|فسر|اشرح|شرح|معنى)(?=$|[^\p{L}])/iu;

function subject(text: string): string {
  return text.replace(/^[\p{Ps}\p{Pi}"'«﴿\s]+|[\p{Pe}\p{Pf}"'»﴾?.!؟…\s]+$/gu, '').trim();
}

function verseWords(text: string, tafsir: boolean, tryName = false): QuranQuery | undefined {
  const words = subject(text);
  const normalized = normalizeQuranText(words);
  if (!normalized) return undefined;
  const language = arabicLetters.test(words) ? 'ar' : 'en';
  return { kind: 'words', words, tafsir, language, tryName: tryName && normalized.split(' ').length <= bareNameWordLimit[language] };
}

const sourceSuffix = /\s+(?:in\s+(?:the\s+)?(?:qur[’'ʼ]?an|islam)|في\s+(?:(?:ال)?قر[اآ]ن(?:\s+الكريم)?|الإسلام))[?.!؟]?$/iu;

export function parseQuranQuery(input: string, allowUnmarkedWords = false): QuranQuery | undefined {
  const text = input.normalize('NFKC').replace(marks, '')
    .replace(/[٠-٩۰-۹]/gu, digit => String(digit.charCodeAt(0) & 0xf)).trim();
  const quotation = /["“«﴿]([^"”»﴾]+)["”»﴾]/gu;
  const framing = text.replace(quotation, ' ');
  const quran = quranMarker.exec(framing);
  const hadith = hadithMarker.exec(framing);
  if (hadith && (!quran || hadith.index < quran.index)) return undefined;

  const tafsir = tafsirMarker.test(framing);
  const language = arabicLetters.test(text) ? 'ar' : 'en';
  const context = { tafsir, language } as const;
  const numbers = /(?:^|[^\p{L}\p{N}:])(\d+)\s*:\s*(\d+)(?![\p{L}\p{N}:])/u.exec(framing);
  const bareReference = /^\s*\d+\s*:\s*\d+[?.!؟]?$/u.test(text);
  if (numbers && (quran || bareReference || /\bverse\b/iu.test(framing))) {
    return { ...context, kind: 'reference', surah: Number(numbers[1]), ayah: Number(numbers[2]) };
  }

  // Al Quran Cloud identifies the named ayah in its tafsir and verse reader (checked 2026-11-27):
  // https://api.alquran.cloud/v1/ayah/2:255/ar.muyassar
  // https://alquran.cloud/ayah?reference=2%3A255
  const kursi = /(?:^|[^\p{L}])(?:[اآأإ]ي[ةه]\s+الكرسي|ayat[\s-]*(?:(?:al|ul)[\s-]*)?kurs[iy])(?=$|[^\p{L}])/iu.test(text);
  if (kursi) {
    return { ...context, kind: 'reference', surah: 2, ayah: 255, label: language === 'ar' ? 'آية الكرسي' : 'Āyat al-Kursī' };
  }
  const quoted = text.matchAll(quotation).next().value?.[1];
  const englishLocation = /^(?:which|what)\s+(?:surah?|ayah|verse)\s+(?:contains?|says?|includes?|has|is)\s+(.+)$/iu.exec(text);
  if (!quran && !englishLocation && !allowUnmarkedWords) return undefined;
  const location = [
    /^(?:في\s+[اأإ]ي\s+سور[ةه]|[اأإ]ين)\s+(?:(?:وردت?|جاءت?)\s+)?(?:(?:قول(?:ه)?(?:\s+تعالى)?|(?:ال)?[اآأإ]ي[ةه])\s+)?(.+)$/u,
    /^where\s+in\s+(?:the\s+)?qur[’'ʼ]?an\s+(?:is\s+)?(.+)$/iu,
  ].map(pattern => pattern.exec(text)).find(match => match !== null) ?? englishLocation;
  if (location) {
    return verseWords(quoted ?? location[1].replace(sourceSuffix, ''), tafsir);
  }

  const chapter = /(?:^|[^\p{L}])(?:سور[ةه]|surah?|chapter)\s+(.+)$/iu.exec(text);
  if (chapter) {
    const before = /(?:^|[^\p{L}])(?:[اآأإ]ي[ةه]|ال[اآأإ]ي[ةه]|ayah|verse)\s+(\d+)\s+(?:من|في|of|in)\s+(?:سور[ةه]|surah?|chapter)\s+/iu.exec(text);
    const after = /^(.*?)\s*[,،:]?\s+(?:(?:ال)?[اآأإ]ي[ةه]|ayah|verse)\s+(\d+)\b/iu.exec(chapter[1])
      ?? /^(.*?)(?:\s*[:،,]\s*|\s+)(\d+)\s*[?.!؟]?$/u.exec(chapter[1]);
    const name = subject((after?.[1] ?? chapter[1]).replace(/\s+(?:say|mean)\s*[?.!]?$/iu, ''));
    const ayahText = before?.[1] ?? after?.[2];
    if (ayahText && /^\d+$/u.test(name)) {
      return { ...context, kind: 'reference', surah: Number(name), ayah: Number(ayahText) };
    }
    return name ? { ...context, kind: 'name', name, ayah: ayahText ? Number(ayahText) : undefined } : undefined;
  }

  const topic = /^(?:ما\s+(?:حكم|موقف)\s+(?:ال)?قر[اآ]ن\s+(?:من|في)|(?:ما|ماذا)\s+(?:هو\s+)?حكم|هل\s+يجوز)\s+(.+)$/u.exec(text)
    ?? /^what\s+(?:does\s+(?:the\s+)?qur[’'ʼ]?an\s+(?:say|teach)\s+about|is\s+the\s+(?:islamic\s+)?ruling\s+(?:on|of|about))\s+(.+)$/iu.exec(text);
  if (topic) return verseWords(quoted ?? topic[1].replace(sourceSuffix, ''), tafsir);

  return verseWords(quoted ?? text
    .replace(/^(?:(?:ما|ماذا)\s+)?(?:تفسير|فسر|اشرح|شرح|معنى|نص|اقر[اأ]|ابحث عن)\s+/u, '')
    .replace(/^(?:(?:ال)?[اآأإ]ي[ةه]\s+|(?:من\s+)?(?:ال)?قر[اآ]ن\s+)+/u, '')
    .replace(/^(?:(?:what\s+is\s+(?:the\s+)?)?(?:tafs(?:i|ee)r|meaning|explanation|interpretation)\s+(?:of\s+)?|(?:show|read|find|explain)\s+)/iu, '')
    .replace(/^(?:(?:the\s+)?(?:qur[’'ʼ]?an(?:\s+verse)?|ayah)\s+)+/iu, '')
    .replace(sourceSuffix, ''), tafsir, !quran && !quoted);
}
