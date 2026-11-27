import { describe, expect, it } from 'vitest';
import { matchesSurahName, normalizeQuranText, parseQuranQuery } from './religion-quran-query.js';

// Name fields recorded from https://api.alquran.cloud/v1/surah on 2026-11-27.
const surah = { name: 'سُورَةُ البَقَرَةِ', englishName: 'Al-Baqara', englishNameTranslation: 'The Cow' };

describe('Quran query parsing', () => {
  it.each(['what does verse 2:255 say', 'الآية ٢٥٥ من سورة ٢', '۲:۲۵۵'])('parses the verse reference in %s', question => {
    expect(parseQuranQuery(question)).toMatchObject({ kind: 'reference', surah: 2, ayah: 255, tafsir: false });
  });

  it.each(['سُورَةُ البَقَرَةِ، الآية ۲۵۵', 'what does verse 255 of Surah Al-Baqarah say?', 'surah The Cow:255'])(
    'matches a name from the source in %s', question => {
      const query = parseQuranQuery(question);
      expect(query).toMatchObject({ kind: 'name', ayah: 255 });
      expect(query?.kind === 'name' && matchesSurahName(query.name, surah)).toBe(true);
    },
  );

  it('matches a common spelling of a name with a long vowel', () => {
    // Name fields recorded from https://api.alquran.cloud/v1/surah on 2026-11-27.
    expect(matchesSurahName('Al-Fatihah', {
      name: 'سُورَةُ ٱلْفَاتِحَةِ', englishName: 'Al-Faatiha', englishNameTranslation: 'The Opening',
    })).toBe(true);
  });

  it('keeps the searchable words of an Arabic location request', () => {
    // These verse words were retrieved from https://api.alquran.cloud/v1/ayah/30:21/quran-simple on 2026-11-27.
    const phrase = 'وَجَعَلَ بَيْنَكُمْ مَوَدَّةً وَرَحْمَةً';
    const query = parseQuranQuery(`في أي سورة وردت الآية «${phrase}»؟`);
    expect(query).toMatchObject({ kind: 'words', language: 'ar', words: 'وجعل بينكم مودة ورحمة' });
    expect(normalizeQuranText(phrase)).toBe(normalizeQuranText('وجعل بينكم موده ورحمه'));
  });

  it('normalizes Arabic orthography only in comparison keys', () => {
    expect(normalizeQuranText('أَ إِ آ ٱ ؤ ئ ة')).toBe('ا ا ا ا و ي ه');
  });

  it('recognizes an English location request with a quotation', () => {
    // The phrase is from https://api.alquran.cloud/v1/ayah/2:255/en.sahih, checked 2026-11-27.
    expect(parseQuranQuery('which verse contains “the Ever-Living”')).toMatchObject({
      kind: 'words', words: 'the Ever-Living', language: 'en',
    });
  });

  it('selects the interpretation of the named Ayatul Kursi', () => {
    // Al Quran Cloud identifies the verse in https://api.alquran.cloud/v1/ayah/2:255/ar.muyassar, checked 2026-11-27.
    expect(parseQuranQuery('ما تفسير آية الكرسي؟')).toMatchObject({
      kind: 'reference', surah: 2, ayah: 255, language: 'ar', tafsir: true,
    });
    expect(parseQuranQuery('what is the tafsir of 2:255')).toMatchObject({
      kind: 'reference', surah: 2, ayah: 255, language: 'en', tafsir: true,
    });
    expect(parseQuranQuery('what does verse 2:255 mean?')).toMatchObject({
      kind: 'reference', surah: 2, ayah: 255, language: 'en', tafsir: true,
    });
  });

  it('accepts an unmarked name or verse phrase when the caller selects the domain', () => {
    expect(parseQuranQuery('البقرة')).toBeUndefined();
    expect(parseQuranQuery('البقرة', true)).toMatchObject({ kind: 'words', tryName: true });
    // Verse words from https://api.alquran.cloud/v1/ayah/2:255/quran-simple, checked 2026-11-27.
    expect(parseQuranQuery('لا تأخذه سنة ولا نوم', true)).toMatchObject({
      kind: 'words', words: 'لا تأخذه سنة ولا نوم', tryName: false,
    });
    expect(parseQuranQuery('ما نص حديث إنما الأعمال بالنيات؟', true)).toBeUndefined();
  });

  it('extracts a literal source topic from ruling and Quran questions', () => {
    // Al Quran Cloud 2:275 contains the Arabic term and renders it "usury" in en.sahih, checked 2026-11-27.
    // https://api.alquran.cloud/v1/ayah/2:275/editions/quran-simple,en.sahih
    expect(parseQuranQuery('ما حكم الربا في القرآن؟')).toMatchObject({ kind: 'words', words: 'الربا', tafsir: false });
    expect(parseQuranQuery('ما حكم الربا؟', true)).toMatchObject({ kind: 'words', words: 'الربا', tafsir: false });
    expect(parseQuranQuery('what does the Quran say about usury?')).toMatchObject({ kind: 'words', words: 'usury', tafsir: false });
  });
});
