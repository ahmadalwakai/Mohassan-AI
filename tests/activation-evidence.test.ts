import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { getActivationEvidence } from '../apps/server/src/activation-console/evidence.js';
import { generatedSwitchRegistry } from '../apps/server/src/activation-console/switch-registry.generated.js';

const root = new URL('../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), 'utf8');

describe('activation switch evidence', () => {
  it('links every registered switch to its risk sources and uses registered dependencies', () => {
    const names = new Set(generatedSwitchRegistry.map(entry => entry.name));
    for (const name of names) {
      const note = getActivationEvidence(name);
      expect(note.sources, name).not.toHaveLength(0);
      for (const dependency of note.dependencies) expect(names.has(dependency), `${name}: ${dependency}`).toBe(true);
      for (const source of note.sources) {
        const path = new URL(source).pathname.split('/').slice(5).join('/');
        expect(existsSync(new URL(path, root)), source).toBe(true);
      }
    }
  });

  it('uses the deployment recipe for the owner v5 trial and points at the failed gate', () => {
    const recipePath = 'docs/V5-OWNER-CHAT-2026-11-26.md';
    const recipe = read(recipePath);
    const config = recipe.match(/```dotenv\n([\s\S]*?)```/)?.[1];
    expect(config).toBeDefined();
    for (const line of config!.trim().split('\n')) {
      const [name, value] = line.trim().split('=');
      expect(getActivationEvidence(name!).ownerTrial).toBe(value);
    }
    const trial = getActivationEvidence('MOHASSAN_V5_CHAT');
    expect(trial.evidence?.path).toBe(recipePath);
    expect(recipe).toContain('The gate remains failed');
    expect(trial.preflight?.args).toEqual([recipe.match(/preflight-wave-6\.mjs (--[a-z\d-]+)/)?.[1]]);
    expect(trial.sources.some(url => url.endsWith(`${recipePath}#server-setup`))).toBe(true);
  });

  it('links later monitor checks to the actual measurements without promising preflight coverage', () => {
    const rollout = getActivationEvidence('MOHASSAN_MONITORS_ENABLED');
    const visual = getActivationEvidence('MOHASSAN_MONITORS_VISUAL');
    const source = read(rollout.preflight!.path);
    expect(source).toContain('env.MOHASSAN_MONITORS_ENABLED');
    expect(source).not.toContain('MOHASSAN_MONITORS_VISUAL');
    expect(visual.preflight).toBeNull();
    expect(read(visual.evidence!.path.split('#')[0]!)).toContain('visual class missed its 90% recall gate');
    expect(visual.dependencies).toContain('MOHASSAN_MONITORS_V2');
  });

  it('keeps prior wave defaults separate from later owner-trial settings', () => {
    const worker = getActivationEvidence('RUN_WORKER');
    const source = read(worker.preflight!.path);
    expect(source).toContain("env.RUN_WORKER === 'false'");
    expect(read('scripts/cloud-linux/README.md')).toContain(`RUN_WORKER=${worker.ownerTrial}`);
    expect(getActivationEvidence('MOHASSAN_MODEL_COUNCIL').dependencies).not.toContain('MOHASSAN_V5_CHAT');
  });

  it('makes missing measurements explicit', () => {
    const note = getActivationEvidence('constructor');
    expect(note.ownerTrial).toBeNull();
    expect(note.preflight).toBeNull();
    expect(note.evidence).toBeNull();
    expect(note.sources).toEqual([]);
    expect(note.risk).toBeTruthy();
  });
});
