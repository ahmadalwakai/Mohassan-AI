/** Build a new version without overwriting any previous dataset. Local data only. */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { makeBilingualGoals } from './bilingual.js';
import { checkSiteAds, siteAds, siteDigest } from './site.js';
import { pointerToSite, renderSitePointerPrompt, samePointerAds, siteToPointer, SITE_POINTER_CAPABILITY } from './pointer.js';
import { rng } from './lib.js';

const args = process.argv.slice(2);
const option = (key: string, fallback: string) => { const at = args.indexOf(key); return at < 0 ? fallback : args[at + 1] ?? fallback; };
const out = resolve(option('--out', 'artifacts/ads-training/bilingual-v1'));
if (existsSync(out)) throw new Error(`Refusing to overwrite existing dataset: ${out}`);
const trainCount = Number(option('--train', '18000')), validationCount = Number(option('--validation', '600'));
if (![trainCount, validationCount].every(n => Number.isInteger(n) && n > 1 && n <= 200000)) throw new Error('Invalid example count');
const seed = 20261115, random = rng(seed), read = (path: string) => readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
const train: any[] = makeBilingualGoals({ count: trainCount, split: 'train', seed });
const validation: any[] = makeBilingualGoals({ count: validationCount, split: 'validation', seed: seed + 1 });
// Retain the original host-disjoint English site training and validation examples.
for (const [split, target] of [['train', train], ['validation', validation]] as const) {
  const rows = read(join('artifacts/ads-training/pointer-v3', `${split}.jsonl`));
  const seen = new Set<string>();
  for (const row of rows) if (row.capability === SITE_POINTER_CAPABILITY && !seen.has(row.id)) {
    seen.add(row.id); target.push({ ...row, split, language: 'en', family: 'website-extraction' });
  }
}
// Arabic page fixtures: all claims are supplied by the synthetic page and only its own text can be selected.
const services = ['تنظيف المنازل', 'نقل الأثاث', 'إصلاح السيارات', 'تركيب المطابخ', 'تصميم المواقع', 'تنظيف السجاد', 'صيانة الأجهزة', 'خدمات الترجمة', 'توصيل الزهور', 'تنسيق الحدائق', 'رعاية الحيوانات', 'دروس الموسيقى'];
const places = ['لندن', 'غلاسكو', 'الرياض', 'دبي', 'القاهرة', 'عمان', 'الدوحة', 'جدة'];
const siteCount = Number(option('--arabic-sites', '1200'));
if (!Number.isInteger(siteCount) || siteCount < 0 || siteCount > 20000) throw new Error('Invalid Arabic site count');
let acceptedSites = 0;
for (let index = 0; index < siteCount; index++) {
  const validationSite = index % 10 === 0, split = validationSite ? 'validation' : 'train';
  const service = random.pick(services), place = random.pick(places), name = `مركز ${random.pick(['الأمل', 'النور', 'الوفاء', 'الإتقان', 'الصفاء'])}`;
  const title = `${name} | ${service}`;
  const lines = random.sample([service, `${service} في ${place}`, 'خدمة محلية موثوقة', 'مواعيد مناسبة لك', 'فريق متخصص', 'تواصل معنا اليوم', 'خدمات تناسب احتياجاتك',
    `نقدم خدمات ${service} في ${place} مع مواعيد تناسب احتياجات العملاء.`,
    'تواصل مع فريقنا لمعرفة التفاصيل واختيار الموعد المناسب للخدمة.',
    'يمكنك التواصل معنا لطلب عرض سعر واضح يناسب احتياجاتك.',
    'فريقنا مستعد للإجابة عن أسئلتك ومساعدتك في اختيار الخدمة المناسبة.'], 12);
  const input = siteDigest(`https://arabic-${split}-${index}.example`, title, [title, ...lines].join('\n'));
  const output = siteAds(input); if (!output) continue;
  const target = siteToPointer(input, output), back = target ? pointerToSite(input, target) : null;
  if (!target || !back || !samePointerAds(output, back) || checkSiteAds(input, output).length) throw new Error(`Invalid Arabic site label ${index}`);
  const row = { id: createHash('sha256').update(JSON.stringify(input)).digest('hex').slice(0, 24), capability: SITE_POINTER_CAPABILITY, language: 'ar', family: 'synthetic-website', split, source: 'synthetic', input, output, prompt: renderSitePointerPrompt(input, { usableOnly: true }), target };
  (validationSite ? validation : train).push(row); acceptedSites++;
}
if (siteCount > 0 && acceptedSites < siteCount * 0.8) throw new Error(`Too few valid Arabic pages: ${acceptedSites}/${siteCount}`);
const codeDir = option('--code-dir', '');
if (codeDir) for (const [split, target] of [['train', train], ['validation', validation]] as const) target.push(...read(join(codeDir, `${split}.jsonl`)));
const trainingPrompts = new Set(train.map(row => row.prompt));
if (validation.some(row => trainingPrompts.has(row.prompt))) throw new Error('Train/validation prompt overlap');
mkdirSync(out, { recursive: true });
const files: Record<string, unknown> = {};
function write(name: string, rows: any[]) {
  const text = rows.map(row => JSON.stringify(row)).join('\n') + '\n';
  writeFileSync(join(out, `${name}.jsonl`), text);
  files[name] = { rows: rows.length, sha256: createHash('sha256').update(text).digest('hex'), byLanguage: Object.fromEntries(['ar', 'en'].map(language => [language, rows.filter(row => row.language === language).length])), byCapability: Object.fromEntries([...new Set(rows.map(row => row.capability))].map(capability => [capability, rows.filter(row => row.capability === capability).length])) };
}
write('train', random.sample(train, train.length)); write('validation', validation);
if (codeDir) for (const name of ['code_test', 'code_unseen']) if (existsSync(join(codeDir, `${name}.jsonl`))) write(name, read(join(codeDir, `${name}.jsonl`)));
const manifest = { version: 'bilingual-local-v1', createdAt: new Date().toISOString(), seed, files, overlap: 0, arabicSiteFixtures: acceptedSites, lineage: 'Locally generated supervised data plus existing Common Crawl site training split. No external model or pretrained weights.', evaluation: 'Validation is for development. Independent final evaluation must be frozen separately before training and must not be copied into this corpus.' };
writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify(manifest, null, 2));
