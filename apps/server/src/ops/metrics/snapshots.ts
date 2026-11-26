import {lstat, mkdir, readFile, readdir, rename, rm, unlink, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {decodeBucket, decodeSnapshot, encodeSnapshot} from './snapshot-format';
import {bucketStart, hourlySlots, hourMs, minuteMs, type MetricsStore} from './store';

export const snapshotRetentionMs = 30 * 24 * hourMs;
export const defaultSnapshotCapBytes = 64 * 1024 * 1024;
const managedName = /^metrics-(0|[1-9]\d*)(?:-([1-9]\d*))?\.jsonl$/;
const filename = (startMs: number, sequence: number) => `metrics-${startMs}${sequence ? `-${sequence}` : ''}.jsonl`;

type SnapshotFile = {path: string; hourStartMs: number; sequence: number; bytes: number};
type SnapshotOptions = {maxBytes?: number; restoreChat?: boolean; restoreV5Chat?: boolean};

export class MetricsSnapshots {
  readonly #store: MetricsStore;
  readonly #directory: string;
  readonly #maxBytes: number;
  readonly #restoreChat: boolean;
  readonly #restoreV5Chat: boolean;
  #queue = Promise.resolve();
  #lastMaintenance = -1;
  #loaded = false;
  #healthy = false;

  constructor(store: MetricsStore, directory: string, {maxBytes = defaultSnapshotCapBytes, restoreChat = true, restoreV5Chat = true}: SnapshotOptions = {}) {
    this.#store = store;
    this.#directory = directory;
    this.#maxBytes = maxBytes;
    this.#restoreChat = restoreChat;
    this.#restoreV5Chat = restoreV5Chat;
    store.enableSnapshots();
  }

  get healthy(): boolean {
    return this.#healthy;
  }

  load(): Promise<void> {
    return this.#enqueue(async () => {
      if (this.#loaded) return;
      const hourStart = bucketStart(this.#store.nowMs(), hourMs);
      const files = await this.#files();
      await this.#prune(files, hourStart);
      this.#lastMaintenance = hourStart;
      this.#loaded = true;
      const earliestHour = hourStart - hourlySlots * hourMs;
      // Populate newer windows first if the histogram memory budget is exhausted.
      for (const file of files.reverse()) {
        if (file.hourStartMs < earliestHour || file.hourStartMs > hourStart) continue;
        for (const line of (await readFile(file.path, 'utf8')).split('\n')) {
          if (!line) continue;
          const snapshot = decodeSnapshot(line);
          if (!snapshot || snapshot.hourStartMs !== file.hourStartMs) continue;
          for (const [startMs, bucket] of snapshot.minutes) {
            if (startMs % minuteMs === 0 && bucketStart(startMs, hourMs) === file.hourStartMs) {
              this.#store.loadMinute(startMs, decodeBucket(bucket, this.#restoreChat, this.#restoreV5Chat));
            }
          }
        }
      }
      this.#healthy = true;
    });
  }

  flush({includeCurrentHour = false}: {includeCurrentHour?: boolean} = {}): Promise<void> {
    return this.#enqueue(async () => {
      const now = this.#store.nowMs();
      const hourStart = bucketStart(now, hourMs);
      const pending = this.#store.pendingHours.filter(hour => hour < hourStart || includeCurrentHour);
      if (!pending.length && this.#lastMaintenance === hourStart) return;
      const files = await this.#files();
      await this.#prune(files, hourStart);
      let allWritten = true;
      for (const hour of pending) {
        const minutes = this.#store.takePendingHour(hour);
        if (!minutes) continue;
        try {
          const data = `${encodeSnapshot(hour, minutes)}\n`;
          const bytes = Buffer.byteLength(data);
          if (bytes > this.#maxBytes) {
            this.#store.releasePendingHour(minutes);
            allWritten = false;
            continue;
          }
          const sequence = files.reduce((next, file) => file.hourStartMs === hour ? Math.max(next, file.sequence + 1) : next, 0);
          const path = join(this.#directory, filename(hour, sequence));
          const temporary = path + '.pending';
          await this.#prune(files, hourStart, bytes);
          try {
            // Commit the whole segment at once. A failed write cannot leave a
            // readable record that gets counted again when it is retried.
            await writeFile(temporary, data, {encoding: 'utf8', flag: 'wx', mode: 0o600});
            await rename(temporary, path);
          } finally {
            await rm(temporary, {force: true}).catch(() => undefined);
          }
          files.push({path, hourStartMs: hour, sequence, bytes});
          this.#store.releasePendingHour(minutes);
        } catch (error) {
          this.#store.restorePendingHour(hour, minutes);
          throw error;
        }
      }
      this.#lastMaintenance = hourStart;
      this.#healthy = allWritten;
    });
  }

  #enqueue(operation: () => Promise<void>): Promise<void> {
    this.#queue = this.#queue.then(operation).catch(() => { this.#healthy = false; });
    return this.#queue;
  }

  async #files(): Promise<SnapshotFile[]> {
    await mkdir(this.#directory, {recursive: true, mode: 0o700});
    const entries = await readdir(this.#directory, {withFileTypes: true});
    const files = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const path = join(this.#directory, entry.name);
      const match = managedName.exec(entry.name);
      if (!match) {
        if (entry.name.endsWith('.pending') && managedName.test(entry.name.slice(0, -'.pending'.length))) await unlink(path);
        continue;
      }
      const hourStartMs = Number(match[1]);
      if (!Number.isSafeInteger(hourStartMs) || hourStartMs % hourMs !== 0) continue;
      const sequence = Number(match[2] ?? 0);
      if (!Number.isSafeInteger(sequence)) continue;
      const stat = await lstat(path);
      if (stat.isFile()) files.push({path, hourStartMs, sequence, bytes: stat.size});
    }
    return files;
  }

  async #prune(files: SnapshotFile[], hourStart: number, incomingBytes = 0): Promise<void> {
    files.sort((left, right) => left.hourStartMs - right.hourStartMs || left.sequence - right.sequence);
    let bytes = files.reduce((total, file) => total + file.bytes, incomingBytes);
    for (const file of [...files]) {
      const expired = file.hourStartMs <= hourStart - snapshotRetentionMs;
      if (!expired && bytes <= this.#maxBytes) continue;
      await unlink(file.path);
      files.splice(files.indexOf(file), 1);
      bytes -= file.bytes;
    }
    if (bytes > this.#maxBytes) throw new Error('Metrics snapshot directory exceeds storage limit');
  }
}
