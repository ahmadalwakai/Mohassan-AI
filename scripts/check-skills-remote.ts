/** --live contacts GitHub exactly once over the restricted HTTPS runner (ls-remote only). No database, no skill is written. */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
if (args.length !== 1 || args[0] !== '--live') {
  process.stdout.write('الاستخدام: npm run skills:remote:check -- --live\nيقرأ SKILL_REMOTE_* من .env ويسأل GitHub عن رأس الفرع فقط عبر Git المقيّد (HTTPS، بلا رموز وصول). لا يلمس قاعدة البيانات ولا المهارات. يكتب النتيجة في artifacts/skills-remote-check.json.\n');
  process.exitCode = args.length && args[0] !== '--help' ? 2 : 0;
} else {
  try { await checkRemote(); } catch (error) { process.stderr.write(`فشل فحص مصدر GitHub: ${error instanceof Error ? error.message : 'خطأ غير معروف'}\n`); process.exitCode = 1; }
}

async function checkRemote() {
  if (process.env.MOHASSAN_ISOLATED_TEST !== 'true') await import('dotenv/config');
  const [{ skillRemoteConfigFromEnv }, { remoteHead }] = await Promise.all([import('../apps/server/src/skill-remote.ts'), import('../packages/coding/src/git-remote.ts')]);
  const settings = skillRemoteConfigFromEnv(process.env);
  const checkedAt = new Date().toISOString(), platform = process.platform;
  let result: { checkedAt: string; repo: string | null; ref: string | null; reachable: boolean; commit: string | null; errorCode: string | null; platform: string };
  if (!settings.config) {
    result = { checkedAt, repo: process.env.SKILL_REMOTE_REPO?.trim() || null, ref: process.env.SKILL_REMOTE_REF?.trim() || null, reachable: false, commit: null, errorCode: settings.problem ?? 'SKILL_REMOTE_NOT_CONFIGURED', platform };
  } else {
    const { repo, ref } = settings.config;
    try {
      const commit = await remoteHead(process.cwd(), repo, ref);
      result = { checkedAt, repo, ref, reachable: true, commit, errorCode: null, platform };
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      result = { checkedAt, repo, ref, reachable: false, commit: null, errorCode: typeof code === 'string' ? code : 'GIT_REMOTE_UNREACHABLE', platform };
    }
  }
  await mkdir(resolve('artifacts'), { recursive: true });
  await writeFile(resolve('artifacts/skills-remote-check.json'), `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(result.reachable
    ? `GitHub متاح: ${result.repo}@${result.ref} عند ${result.commit}\n`
    : `GitHub غير متاح (${result.errorCode}). راجع artifacts/skills-remote-check.json؛ لا يُخفَّف التحقق من TLS أبداً.\n`);
  if (!result.reachable) process.exitCode = 1;
}
