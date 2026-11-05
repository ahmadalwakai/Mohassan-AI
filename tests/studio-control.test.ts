import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, migrate } from '@mohassan/database';
import { migrateAuth } from '../apps/server/src/auth.js';
import { createStudioControl } from '../apps/server/src/studio.js';

describe('persistent static studio review copies', () => {
  let store: Awaited<ReturnType<typeof createDatabase>>;
  let studio: Awaited<ReturnType<typeof createStudioControl>>;
  const ownerId = 'studio-fixture-owner';
  const otherOwnerId = 'studio-other-owner';

  beforeAll(async () => {
    store = await createDatabase();
    await migrateAuth(store.db);
    await migrate(store.db);
    for (const [id, email] of [[ownerId, 'studio-owner@example.test'], [otherOwnerId, 'studio-other@example.test']]) {
      await store.db.insertInto('user' as any).values({ id, name: id, email }).execute();
    }
    studio = await createStudioControl(store.db, { allowedRoots: [] });
  });

  afterAll(async () => { await store?.close(); });

  it('persists an owner-scoped demo without executing project code', async () => {
    const session = await studio.demo(ownerId);
    expect((await studio.demo(ownerId)).id).toBe(session.id);
    expect(session.sourcePath).toBeNull();
    expect(session.files).toEqual(session.baseFiles);
    expect((await studio.workspace(ownerId)).sessions.map(item => item.id)).toEqual([session.id]);
    expect((await studio.workspace(otherOwnerId)).sessions).toEqual([]);
    await expect(studio.detail(otherOwnerId, session.id)).rejects.toMatchObject({ code: 'STUDIO_NOT_FOUND', statusCode: 404 });
    await expect(studio.preview(otherOwnerId, session.id)).rejects.toMatchObject({ code: 'STUDIO_NOT_FOUND', statusCode: 404 });
  });

  it('saves explicit edits atomically and keeps the baseline available', async () => {
    const session = await studio.demo(ownerId);
    const original = JSON.stringify(session.files);
    const preview = await studio.preview(ownerId, session.id);
    const secondPreview = await studio.preview(ownerId, session.id);
    expect(secondPreview.nonce).not.toBe(preview.nonce);
    expect(secondPreview.revision).toBe(session.revision);
    const element = preview.elements.find(item => item.editableText);
    expect(element).toBeDefined();
    const edit = { revision: session.revision, elementId: element!.id, text: 'نص مرئي محفوظ للاختبار', styles: { color: '#123456', fontSize: 28 } };
    await expect(studio.edit(otherOwnerId, session.id, edit)).rejects.toMatchObject({ code: 'STUDIO_NOT_FOUND' });
    const saved = await studio.edit(ownerId, session.id, edit);
    expect(saved.revision).not.toBe(session.revision);
    expect(saved.historyCount).toBe(1);
    expect(JSON.stringify(saved.baseFiles)).toBe(original);
    expect(JSON.stringify(saved.files)).not.toBe(original);
    expect((await studio.preview(ownerId, session.id)).elements.some(item => item.text === edit.text)).toBe(true);
    const baseline = await studio.preview(ownerId, session.id, true);
    expect(baseline.document).not.toContain(edit.text);
    expect(baseline.revision).toBe(saved.revision);
    const reloadedControl = await createStudioControl(store.db, { allowedRoots: [] });
    expect(await reloadedControl.detail(ownerId, session.id)).toEqual(saved);
    await expect(studio.edit(ownerId, session.id, edit)).rejects.toMatchObject({ code: 'STUDIO_REVISION_CONFLICT', statusCode: 409 });
    const undone = await studio.undo(ownerId, session.id, { revision: saved.revision });
    expect(JSON.stringify(undone.files)).toBe(original);
    expect(undone.historyCount).toBe(0);
    expect(undone.revision).not.toBe(session.revision);
    await expect(studio.edit(ownerId, session.id, edit)).rejects.toMatchObject({ code: 'STUDIO_REVISION_CONFLICT' });
    await expect(studio.undo(ownerId, session.id, { revision: undone.revision })).rejects.toMatchObject({ code: 'STUDIO_NOTHING_TO_UNDO' });
  });

  it('rejects forged element identities and unrecognized edit fields', async () => {
    const session = await studio.demo(ownerId);
    await expect(studio.edit(ownerId, session.id, { revision: session.revision, elementId: 'n999999', text: 'forged' })).rejects.toBeDefined();
    await expect(studio.edit(ownerId, session.id, { revision: session.revision, elementId: 'n0', text: 'forged', path: '../.env' })).rejects.toBeDefined();
    expect((await studio.detail(ownerId, session.id)).revision).toBe(session.revision);
  });

  it('bounds the undo stack and accepts only one write from the same revision', async () => {
    let session = await studio.demo(ownerId);
    let elementId = (await studio.preview(ownerId, session.id)).elements.find(item => item.editableText)!.id;
    const writes = await Promise.allSettled([
      studio.edit(ownerId, session.id, { revision: session.revision, elementId, text: 'concurrent first' }),
      studio.edit(ownerId, session.id, { revision: session.revision, elementId, text: 'concurrent second' }),
    ]);
    expect(writes.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(writes.filter(result => result.status === 'rejected')).toHaveLength(1);
    session = await studio.detail(ownerId, session.id);
    for (let index = 0; index < 22; index++) {
      elementId = (await studio.preview(ownerId, session.id)).elements.find(item => item.editableText)!.id;
      session = await studio.edit(ownerId, session.id, { revision: session.revision, elementId, text: `bounded edit ${index}` });
    }
    expect(session.historyCount).toBe(20);
    expect(session.baseFiles).not.toEqual(session.files);
    await expect(studio.create(ownerId, { name: 'غير مصرح', path: 'C:\\outside-fixture', entryPath: 'index.html' })).rejects.toBeDefined();
  });
});
