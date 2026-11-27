/*
Copyright 2006, Arabeyes.org. All rights reserved.
Redistribution and use in source (SGML DocBook) and 'compiled' forms (SGML, HTML, PDF,
PostScript, RTF and so forth) with or without modification, are permitted provided that the following
conditions are met:
Redistributions of source code (SGML DocBook) must retain the above copyright notice, this
list of conditions and the following disclaimer as the first lines of this file unmodified.
Redistributions in compiled form (transformed to other DTDs, converted to PDF, PostScript,
RTF and other formats) must reproduce the above copyright notice, this list of conditions and the
following disclaimer in the documentation and/or other materials provided with the distribution.
Important: THIS DOCUMENTATION IS PROVIDED BY THE ARABEYES WIKI TEAM "AS
IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO,
THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR
PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE ARABEYES WIKI TEAM BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS
OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT
LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY
OUT OF THE USE OF THIS DOCUMENTATION, EVEN IF ADVISED OF THE POSSIBILITY
OF SUCH DAMAGE.
*/
import { arabicBase, arabicStem, foldText } from '@mohassan/skills';

// Programming senses selected from the Arabeyes Technical Computing Dictionary,
// v3.0.20160902 (FreeBSD Documentation License, reproduced above).
// https://www.arabeyes.org/techdict/archive/arabdict-20160902.pdf (retrieved 2026-11-27)
// SHA-256: 2418421fe5f210cae97bd8b34b1e4b221f4fb88235f0ec43cae08c23f043570e
// English headwords are shortened for retrieval where the dictionary qualifies the sense.
const ARABEYES: Readonly<Record<string, string>> = {
  'استثناء': 'exception',
  'استعلام': 'query',
  'استدعاء وظيفة': 'function call',
  'اختلاف في النوع': 'type mismatch',
  'تعبير نمطي': 'regular expression',
  'ترتيب': 'sort',
  'ترتيب تنازلي': 'descending sort',
  'حزمة': 'package',
  'حلقة': 'loop',
  'حلقة لا نهائية': 'infinite loop',
  'خاصية': 'property',
  'خصائص': 'properties',
  'خطأ': 'error',
  'خطأ في بناء الجملة': 'syntax error',
  'دالة': 'function',
  'رسالة خطأ': 'error message',
  'سلسلة محارف': 'string',
  'صنف': 'class',
  'فرز': 'sort',
  'كائن': 'object',
  'لائحة': 'list',
  'لا تزامني': 'asynchronous',
  'متغير': 'variable',
  'متغير بيئة': 'environment variable',
  'متزامن': 'synchronous',
  'مجلد': 'directory',
  'مسار': 'path',
  'مسار مطلق': 'absolute path',
  'مسار نسبي': 'relative path',
  'مصفوفة': 'array',
  'مصفوفة ترابطية': 'associative array',
  'معالجة الخطأ': 'error handling',
  'مكرر': 'duplicate',
  'مكتبة': 'library',
  'مكون': 'component',
  'ملف': 'file',
  'نوع البيانات': 'data type',
  'واجهة سطر الأوامر': 'command line interface',
  'وصلة رمزية': 'symbolic link',
};

// Language labels and aliases from Wikidata (CC0).
// https://www.wikidata.org/wiki/Wikidata:Licensing (revisions below retrieved 2026-11-27)
const LANGUAGE_NAMES: Readonly<Record<string, string>> = {
  // https://www.wikidata.org/wiki/Q2005 (revision 2566877768)
  'جافا سكريبت': 'JavaScript',
  'جافاسكربت': 'JavaScript',
  'جافا سكربت': 'JavaScript',
  'جافاسكريبت': 'JavaScript',
  // https://www.wikidata.org/wiki/Q28865 (revision 2566877611)
  'بايثون': 'Python',
  // https://www.wikidata.org/wiki/Q978185 (revision 2573905279)
  'تايب سكريبت': 'TypeScript',
  'تايب إسكريبت': 'TypeScript',
};

// Term pairs from "Rendering Lists" by the React documentation contributors (CC BY 4.0).
// https://github.com/reactjs/ar.react.dev/blob/2da48d6c96d6e5ae6aa6618e074504efc2717d30/src/content/learn/rendering-lists.md
// Retrieved 2026-11-27.
// https://creativecommons.org/licenses/by/4.0/
const REACT_TERMS: Readonly<Record<string, string>> = {
  'دوال': 'function',
  'دالة سهمية': 'arrow function',
  'دوال سهمية': 'arrow function',
  'قائمة': 'list',
  'قوائم': 'list',
};

const ARABIC_WORD = /\p{Script=Arabic}+/gu;
const CONJUNCTION = /^[وف]/u;

const GLOSSARY = new Map<string, string>();
const STEMMED = new Map<string, string | null>();
let maxWords = 1;
for (const [arabic, english] of Object.entries({ ...ARABEYES, ...LANGUAGE_NAMES, ...REACT_TERMS })) {
  const words = foldText(arabic).match(ARABIC_WORD) ?? [];
  GLOSSARY.set(words.map(arabicBase).join(' '), english);
  const stemmed = words.map(arabicStem).join(' ');
  // Ambiguous stems have no fallback. The full glossary entry can still be used.
  STEMMED.set(stemmed, STEMMED.has(stemmed) && STEMMED.get(stemmed) !== english ? null : english);
  maxWords = Math.max(maxWords, words.length);
}

function lookup(words: readonly string[]): string | null | undefined {
  return GLOSSARY.get(words.map(arabicBase).join(' ')) ?? STEMMED.get(words.map(arabicStem).join(' '));
}

/** Expand the longest attested technical phrase. Keep Latin terms in their original case. */
export function glossaryTerms(text: string): string[] {
  const terms = new Set<string>();
  // Process Arabic spans independently so the words of a phrase cannot straddle Latin identifiers.
  for (const span of foldText(text).match(/\p{Script=Arabic}+(?:[ \t]+\p{Script=Arabic}+)*/gu) ?? []) {
    const words = span.match(ARABIC_WORD) ?? [];
    for (let start = 0; start < words.length; start++) {
      for (let size = Math.min(maxWords, words.length - start); size > 0; size--) {
        const phrase = words.slice(start, start + size);
        const joined = [phrase[0].replace(CONJUNCTION, ''), ...phrase.slice(1)];
        const match = lookup(phrase) ?? lookup(joined);
        if (!match) continue;
        terms.add(match);
        start += size - 1;
        break;
      }
    }
  }
  return [...terms];
}
