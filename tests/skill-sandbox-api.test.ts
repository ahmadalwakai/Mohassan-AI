import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { verifyExecutableGates, type ExecutableReadiness } from '@mohassan/sandbox';
import { SkillSandboxDiagnosticSchema } from '../packages/contracts/src/skill-sandbox.ts';
import { registerSkillSandboxRoutes, type SkillSandboxRoutesOptions } from '../apps/server/src/skill-sandbox.ts';

describe('authenticated read-only sandbox diagnostics', () => {
  const applications: FastifyInstance[] = [];
  const headers = { 'x-fixture-owner': 'diagnostic-owner' };
  async function server(sandbox: SkillSandboxRoutesOptions['sandbox'] = {}) {
    const app = Fastify(); applications.push(app);
    app.setErrorHandler((error: any, _request, reply) => reply.code(error instanceof z.ZodError ? 400 : error.statusCode ?? 500).send({ error: error.code ?? 'INVALID_INPUT' }));
    await registerSkillSandboxRoutes(app, { sandbox, owner: async request => {
      if (request.headers['x-fixture-owner'] !== headers['x-fixture-owner']) throw Object.assign(new Error('Session required.'), { statusCode: 401 });
      return { id: headers['x-fixture-owner'] };
    } });
    return app;
  }
  afterEach(async () => { await Promise.all(applications.splice(0).map(app => app.close())); });

  it('authenticates before querying the runner and exposes no write route', async () => {
    const executableReadiness = vi.fn(async () => verifyExecutableGates());
    const app = await server({ executableReadiness });
    expect((await app.inject({ url: '/api/skills/sandbox' })).statusCode).toBe(401);
    expect(executableReadiness).not.toHaveBeenCalled();
    expect((await app.inject({ method: 'POST', url: '/api/skills/sandbox', headers, payload: { enabled: true } })).statusCode).toBe(404);
    expect(executableReadiness).not.toHaveBeenCalled();
  });

  it('returns only the trusted report and never calls execution or availability probes', async () => {
    const report = verifyExecutableGates({ baselineVerified: true, fixedUnpackagedHostVerified: true });
    const sandbox = { executableReadiness: vi.fn(async () => report), run: vi.fn(), available: vi.fn() };
    const app = await server(sandbox);
    const response = await app.inject({ url: '/api/skills/sandbox', headers });
    expect(response.statusCode, response.body).toBe(200);
    expect(SkillSandboxDiagnosticSchema.parse(response.json())).toEqual({ readiness: report, executionAllowed: false });
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(sandbox.executableReadiness).toHaveBeenCalledExactlyOnceWith();
    expect(sandbox.run).not.toHaveBeenCalled(); expect(sandbox.available).not.toHaveBeenCalled();
    expect(response.json().readiness.gates.find((gate: { id: string }) => gate.id === 'G5')).toMatchObject({ required: true, status: 'blocked' });
  });

  it('rejects client-supplied readiness instead of treating it as evidence', async () => {
    const executableReadiness = vi.fn(async () => verifyExecutableGates());
    const app = await server({ executableReadiness });
    for (const url of ['/api/skills/sandbox?enabled=true', '/api/skills/sandbox?G5=verified', '/api/skills/sandbox?provider=windows-appcontainer']) {
      expect((await app.inject({ url, headers })).statusCode).toBe(400);
    }
    expect(executableReadiness).not.toHaveBeenCalled();
  });

  it('fails closed when the runner has no readiness method or throws', async () => {
    for (const sandbox of [{}, { executableReadiness: async () => { throw new Error('private-token-and-local-path'); } }]) {
      const app = await server(sandbox), response = await app.inject({ url: '/api/skills/sandbox', headers });
      const diagnostic = SkillSandboxDiagnosticSchema.parse(response.json());
      expect(diagnostic.readiness).toMatchObject({ provider: 'unavailable', enabled: false, baselineVerified: false });
      expect(diagnostic.readiness.gates).toHaveLength(8);
      expect(diagnostic.readiness.gates.every(gate => gate.required && gate.status === 'blocked')).toBe(true);
      expect(response.body).not.toContain('private-token-and-local-path');
    }
  });

  it.each(['missing', 'duplicate', 'optional-g5', 'enabled-with-g5-blocked', 'baseline-missing', 'unexpected-property', 'oversized-evidence'] as const)('fails closed for an invalid provider report: %s', async variant => {
    const report: any = structuredClone(verifyExecutableGates());
    if (variant === 'missing') report.gates.pop();
    if (variant === 'duplicate') report.gates[7] = report.gates[0];
    if (variant === 'optional-g5') report.gates.find((gate: { id: string }) => gate.id === 'G5').required = false;
    if (variant === 'enabled-with-g5-blocked') { report.enabled = true; report.baselineVerified = true; report.gates.forEach((gate: { id: string; status: string }) => { gate.status = gate.id === 'G5' ? 'blocked' : 'verified'; }); }
    if (variant === 'baseline-missing') { report.enabled = true; report.gates.forEach((gate: { status: string }) => { gate.status = 'verified'; }); }
    if (variant === 'unexpected-property') report.secret = 'private';
    if (variant === 'oversized-evidence') report.gates[0].evidence = ['x'.repeat(401)];
    const app = await server({ executableReadiness: async () => report as ExecutableReadiness });
    const response = await app.inject({ url: '/api/skills/sandbox', headers });
    expect(response.json().readiness).toMatchObject({ provider: 'unavailable', enabled: false, baselineVerified: false });
    expect(response.json().executionAllowed).toBe(false);
  });

  it('keeps a complete verified synthetic report diagnostic rather than an execution permit', async () => {
    const report = verifyExecutableGates(); report.baselineVerified = true; report.enabled = true;
    for (const gate of report.gates) { gate.status = 'verified'; gate.reason = 'Synthetic schema fixture only.'; }
    const app = await server({ executableReadiness: async () => report });
    expect((await app.inject({ url: '/api/skills/sandbox', headers })).json()).toEqual({ readiness: report, executionAllowed: false });
  });
});
