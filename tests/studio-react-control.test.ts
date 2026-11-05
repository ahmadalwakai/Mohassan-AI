import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, migrate } from '@mohassan/database';
import { StudioError } from '@mohassan/studio';
import { instrumentReactSnapshot, reactSourceHash, type buildReactStudio, type ReactStudioArtifact, type ReactStudioSnapshot } from '@mohassan/studio-react';
import { migrateAuth } from '../apps/server/src/auth.js';
import { createStudioControl } from '../apps/server/src/studio.js';

type Builder = typeof buildReactStudio;
const escaped = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Deliberate unit fixture. Real project execution is verified by renderer/e2e tests. */
function unitArtifact(snapshot: ReactStudioSnapshot, repeatedHeading = false): ReactStudioArtifact {
  const source = instrumentReactSnapshot(snapshot), sourceHash = reactSourceHash(snapshot);
  const heading = source.elements.find(element => element.tag === 'h1')!;
  const counter = source.elements.find(element => element.tag === 'p' && element.file === snapshot.entryPath && !element.editableText)!;
  const headingHtml = `<h1 data-mohassan-source-id="${heading.id}" style="color:${escaped(heading.styles.color)};font-size:${escaped(heading.styles.fontSize)}">${escaped(heading.text!)}</h1>`;
  return {
    sourceHash, html: headingHtml + (repeatedHeading ? headingHtml : '') + `<p data-mohassan-source-id="${counter.id}">القيمة الحالية: 3</p>`,
    css: source.css, elements: source.elements, warnings: ['Explicit unit fixture; no project code is executed.'],
    verification: {provider:'unit-fixture', sourceHash, snapshotHash:'a'.repeat(64), network:'denied', isolation:'appcontainer', isolationVerified:true, durationMs:1},
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => {resolve = accept;});
  return {promise, resolve};
}

describe('React studio persisted build artifacts and optimistic saves', () => {
  let store: Awaited<ReturnType<typeof createDatabase>>;
  beforeAll(async () => {store = await createDatabase(); await migrateAuth(store.db); await migrate(store.db);});
  afterAll(async () => {await store?.close();});
  async function control(label: string, buildReact: Builder) {
    const ownerId = `react-control-${label}`;
    await store.db.insertInto('user').values({id:ownerId, name:ownerId, email:`${label}@react-control.example.test`}).execute();
    return {ownerId, studio:await createStudioControl(store.db, {allowedRoots:[], buildReact})};
  }

  it('retains a React demo once and serves cached reads after controller reconstruction', async () => {
    let builds = 0;
    const {ownerId, studio} = await control('cached', async snapshot => {builds++; return unitArtifact(snapshot);});
    const session = await studio.demo(ownerId, 'react');
    expect(session.framework).toBe('react'); expect(builds).toBe(1);
    expect((await studio.demo(ownerId, 'react')).id).toBe(session.id); expect(builds).toBe(1);
    const reloaded = await createStudioControl(store.db, {allowedRoots:[], buildReact:async () => {throw new Error('GET must never build');}});
    expect(await reloaded.detail(ownerId, session.id)).toEqual(session);
    const preview = await reloaded.preview(ownerId, session.id);
    expect(preview.verification).toMatchObject({provider:'unit-fixture', network:'denied', isolationVerified:true});
    expect((await reloaded.preview(ownerId, session.id, true)).verification?.sourceHash).toBe(preview.verification?.sourceHash);
    expect((await reloaded.preview(ownerId, session.id)).nonce).not.toBe(preview.nonce);
    await expect(reloaded.preview('different-owner', session.id)).rejects.toMatchObject({code:'STUDIO_NOT_FOUND', statusCode:404});
    expect(builds).toBe(1);
  });

  it('builds changed TSX before saving and restores an existing artifact on undo without execution', async () => {
    let builds = 0;
    const {ownerId, studio} = await control('undo', async snapshot => {builds++; return unitArtifact(snapshot);});
    const original = await studio.demo(ownerId, 'react'), firstPreview = await studio.preview(ownerId, original.id);
    const heading = firstPreview.elements.find(element => element.tag === 'h1')!;
    const saved = await studio.edit(ownerId, original.id, {revision:original.revision, elementId:heading.id, text:'نص React محفوظ'});
    const secondPreview = await studio.preview(ownerId, original.id);
    expect(saved.files.find(file => file.path === heading.file)?.content).toContain('نص React محفوظ');
    expect(saved.baseFiles).toEqual(original.files); expect(saved.historyCount).toBe(1);
    expect(secondPreview.verification?.sourceHash).not.toBe(firstPreview.verification?.sourceHash); expect(builds).toBe(2);
    expect((await studio.preview(ownerId, original.id, true)).verification?.sourceHash).toBe(firstPreview.verification?.sourceHash);
    const undone = await studio.undo(ownerId, original.id, {revision:saved.revision});
    expect(undone.files).toEqual(original.files); expect(undone.revision).not.toBe(original.revision);
    expect((await studio.preview(ownerId, original.id)).verification?.sourceHash).toBe(firstPreview.verification?.sourceHash);
    expect(builds).toBe(2);
    await expect(studio.edit(ownerId, original.id, {revision:original.revision, elementId:heading.id, text:'طلب قديم'})).rejects.toMatchObject({code:'STUDIO_REVISION_CONFLICT', statusCode:409});
  });

  it('preserves the source revision, prior artifact and lock cleanup when a build fails', async () => {
    let fail = false, builds = 0;
    const {ownerId, studio} = await control('failure', async snapshot => {
      builds++; if (fail) throw new StudioError('REACT_RENDER_FAILED', 'Deliberate failed unit render', 422);
      return unitArtifact(snapshot);
    });
    const session = await studio.demo(ownerId, 'react'), preview = await studio.preview(ownerId, session.id);
    const heading = preview.elements.find(element => element.tag === 'h1')!;
    fail = true;
    await expect(studio.edit(ownerId, session.id, {revision:session.revision, elementId:heading.id, text:'فشل البناء فلا يحفظ'})).rejects.toMatchObject({code:'REACT_RENDER_FAILED'});
    expect(await studio.detail(ownerId, session.id)).toEqual(session);
    expect((await studio.preview(ownerId, session.id)).verification?.sourceHash).toBe(preview.verification?.sourceHash);
    expect(await store.db.selectFrom('studio_builds').select('source_hash').where('session_id','=',session.id).execute()).toHaveLength(1);
    expect(await store.db.selectFrom('studio_build_locks').select('token').execute()).toHaveLength(0);
    expect(builds).toBe(2);
  });

  it('rejects a late build if undo advanced the SQL revision while execution was pending', async () => {
    const started = deferred<void>(), release = deferred<void>();
    let builds = 0;
    const {ownerId, studio} = await control('race', async snapshot => {
      builds++; if (builds === 3) {started.resolve(); await release.promise;}
      return unitArtifact(snapshot);
    });
    const original = await studio.demo(ownerId, 'react');
    const heading = (await studio.preview(ownerId, original.id)).elements.find(element => element.tag === 'h1')!;
    const saved = await studio.edit(ownerId, original.id, {revision:original.revision, elementId:heading.id, text:'الإصدار الثاني'});
    const pending = studio.edit(ownerId, original.id, {revision:saved.revision, elementId:heading.id, text:'إصدار وصل متأخرًا'}).then(value => ({value, error:null}), error => ({value:null, error}));
    await started.promise;
    const undone = await studio.undo(ownerId, original.id, {revision:saved.revision});
    release.resolve();
    expect((await pending).error).toMatchObject({code:'STUDIO_REVISION_CONFLICT', statusCode:409});
    expect(await studio.detail(ownerId, original.id)).toEqual(undone);
    expect(undone.files).toEqual(original.files);
    expect((await studio.preview(ownerId, original.id)).verification?.sourceHash).toBe(reactSourceHash({...original, framework:'react'}));
    expect(await store.db.selectFrom('studio_builds').select('source_hash').where('session_id','=',original.id).execute()).toHaveLength(1);
  });

  it('excludes repeated render identities and refuses direct edits to those source ids', async () => {
    let builds = 0;
    const {ownerId, studio} = await control('repeated', async snapshot => {builds++; return unitArtifact(snapshot, true);});
    const session = await studio.demo(ownerId, 'react');
    const headingId = instrumentReactSnapshot({...session, framework:'react'}).elements.find(element => element.tag === 'h1')!.id;
    const preview = await studio.preview(ownerId, session.id);
    expect(preview.elements.some(element => element.id === headingId)).toBe(false);
    await expect(studio.edit(ownerId, session.id, {revision:session.revision, elementId:headingId, text:'تعديل غامض'})).rejects.toMatchObject({code:'STUDIO_ELEMENT_NOT_FOUND', statusCode:409});
    expect((await studio.detail(ownerId, session.id)).revision).toBe(session.revision); expect(builds).toBe(1);
  });

  it('rejects an artifact for the wrong source before retaining a new session', async () => {
    const {ownerId, studio} = await control('wrong-hash', async snapshot => {
      const artifact = unitArtifact(snapshot); artifact.sourceHash = 'b'.repeat(64); artifact.verification.sourceHash = artifact.sourceHash; return artifact;
    });
    await expect(studio.demo(ownerId, 'react')).rejects.toMatchObject({code:'STUDIO_BUILD_MISMATCH', statusCode:409});
    expect((await studio.workspace(ownerId)).sessions).toEqual([]);
    expect(await store.db.selectFrom('studio_build_locks').select('token').execute()).toHaveLength(0);
  });
});
