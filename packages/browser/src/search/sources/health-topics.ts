// WHO bilingual fact sheets, checked 2026-11-27. Each comment gives the slug
// for the Arabic and English source pages used for that row's terms:
// https://www.who.int/ar/news-room/fact-sheets/detail/<slug>
// https://www.who.int/news-room/fact-sheets/detail/<slug>
const bilingualTopics: [english: string, arabic: string[]][] = [
  ['Diabetes', ['داء السكري', 'السكري']], // diabetes
  ['Type 1 diabetes', ['داء السكري من النمط 1', 'داء السكري من النمط الأول', 'السكري من النمط 1', 'السكري من النمط الأول']], // diabetes
  ['Type 2 diabetes', ['داء السكري من النمط 2', 'السكري من النمط 2']], // diabetes
  ['Gestational diabetes', ['سكري الحمل']], // diabetes
  ['Malaria', ['الملاريا']], // malaria
  ['Cholera', ['الكوليرا']], // cholera
  ['Tuberculosis', ['السل']], // tuberculosis
  ['Influenza', ['الأنفلونزا']], // influenza-(seasonal)
  ['Influenza (seasonal)', ['الأنفلونزا الموسمية']], // influenza-(seasonal)
  ['Hypertension', ['ارتفاع ضغط الدم', 'ضغط الدم المرتفع']], // hypertension
  ['Measles', ['الحصبة']], // measles
  ['Hepatitis B', ['التهاب الكبد B']], // hepatitis-b
  ['Hepatitis C', ['التهاب الكبد C']], // hepatitis-c
  ['Dengue', ['حُمّى الضنك']], // dengue-and-severe-dengue
  ['Asthma', ['الربو']], // asthma
  ['Obesity', ['السمنة']], // obesity-and-overweight
  ['COVID-19', ['كوفيد-19', 'مرض فيروس كورونا (كوفيد-19)']], // coronavirus-disease-(covid-19)
  ['Mpox', ['جدري القردة', 'إمبوكس']], // mpox
  ['Cancer', ['السرطان']], // cancer
];

function topicWords(text: string): string[] {
  return text.normalize('NFKC').toLowerCase()
    .replace(/[أإآٱ]/gu, 'ا')
    .replace(/[\u0640\p{M}\p{Cf}]/gu, '')
    .replace(/[٠-٩۰-۹]/gu, digit => String(digit.charCodeAt(0) - (digit <= '٩' ? '٠' : '۰').charCodeAt(0)))
    .match(/[\p{L}\p{N}]+/gu) ?? [];
}

const aliases = bilingualTopics.flatMap(([english, arabic]) => arabic.map(alias => ({ english, words: topicWords(alias) })))
  .sort((first, second) => second.words.length - first.words.length);
const knownTopics = new Set(bilingualTopics.flatMap(([english, arabic]) =>
  [english, ...arabic].map(topic => topicWords(topic).join(' '))));

export function isKnownHealthTopic(text: string): boolean {
  return knownTopics.has(topicWords(text).join(' '));
}

/** Returns an English query topic when the Arabic text identifies one listed topic. */
export function englishHealthTopic(text: string): string | undefined {
  const words = topicWords(text);
  let topic: string | undefined;
  for (let index = 0; index < words.length; index++) {
    const match = aliases.find(alias => alias.words.every((word, offset) =>
      words[index + offset] === word || (offset === 0 && words[index] === `و${word}`)));
    if (!match) continue;
    if (topic && topic !== match.english) return undefined;
    topic = match.english;
    index += match.words.length - 1;
  }
  return topic;
}
