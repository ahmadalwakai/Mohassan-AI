// Adapted from PR #43's log sources, retrieved 2026-11-27.
// https://github.com/ahmadalwakai/Mohassan-AI/blob/470d5593e4c8/apps/server/src/activation-log-sources.ts
import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { logObject, projectConsoleObservation, projectFileObservations, type ActivationEvent } from './events.js';

const channels = ['console.info', 'console.warn', 'console.error'];
const maxEvents = 1024;
const logTailBytes = 2 * 1024 * 1024;
const skippedFiles = new Set(['ENOENT', 'ENOTDIR', 'ELOOP', 'EACCES', 'EPERM']);

/** Keep a bounded process-level count of known signals. Raw console and chat text never enter the buffer. */
export function observeActivationConsoleLogs(now = () => new Date()) {
  const events: ActivationEvent[] = [];
  let offset = 0;
  const observe = (args: unknown) => {
    if (!Array.isArray(args) || args.length !== 1 || typeof args[0] !== 'string'
      || args[0].length > 64 * 1024 || !args[0].startsWith('{')) return;
    let value: Record<string, unknown> | undefined;
    try { value = logObject(JSON.parse(args[0])); } catch { return; }
    if (!value) return;
    const observation = projectConsoleObservation(value, now());
    if (!observation) return;
    events[offset] = observation;
    offset = (offset + 1) % maxEvents;
  };
  for (const channel of channels) subscribe(channel, observe);
  return {
    events: () => events.slice(),
    close: () => { for (const channel of channels) unsubscribe(channel, observe); },
  };
}

export async function readActivationLogEvents(path: string, source: 'judge' | 'conversation', from: Date, to: Date) {
  let file: Awaited<ReturnType<typeof open>>;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (skippedFiles.has((error as NodeJS.ErrnoException).code ?? '')) return [];
    throw error;
  }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size === 0) return [];
    const start = Math.max(0, stat.size - logTailBytes);
    const buffer = Buffer.alloc(stat.size - start);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
    const lines = buffer.toString('utf8', 0, bytesRead).split('\n');
    if (start > 0) lines.shift();
    const observations: { conversationId: string; events: ActivationEvent[] }[] = [];
    for (const line of new Set(lines)) {
      if (!line || line.length > 256 * 1024) continue;
      let value: Record<string, unknown> | undefined;
      try { value = logObject(JSON.parse(line)); } catch { continue; }
      if (!value || typeof value.at !== 'string' || typeof value.conversationId !== 'string' || value.conversationId.length > 100) continue;
      const at = new Date(value.at);
      if (!Number.isFinite(at.getTime()) || at < from || at >= to) continue;
      const events = projectFileObservations(source, value, at);
      if (events.length) observations.push({ conversationId: value.conversationId, events });
    }
    return observations;
  } finally {
    await file.close();
  }
}
