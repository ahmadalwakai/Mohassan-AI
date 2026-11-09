import { EventEmitter } from 'node:events';
import pg from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, sql, type DatabaseHandle } from '@mohassan/database';

// Keep the real pg pool and Kysely driver, replacing only the network client.
// pg rejects pending queries, marks a lost socket unusable, then emits `error`.
class NetworkClient extends EventEmitter {
  static clients: NetworkClient[] = [];
  _queryable = true;
  _ending = false;
  pendingReject?: (error: Error) => void;
  queries: string[] = [];

  constructor() { super(); NetworkClient.clients.push(this); }
  connect(done: (error?: Error) => void) { queueMicrotask(() => done()); }
  end(done?: () => void) { this._ending = true; queueMicrotask(() => done?.()); }
  query(text: string) {
    this.queries.push(text);
    if (text === 'select wait_for_connection_loss()') {
      return new Promise<never>((_, reject) => { this.pendingReject = reject; });
    }
    return Promise.resolve({ command: 'SELECT', rowCount: 1, rows: [{ value: 1 }] });
  }
  disconnect(error: Error) {
    this._queryable = false;
    this.pendingReject?.(error);
    this.emit('error', error);
  }
}

const RealPool = pg.Pool;
let pool: pg.Pool;
let store: DatabaseHandle;

beforeEach(async () => {
  NetworkClient.clients = [];
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(pg, 'Pool').mockImplementation(function (config?: pg.PoolConfig) {
    pool = new RealPool({ ...config, Client: NetworkClient as unknown as typeof pg.Client });
    return pool;
  });
  store = await createDatabase({ connectionString: 'postgresql://fixture:secret@unused.invalid/fixture' });
});

afterEach(async () => {
  await store.close();
  vi.restoreAllMocks();
});

describe('PostgreSQL connection recovery', () => {
  it('discards a failed idle connection without crashing and opens a fresh connection', async () => {
    await sql`select 1 as value`.execute(store.db);
    expect(pool.idleCount).toBe(1);
    const first = NetworkClient.clients[0];
    const loss = new Error('Connection terminated unexpectedly: postgresql://fixture:private-password@private-host/db');
    expect(() => first.disconnect(loss)).not.toThrow();
    expect(pool.totalCount).toBe(0);
    expect(first._ending).toBe(true);
    expect((await sql`select 1 as value`.execute(store.db)).rows).toEqual([{ value: 1 }]);
    expect(NetworkClient.clients).toHaveLength(2);
    expect(console.error).toHaveBeenCalledTimes(1);
    const diagnostic = JSON.stringify(vi.mocked(console.error).mock.calls);
    expect(diagnostic).toContain('PostgreSQL');
    expect(diagnostic).not.toMatch(/private-password|private-host|postgresql:\/\//);
  });

  it('preserves an active query failure without retrying it, then recovers for the next request', async () => {
    const operation = sql.raw('select wait_for_connection_loss()').execute(store.db);
    const loss = new Error('Connection terminated unexpectedly');
    const failedOperation = expect(operation).rejects.toBe(loss);
    await vi.waitFor(() => expect(NetworkClient.clients[0]?.pendingReject).toBeDefined());
    const first = NetworkClient.clients[0];
    try {
      expect(() => first.disconnect(loss)).not.toThrow();
    } finally { await failedOperation; }
    expect(first.queries).toEqual(['select wait_for_connection_loss()']);
    expect(pool.totalCount).toBe(0);
    expect(console.error).toHaveBeenCalledTimes(1);
    expect((await sql`select 1 as value`.execute(store.db)).rows).toEqual([{ value: 1 }]);
    expect(NetworkClient.clients).toHaveLength(2);
  });

  it('handles loss between queries while a client is checked out', async () => {
    await sql`select 1 as value`.execute(store.db);
    const reserved = await pool.connect();
    expect(pool.idleCount).toBe(0);
    try {
      expect(() => NetworkClient.clients[0].disconnect(new Error('Connection terminated unexpectedly'))).not.toThrow();
    } finally { reserved.release(); }
    expect(pool.totalCount).toBe(0);
    expect(console.error).toHaveBeenCalledTimes(1);
    expect((await sql`select 1 as value`.execute(store.db)).rows).toEqual([{ value: 1 }]);
  });
});
