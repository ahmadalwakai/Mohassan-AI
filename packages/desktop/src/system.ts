import { arch, cpus, freemem, hostname, platform, release, totalmem, uptime, userInfo, type } from 'node:os';
import { powerShellJson } from './shell.ts';

export interface DiskInfo { drive: string; label: string; totalBytes: number; freeBytes: number }
export interface SystemInfo {
  hostname: string; user: string; os: string; release: string; arch: string;
  cpu: { model: string; cores: number }; memory: { totalBytes: number; freeBytes: number };
  uptimeSeconds: number; disks: DiskInfo[]; battery: { percent: number; charging: boolean | null } | null; gpus: string[];
  collectedAt: string;
}

interface Raw { disks?: { DeviceID: string; VolumeName: string | null; Size: number | string | null; FreeSpace: number | string | null }[] | { DeviceID: string; VolumeName: string | null; Size: number | string | null; FreeSpace: number | string | null } | null; battery?: { EstimatedChargeRemaining: number; BatteryStatus: number } | { EstimatedChargeRemaining: number; BatteryStatus: number }[] | null; gpus?: { Name: string }[] | { Name: string } | null }

const SCRIPT = `$d = Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | Select-Object DeviceID,VolumeName,Size,FreeSpace
$b = Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue | Select-Object EstimatedChargeRemaining,BatteryStatus
$g = Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue | Select-Object Name
@{ disks = @($d); battery = $b; gpus = @($g) } | ConvertTo-Json -Compress -Depth 4`;

const list = <T>(value: T | T[] | null | undefined): T[] => (Array.isArray(value) ? value : value ? [value] : []);
let cache: { at: number; value: SystemInfo } | null = null;

/** Hardware and OS facts from Node and one CIM query; cached for 20 seconds. */
export async function systemInfo(cwd: string): Promise<SystemInfo> {
  if (cache && Date.now() - cache.at < 20_000) return cache.value;
  let raw: Raw = {};
  if (process.platform === 'win32') {
    try { raw = await powerShellJson<Raw>(SCRIPT, { cwd, timeoutMs: 30_000 }); } catch { raw = {}; }
  }
  const battery = list(raw.battery)[0];
  const value: SystemInfo = {
    hostname: hostname(), user: userInfo().username, os: type() === 'Windows_NT' ? 'Windows' : type(), release: release(), arch: arch(),
    cpu: { model: cpus()[0]?.model.trim() ?? 'unknown', cores: cpus().length }, memory: { totalBytes: totalmem(), freeBytes: freemem() }, uptimeSeconds: Math.round(uptime()),
    disks: list(raw.disks).map(disk => ({ drive: disk.DeviceID, label: disk.VolumeName ?? '', totalBytes: Number(disk.Size ?? 0), freeBytes: Number(disk.FreeSpace ?? 0) })),
    battery: battery ? { percent: Number(battery.EstimatedChargeRemaining), charging: battery.BatteryStatus === 2 ? true : battery.BatteryStatus === 1 ? false : null } : null,
    gpus: list(raw.gpus).map(gpu => gpu.Name).filter(Boolean), collectedAt: new Date().toISOString(),
  };
  void platform;
  cache = { at: Date.now(), value };
  return value;
}

export const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** index).toFixed(index >= 3 ? 1 : 0)} ${units[index]}`;
};
