import { randomBytes } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { WorkspaceSnapshotSchema } from '../packages/contracts/src/index.js';
import { createApplication, type AppConfig } from '../apps/server/src/app.js';

it('recovers an orphan local bootstrap claim after restart and preserves the completed owner', async () => {
  const tempBase = await realpath(tmpdir());
  const prefix = 'mohassan-setup-recovery-';
  const directory = await mkdtemp(join(tempBase, prefix));
  const config: AppConfig = {
    dataDir: join(directory, 'postgres'),
    authSecret: randomBytes(48).toString('hex'),
    internalSecret: randomBytes(48).toString('hex'),
    setupToken: randomBytes(48).toString('hex'),
    webOrigin: 'http://localhost:3000',
    production: false,
    runWorker: false,
  };
  const headers = { 'x-mohassan-internal': config.internalSecret, origin: config.webOrigin };
  const owner = { name: 'مالك استعادة الاختبار', email: 'recovery@example.test', password: 'Test-only-recovery-password-2026!' };
  let application: Awaited<ReturnType<typeof createApplication>> | undefined;

  try {
    application = await createApplication(config);
    // Fixture the durable state left by a process dying after claim, before sign-up commits.
    await application.database.db.insertInto('workspace_owner').values({ id: 1, owner_id: null }).execute();
    const before = await application.database.db.selectFrom('workspace_owner').selectAll().execute();
    expect(before).toHaveLength(1);
    expect(before[0].owner_id).toBeNull();
    await application.app.close();
    application = undefined;

    application = await createApplication(config);
    const orphan = await application.database.db.selectFrom('workspace_owner').selectAll().execute();
    expect(orphan).toHaveLength(0);
    const setupStatus = await application.app.inject({ method: 'GET', url: '/api/setup', headers });
    expect(setupStatus.json()).toMatchObject({ needsSetup: true, setupAvailable: true });

    const setup = await application.app.inject({
      method: 'POST', url: '/api/setup', headers, payload: { ...owner, setupToken: config.setupToken },
    });
    expect(setup.statusCode).toBe(200);
    expect(setup.body).not.toContain(config.setupToken);
    expect(setup.body).not.toContain(owner.password);
    const signedIn = await application.app.inject({
      method: 'POST', url: '/api/auth/sign-in/email', headers,
      payload: { email: owner.email, password: owner.password },
    });
    expect(signedIn.statusCode).toBe(200);
    const cookie = signedIn.cookies.map((entry) => `${entry.name}=${entry.value}`).join('; ');
    expect(cookie).not.toBe('');
    const workspace = await application.app.inject({ method: 'GET', url: '/api/workspace', headers: { ...headers, cookie } });
    expect(workspace.statusCode).toBe(200);
    const snapshot = WorkspaceSnapshotSchema.parse(workspace.json());
    expect(snapshot.user.email).toBe(owner.email);
    const ownerId = snapshot.user.id;
    await application.app.close();
    application = undefined;

    application = await createApplication(config);
    const completed = await application.database.db.selectFrom('workspace_owner').selectAll().execute();
    expect(completed).toHaveLength(1);
    expect(completed[0].owner_id).toBe(ownerId);
    const afterRestart = await application.app.inject({ method: 'GET', url: '/api/setup', headers });
    expect(afterRestart.json()).toMatchObject({ needsSetup: false });
    const sessionAfterRestart = await application.app.inject({
      method: 'GET', url: '/api/workspace', headers: { ...headers, cookie },
    });
    expect(sessionAfterRestart.statusCode).toBe(200);
    expect(WorkspaceSnapshotSchema.parse(sessionAfterRestart.json()).user.id).toBe(ownerId);
  } finally {
    await application?.app.close();
    // Verify the absolute removal target belongs to this test's newly created temp directory.
    const target = await realpath(resolve(directory));
    const withinTemp = relative(tempBase, target);
    if (!isAbsolute(target) || !withinTemp.startsWith(prefix) || withinTemp.includes('..') || isAbsolute(withinTemp)) {
      throw new Error('Refusing to remove a directory outside this test temporary workspace.');
    }
    await rm(target, { recursive: true, force: true });
  }
});
