import { execFileSync } from 'node:child_process';
import { registerHooks, createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [serverCheckout, dependencies] = process.argv.slice(2);
if (!serverCheckout || !dependencies) {
  throw new Error('Usage: node generate-monitor-fixtures.mjs <server checkout> <Zod install directory>');
}

const contractCommit = 'a453dc17a78f55c0cd3e5bf23f347843893bc3d2';
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: serverCheckout, encoding: 'utf8' }).trim();
if (head !== contractCommit) throw new Error(`Expected monitor contract commit ${contractCommit}, got ${head}`);

// Resolve the pinned server dependency from a temporary install outside the read-only checkout.
const require = createRequire(resolve(dependencies, 'package.json'));
const zod = pathToFileURL(require.resolve('zod')).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(specifier === 'zod' ? zod : specifier, context);
  },
});
const { MonitorApproveSchema, MonitorCardSchema, MonitorListSchema } = await import(pathToFileURL(
  resolve(serverCheckout, 'packages/contracts/src/monitors.ts'),
).href);

const checkedAt = '2026-11-25T12:00:00.000Z';
const nextCheckAt = '2026-11-25T13:00:00.000Z';
const conversationId = '00000000-0000-4000-8000-000000000001';
const observation = (value, excerpt) => ({ value, excerpt, observedAt: checkedAt });
const card = (index, status, title, source, read, condition, current, extra = {}) => MonitorCardSchema.parse({
  id: `00000000-0000-4000-8000-00000000001${index}`,
  conversationId,
  status,
  spec: {
    title, source, read, condition, language: 'ar', message: 'تحقق شرط المراقبة',
    timing: { urgency: 'normal', lifetimeMs: 604_800_000, initialIntervalMs: 3_600_000, maxChecks: 52, maxNotifications: 3 },
  },
  current,
  lastCheckedAt: current ? checkedAt : null,
  nextCheckAt: status === 'active' ? nextCheckAt : null,
  expiresAt: '2026-12-02T12:00:00.000Z',
  ...extra,
});

// Mix account states in server order to exercise the settings priority on the phone.
const proposed = card(1, 'proposed', 'سعر الدولار مقابل الريال', { kind: 'currency', base: 'USD', quote: 'SAR' },
  { kind: 'number' }, { kind: 'crossing', direction: 'below', value: 3.70, hysteresis: 0.01 },
  observation(3.75, '3.75 SAR'), { offer: 'explicit', expiresAt: '2026-11-25T12:30:00.000Z' });
const active = card(2, 'active', 'موعد التسجيل', { kind: 'page', url: 'https://example.org/enrolment', anchor: 'التسجيل' },
  { kind: 'status', label: 'حالة التسجيل' }, { kind: 'contains', value: 'مفتوح' }, observation('مغلق', 'التسجيل مغلق'));
const paused = card(3, 'paused', 'إعلان التسجيل', { kind: 'page', url: 'https://example.org/enrolment' },
  { kind: 'phrase', phrase: 'التسجيل مفتوح' }, { kind: 'appears' }, observation(false, 'العبارة غير موجودة'),
  { offer: 'implicit', note: 'تعذّر الوصول إلى المصدر عدة مرات.' });
const stopped = card(4, 'stopped', 'الحرارة في دمشق', { kind: 'weather', location: 'دمشق', metric: 'temperature', latitude: 33.51, longitude: 36.29 },
  { kind: 'number' }, { kind: 'threshold', direction: 'above', value: 32, hysteresis: 1 }, observation(27, '27 °C'));
const completed = card(5, 'completed', 'نتائج البحث عن التسجيل', { kind: 'search', query: 'بدء التسجيل' },
  { kind: 'items' }, { kind: 'new-item' }, observation(['https://example.org/result'], 'ظهرت نتيجة جديدة.'));
const expired = card(6, 'expired', 'حالة المهمة', { kind: 'run', runId: '00000000-0000-4000-8000-000000000002' },
  { kind: 'status' }, { kind: 'change' }, null, { offer: 'agent-initiated', expiresAt: checkedAt });

const list = MonitorListSchema.parse({ monitors: [proposed, paused, expired, active, completed, stopped] });
const approval = MonitorApproveSchema.parse({ proposalId: proposed.id });

// Mutate verified payloads to exercise newer servers. The pinned strict schema rejects these variants.
const unknownStatus = { ...active, status: 'waiting-for-provider' };
const unknownSource = { ...proposed, spec: { ...proposed.spec, source: { kind: 'public-data-feed', url: ['https://example.org/feed'] } } };
const unknownCondition = { ...proposed, spec: { ...proposed.spec, condition: { kind: 'stable-for', value: { minutes: 50 }, hysteresis: [30, 60] } } };
const unknownFields = { ...active, previewFormat: 'extended', spec: { ...active.spec, notes: ['extra'] } };
const malformedCard = { ...paused, spec: null };
const future = { unknownStatus, unknownSource, unknownCondition, unknownFields, malformedCard };
for (const [name, variant] of Object.entries(future)) {
  if (MonitorCardSchema.safeParse(variant).success) throw new Error(`Expected ${name} to be outside the pinned contract`);
}

process.stdout.write(`${JSON.stringify({ contractCommit, list, approval, future }, null, 2)}\n`);
