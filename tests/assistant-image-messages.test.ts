import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentBrowser } from '@mohassan/browser';
import { createDatabase, migrate } from '@mohassan/database';
import { memoryMigration } from '@mohassan/memory';
import type { ImageReading } from '@mohassan/vision';
import { migrateAuth } from '../apps/server/src/auth.js';
import { createCommandChatControl } from '../apps/server/src/command-chat.js';

/** A message with images is read by the own reader and answered at once; the bytes never leave the database. */
const OWNER = 'image-messages-owner';
const OTHER = 'image-messages-other';

function reading(lines: string[]): ImageReading {
  return {
    facts: { width: 80, height: 40, format: 'png', orientation: 'landscape', meanBrightness: 240, darkBackground: false, colorfulness: 1, distinctColors: 3, flatShare: 0.9,
      dominant: [{ hex: '#f0f0f0', share: 0.95, name: 'أبيض' }], surface: 'graphic' },
    lines: lines.map((text, index) => ({ text, visual: text, confidence: 0.96, box: { x: 2, y: 2 + index * 16, w: 70, h: 12 }, block: 0, row: index, direction: 'rtl' as const })),
    blocks: [lines.join('\n')], text: lines.join('\n'), direction: lines.length ? 'rtl' : 'none', kind: 'screenshot', candidates: lines.length, dropped: 0, durationMs: 5, modelId: 'f'.repeat(64),
  };
}

describe('chat messages with images', () => {
  let database: Awaited<ReturnType<typeof createDatabase>>;
  let control: Awaited<ReturnType<typeof createCommandChatControl>>;
  let withoutReader: Awaited<ReturnType<typeof createCommandChatControl>>;
  const reads: number[] = [];
  const refuse = async () => { throw new Error('The browser must not run for an image message.'); };
  const browser = { setCheckpointStore() {}, async bindAccount() {}, async hasPage() { return false; }, async close() {}, act: refuse, observe: refuse, screen: refuse, prepareAction: refuse } as unknown as AgentBrowser;

  beforeAll(async () => {
    database = await createDatabase({});
    await migrateAuth(database.db); await migrate(database.db); await memoryMigration(database.db);
    const imageReader = { available: true, modelId: 'f'.repeat(64), async read(bytes: Uint8Array) { reads.push(bytes.byteLength); return reading(['السعر 150 ريال', 'التسليم خلال 3 أيام']); } };
    control = await createCommandChatControl(database.db, { browser, recordExperiences: false, models: { fast: [], deep: [], vision: '' }, imageReader,
      fullAccess: async account => account === OWNER });
    withoutReader = await createCommandChatControl(database.db, { browser, recordExperiences: false, models: { fast: [], deep: [], vision: '' } });
  });
  afterAll(async () => { await control.shutdown?.(); await withoutReader.shutdown?.(); await database.close?.(); });

  async function png(width = 80, height = 40): Promise<string> {
    return (await sharp({ create: { width, height, channels: 3, background: { r: 250, g: 250, b: 250 } } }).png().toBuffer()).toString('base64');
  }

  it('stores an uploaded image for its owner only', async () => {
    const upload = await control.uploadImage(OWNER, { mimeType: 'image/png', data: await png() });
    expect(upload.width).toBe(80); expect(upload.height).toBe(40); expect(upload.url).toBe(`/api/chat/images/${upload.id}`);
    const served = await control.image(OWNER, upload.id);
    expect(served.mimeType).toBe('image/png'); expect(served.bytes.byteLength).toBeGreaterThan(20);
    await expect(control.image(OTHER, upload.id)).rejects.toMatchObject({ code: 'CHAT_IMAGE_NOT_FOUND' });
  });

  it('rejects bytes that are not an image or do not match the declared type', async () => {
    await expect(control.uploadImage(OWNER, { mimeType: 'image/png', data: Buffer.from('definitely not a picture at all').toString('base64') })).rejects.toMatchObject({ code: 'CHAT_IMAGE_INVALID' });
    await expect(control.uploadImage(OWNER, { mimeType: 'image/jpeg', data: await png() })).rejects.toMatchObject({ code: 'CHAT_IMAGE_INVALID' });
  });

  it('answers from the image and records an owner-visible review without queuing a run', async () => {
    const upload = await control.uploadImage(OWNER, { mimeType: 'image/png', data: await png() });
    const before = reads.length;
    const conversation = await control.create(OWNER, { goal: 'كم السعر؟', images: [upload.id] });
    expect(reads.length).toBe(before + 1);
    expect(conversation.status).toBe('idle');
    expect(conversation.title).toBe('كم السعر؟');
    expect(conversation.messages).toHaveLength(2);
    expect(conversation.messages[0]).toMatchObject({ role: 'user', text: 'كم السعر؟', images: [{ id: upload.id, width: 80, height: 40 }] });
    expect(conversation.messages[1].role).toBe('assistant');
    expect(conversation.messages[1].text).toContain('150 ريال');
    const again = await control.detail(OWNER, conversation.id);
    expect(again.messages[0].images).toEqual([{ id: upload.id, width: 80, height: 40 }]);
    expect(again.run?.deliberation).toMatchObject({
      chosen: { action: 'act', route: 'image', handler: 'image_attachment' }, legacy: { action: 'act', route: 'image' }, enforced: false,
      disagrees: false, review: { revision: 'none', findings: [] },
    });
    expect(JSON.stringify(again.run?.deliberation)).not.toMatch(/كم السعر|التسليم|150 ريال/u);
    expect(await database.db.selectFrom('chat_runs').select('id').where('conversation_id', '=', conversation.id).execute()).toEqual([]);
    // A used image no longer expires, so the thumbnail stays with the message.
    const row = await database.db.selectFrom('chat_images').select(['expires_at', 'conversation_id']).where('id', '=', upload.id).executeTakeFirstOrThrow();
    expect(row.expires_at).toBeNull(); expect(row.conversation_id).toBe(conversation.id);
  });

  it('records the image decision for member messages and omits it from their run view', async () => {
    const image = await control.uploadImage(OTHER, { mimeType: 'image/png', data: await png() });
    const conversation = await control.create(OTHER, { goal: 'كم السعر؟', images: [image.id] });
    expect(conversation.messages.at(-1)?.text).toContain('150 ريال');
    expect(conversation.run).toBeNull();
    expect(await database.db.selectFrom('chat_events').select('id').where('conversation_id', '=', conversation.id)
      .where('kind', '=', 'attachment_deliberation').execute()).toHaveLength(1);
  });

  it('accepts images alone and names the message after them', async () => {
    const first = await control.create(OWNER, { goal: 'مرحبا' }).catch(() => null);
    const upload = await control.uploadImage(OWNER, { mimeType: 'image/png', data: await png(64, 64) });
    const conversation = await control.create(OWNER, { images: [upload.id] });
    expect(conversation.title).toBe('قراءة صورة');
    expect(conversation.messages[0]).toMatchObject({ role: 'user', text: 'صورة' });
    expect(conversation.messages[1].text).toContain('عدد الأسطر: 2');
    const second = await control.uploadImage(OWNER, { mimeType: 'image/png', data: await png(64, 64) });
    const followUp = await control.send(OWNER, conversation.id, { text: 'متى التسليم؟', images: [second.id] });
    expect(followUp.messages).toHaveLength(4);
    expect(followUp.messages[3].text).toContain('التسليم خلال 3 أيام');
    expect(followUp.run?.id).not.toBe(conversation.run?.id);
    expect(followUp.run?.deliberation?.chosen).toMatchObject({ route: 'image' });
    expect(first).toBeDefined();
  });

  it('refuses unknown images, another owner’s images and a server without a reader', async () => {
    const upload = await control.uploadImage(OWNER, { mimeType: 'image/png', data: await png() });
    await expect(control.create(OWNER, { images: [randomUUID()] })).rejects.toMatchObject({ code: 'CHAT_IMAGE_MISSING' });
    await expect(control.create(OTHER, { images: [upload.id] })).rejects.toMatchObject({ code: 'CHAT_IMAGE_MISSING' });
    await expect(withoutReader.create(OWNER, { images: [upload.id] })).rejects.toMatchObject({ code: 'CHAT_IMAGES_UNAVAILABLE' });
  });
});
