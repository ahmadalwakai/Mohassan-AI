import { SkillError } from './errors.ts';

const MAX_FRONTMATTER = 4096;

export interface SkillManifest { fields: Record<string, string>; body: string }

function scalar(value: string): string {
  const text = value.trim();
  const quoted = text.length >= 2 && ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")));
  return quoted ? text.slice(1, -1) : text;
}

/**
 * A strict line reader, not a YAML loader: values stay plain strings, so anchors, tags and
 * merge keys have no meaning. Nested blocks are skipped because nothing here reads them.
 */
export function parseSkillManifest(source: string): SkillManifest {
  const text = source.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  if (!text.startsWith('---\n')) throw new SkillError('SKILL_MANIFEST_INVALID', 'يلزم أن يبدأ SKILL.md بقسم بيانات.');
  const end = text.indexOf('\n---', 3);
  if (end < 0 || (text[end + 4] !== undefined && text[end + 4] !== '\n')) throw new SkillError('SKILL_MANIFEST_INVALID', 'قسم بيانات SKILL.md غير مغلق.');
  const header = text.slice(4, end);
  if (header.length > MAX_FRONTMATTER) throw new SkillError('SKILL_MANIFEST_INVALID', 'قسم بيانات SKILL.md أكبر من المسموح.');
  const fields: Record<string, string> = Object.create(null);
  const lines = header.split('\n');
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    if (/^\s/.test(line)) continue;
    const match = /^([a-zA-Z][a-zA-Z0-9_-]{0,63}):(.*)$/.exec(line);
    if (!match) throw new SkillError('SKILL_MANIFEST_INVALID', 'سطر غير مفهوم في بيانات SKILL.md.');
    const [, key, rest] = match;
    if (key in fields) throw new SkillError('SKILL_MANIFEST_INVALID', `مفتاح مكرر في بيانات SKILL.md: ${key}`);
    if (/^\s*[|>][+-]?\s*$/.test(rest)) {
      const block: string[] = [];
      while (index + 1 < lines.length && (/^\s/.test(lines[index + 1]) || !lines[index + 1].trim())) block.push(lines[++index].trim());
      fields[key] = block.join(' ').replace(/\s+/g, ' ').trim();
    } else fields[key] = scalar(rest);
  }
  const body = text.slice(end + 4).replace(/^\n+/, '').trimEnd();
  if (!body) throw new SkillError('SKILL_MANIFEST_INVALID', 'لا يحتوي SKILL.md تعليمات.');
  return { fields, body };
}
