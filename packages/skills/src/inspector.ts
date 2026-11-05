import { builtinModules } from 'node:module';
import { TOOL_SIDE_EFFECTS, type SkillContract, type SkillFinding, type SkillSideEffect, type SkillVerdict } from '@mohassan/contracts';

export const INSPECTOR_VERSION = 'static-v1';
export type SkillFileKind = 'instructions' | 'script' | 'reference' | 'data';
export interface InspectableFile { path: string; kind: SkillFileKind; content: string }
export interface InspectionResult { verdict: SkillVerdict; findings: SkillFinding[] }

const MAX_FINDINGS = 200;
const RUNNABLE = /\.(?:mjs|cjs|js)$/i;
const SCRIPT = /\.(?:mjs|cjs|js|ts|py|sh|bash|ps1|bat|cmd|rb|pl)$/i;
const BIDI = /[‪-‮⁦-⁩]|\u{E0000}|[\u{E0001}-\u{E007F}]/u;
const ZERO_WIDTH = /[​⁠-⁤﻿]/;
const EFFECT_RANK: readonly SkillSideEffect[] = ['none', 'read', 'write_local', 'external', 'financial'];

const TEXT_RULES: readonly (readonly [string, RegExp, string])[] = [
  ['override_instructions', /(?:ignore|disregard|forget|override)\s+(?:all\s+|any\s+|your\s+|the\s+)*(?:previous|prior|above|earlier|system)\s+(?:instructions?|prompts?|rules?)/i, 'نص يطلب تجاهل التعليمات السابقة.'],
  ['override_instructions', /تجاهل.{0,30}(?:التعليمات|القواعد|الأوامر)/u, 'نص يطلب تجاهل التعليمات السابقة.'],
  ['role_takeover', /\byou are now\b|\bnew system prompt\b|\bact as (?:root|admin|system)\b/i, 'نص يحاول تغيير دور النموذج.'],
  ['secret_exfiltration', /(?:reveal|print|show|send|upload|post|exfiltrate|leak)\b.{0,50}(?:system prompt|api[ _-]?key|credentials?|secrets?|passwords?|tokens?|cookies?)/i, 'نص يطلب كشف أسرار أو إرسالها.'],
  ['secret_exfiltration', /(?:أرسل|اكشف|اطبع|انشر).{0,50}(?:كلمة المرور|كلمات المرور|المفتاح|المفاتيح|الأسرار|الرمز|الرموز)/u, 'نص يطلب كشف أسرار أو إرسالها.'],
  ['concealment', /(?:do not|don't|never)\s+(?:tell|inform|ask|notify|show)\s+the user|without\s+(?:telling|asking|notifying|informing)\s+the user/i, 'نص يطلب إخفاء فعل عن المستخدم.'],
  ['concealment', /(?:دون|بدون)\s+(?:إخبار|سؤال|علم|إعلام)\s+المستخدم/u, 'نص يطلب إخفاء فعل عن المستخدم.'],
  ['remote_execution', /curl[^\n]{0,300}\|\s{0,8}(?:ba)?sh|wget[^\n]{0,300}\|\s{0,8}(?:ba)?sh|\bInvoke-Expression\b|\biex\s*\(|powershell[^\n]{0,300}-enc/i, 'أمر ينزل كوداً ويشغله مباشرة.'],
  ['sensitive_path', /(?:^|[\s"'`/\\])(?:\.env\b|\.ssh\b|id_rsa\b|id_ed25519\b|auth-secret\b)/i, 'إشارة إلى ملف أسرار.'],
];
const SCRIPT_RULES: readonly (readonly [string, RegExp, string])[] = [
  ['script_process', /\bchild_process\b|\bworker_threads\b|\bnode:cluster\b/, 'السكربت يحاول إنشاء عمليات؛ العزل يمنعها.'],
  ['script_network', /\b(?:node:)?(?:net|dgram|http|https|http2|tls|dns)['"]|\bfetch\s*\(|\bWebSocket\b/, 'السكربت يستخدم الشبكة؛ العزل يحجبها.'],
  ['script_dynamic_code', /\beval\s*\(|\bnew\s+Function\b|\bWebAssembly\b|\bimport\s*\(/, 'السكربت يبني كوداً وقت التشغيل.'],
  ['script_host_access', /\bprocess\.(?:env|binding|dlopen|kill)\b/, 'السكربت يصل إلى بيئة العملية.'],
];

function lineOf(content: string, index: number) { return content.slice(0, index).split('\n').length; }
const packageName = (specifier: string) => specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];

function bareImports(content: string): { name: string; index: number }[] {
  const found: { name: string; index: number }[] = [];
  for (const match of content.matchAll(/\bfrom\s+['"]([^'"]+)['"]|\bimport\s+['"]([^'"]+)['"]|\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    const specifier = match[1] ?? match[2] ?? match[3];
    if (/^(?:\.{1,2}\/|\/|node:)/.test(specifier)) continue;
    if (!builtinModules.includes(packageName(specifier))) found.push({ name: specifier, index: match.index });
  }
  return found;
}

/** Reads text only and never executes anything. It informs review; the OS boundary is what contains a script. */
export function inspectSkill(contract: SkillContract, files: readonly InspectableFile[]): InspectionResult {
  const findings: SkillFinding[] = [];
  const add = (code: string, severity: SkillFinding['severity'], path: string | null, line: number | null, message: string) => { if (findings.length < MAX_FINDINGS) findings.push({ code, severity, path, line, message }); };

  // These fields reach the model as metadata, so they get the same reading as the instructions.
  const metadata = [contract.name, contract.description, contract.verification, contract.rollback.note, ...contract.steps.map((step) => step.title)].filter(Boolean).join('\n');
  for (const file of [...files, { path: 'skill.contract.json', kind: 'data' as const, content: metadata }]) {
    const content = file.content;
    const bidi = BIDI.exec(content);
    if (bidi) add('hidden_control_characters', 'block', file.path, lineOf(content, bidi.index), 'يحتوي النص محارف تخفي ما يراه المراجع.');
    const zero = ZERO_WIDTH.exec(content.replace(/^﻿/, ''));
    if (zero) add('zero_width_characters', 'warn', file.path, lineOf(content, zero.index), 'يحتوي النص محارف غير مرئية.');
    const base64 = /[A-Za-z0-9+/]{200,}={0,2}/.exec(content);
    if (base64) add('encoded_blob', 'warn', file.path, lineOf(content, base64.index), 'كتلة مشفرة طويلة لا يمكن مراجعتها بالقراءة.');
    if (file.kind !== 'script') {
      for (const [code, pattern, message] of TEXT_RULES) {
        const match = pattern.exec(content);
        if (match) add(code, 'warn', file.path, lineOf(content, match.index), message);
      }
    }
    if (file.kind === 'instructions') {
      const comment = /<!--/.exec(content);
      if (comment) add('hidden_comment', 'warn', file.path, lineOf(content, comment.index), 'تعليق HTML يصل إلى النموذج ولا يظهر عند العرض.');
      const urls = content.match(/https?:\/\/[^\s)"'<>]+/g) ?? [];
      if (urls.length) add('external_urls', 'info', file.path, null, `تشير التعليمات إلى ${urls.length} رابطاً خارجياً.`);
    }
    if (file.kind === 'script') {
      for (const [code, pattern, message] of SCRIPT_RULES) {
        const match = pattern.exec(content);
        if (match) add(code, 'warn', file.path, lineOf(content, match.index), message);
      }
    }
  }

  const scripts = files.filter((file) => file.kind === 'script');
  if (contract.level !== 'executable' && scripts.length) add('scripts_not_executed', 'info', null, null, `${scripts.length} سكربت مخزن للمراجعة ولن يُشغَّل في هذا المستوى.`);

  const present = new Map(files.map((file) => [file.path, file]));
  for (const step of contract.steps) {
    if (step.kind !== 'script' || !step.entry) continue;
    const entry = present.get(step.entry);
    if (!entry) add('entry_missing', 'block', step.entry, null, 'ملف الدخول المعلن غير موجود.');
    else if (!RUNNABLE.test(step.entry)) add('entry_unsupported', 'incompatible', step.entry, null, 'الإصدار الحالي يشغّل JavaScript على Node فقط.');
  }
  if (contract.level === 'executable') {
    for (const file of scripts) {
      if (!RUNNABLE.test(file.path)) { add('script_unsupported', 'incompatible', file.path, null, 'نوع سكربت لا يدعمه العزل الحالي.'); continue; }
      for (const { name, index } of bareImports(file.content)) add('package_dependency', 'incompatible', file.path, lineOf(file.content, index), `يعتمد على الحزمة ${name}، ولا يوجد تثبيت حزم داخل العزل.`);
    }
  }

  const declared = EFFECT_RANK.indexOf(contract.sideEffects);
  for (const tool of contract.requires.tools) {
    if (EFFECT_RANK.indexOf(TOOL_SIDE_EFFECTS[tool]) > declared) add('side_effect_understated', 'block', null, null, `الأداة ${tool} تتجاوز الأثر الجانبي المعلن ${contract.sideEffects}.`);
  }

  const has = (severity: SkillFinding['severity']) => findings.some((finding) => finding.severity === severity);
  const verdict: SkillVerdict = has('block') ? 'fail' : has('incompatible') ? 'incompatible' : has('warn') ? 'review' : 'pass';
  return { verdict, findings };
}

export function classifySkillFile(path: string): SkillFileKind | null {
  if (path === 'SKILL.md') return 'instructions';
  if (SCRIPT.test(path)) return 'script';
  if (/\.(?:md|txt)$/i.test(path)) return 'reference';
  if (/\.(?:json|csv|tsv|ya?ml)$/i.test(path)) return 'data';
  return null;
}
