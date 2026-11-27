import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CodingDeviceListSchema, CodingDevicePairingSchema, CodingWorkspaceSchema } from '@mohassan/contracts';

describe('owner coding device contracts', () => {
  const sandbox = { available: false, provider: null, message: 'لم يثبت توفر بيئة عزل.' };
  const device = { id: randomUUID(), name: 'جهاز الاختبار', online: false, lastSeenAt: null, sandbox };

  it('accepts existing workspace snapshots and distinguishes an absent device', () => {
    const snapshot = { projects: [], sandbox };
    expect(CodingWorkspaceSchema.parse(snapshot)).toEqual(snapshot);
    expect(CodingWorkspaceSchema.parse({ ...snapshot, device: null }).device).toBeNull();
    expect(CodingWorkspaceSchema.parse({ ...snapshot, device }).device).toEqual(device);
  });

  it('allows at most one active device and rejects credentials in owner responses', () => {
    expect(CodingDeviceListSchema.parse({ enabled: true, devices: [device] }).devices).toEqual([device]);
    expect(CodingDeviceListSchema.parse({ enabled: false, devices: [] }).devices).toEqual([]);
    expect(CodingDeviceListSchema.safeParse({ enabled: true, devices: [device, { ...device, id: randomUUID() }] }).success).toBe(false);
    expect(CodingDeviceListSchema.safeParse({ enabled: true, devices: [{ ...device, deviceKey: randomBytes(32).toString('base64url') }] }).success).toBe(false);
  });

  it('validates the one-time code and its expiry', () => {
    const pairing = { code: randomBytes(12).toString('base64url'), expiresAt: new Date(Date.now() + 120_000).toISOString() };
    expect(CodingDevicePairingSchema.parse(pairing)).toEqual(pairing);
    expect(CodingDevicePairingSchema.safeParse({ ...pairing, code: `${pairing.code}_` }).success).toBe(false);
    expect(CodingDevicePairingSchema.safeParse({ ...pairing, expiresAt: 'tomorrow' }).success).toBe(false);
  });
});
