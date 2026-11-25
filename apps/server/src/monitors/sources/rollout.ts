import { monitorV2Targets, type MonitorSpec } from '@mohassan/contracts';
import { sql } from 'kysely';
import type { MonitorSourceFlags } from '../flag.js';

const kinds = ['github', 'pdf', 'visual'] as const;

export function monitorSourcesAvailable(spec: MonitorSpec, flags: MonitorSourceFlags) {
  const targets = monitorV2Targets(spec);
  return kinds.every(kind => flags[kind] || targets.every(({ source }) => source.kind !== kind));
}

export function monitorDisabledSourcePredicates(column: 'spec' | 'm.spec', flags: MonitorSourceFlags) {
  return kinds.filter(kind => !flags[kind]).map(kind => sql<boolean>`
    NOT (${sql.ref(column)} @> ${JSON.stringify({ source: { kind } })}::jsonb
      OR ${sql.ref(column)} @> ${JSON.stringify({ v2: { additional: [{ source: { kind } }] } })}::jsonb)`);
}
