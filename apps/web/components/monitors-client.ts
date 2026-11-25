import type { MonitorCard } from "@mohassan/contracts";

const endpoint = "/api/chat/monitors";
const changed = new EventTarget();

export type MonitorAction = "approve" | "pause" | "resume" | "stop";

async function request<T>(path: string, options: RequestInit, fallback: string): Promise<T> {
  const response = await fetch(path, { ...options, credentials: "same-origin", cache: "no-store" });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body) throw new Error(body?.error?.message ?? fallback);
  return body as T;
}

export async function listMonitors(signal: AbortSignal, fallback: string, conversationId?: string): Promise<MonitorCard[]> {
  const query = conversationId ? `?${new URLSearchParams({ conversationId })}` : "";
  const result = await request<{ monitors: MonitorCard[] }>(`${endpoint}${query}`, { signal }, fallback);
  return result.monitors;
}

export async function changeMonitor(id: string, action: MonitorAction, fallback: string): Promise<MonitorCard> {
  const path = action === "approve" ? endpoint : `${endpoint}/${encodeURIComponent(id)}/${action}`;
  const updated = await request<MonitorCard>(path, {
    method: "POST",
    ...(action === "approve" ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ proposalId: id }) } : {}),
  }, fallback);
  changed.dispatchEvent(new CustomEvent<MonitorCard>("updated", { detail: updated }));
  return updated;
}

export function followMonitorChanges(update: (monitor: MonitorCard) => void): () => void {
  const listener = (event: Event) => update((event as CustomEvent<MonitorCard>).detail);
  changed.addEventListener("updated", listener);
  return () => changed.removeEventListener("updated", listener);
}

export function mergeMonitors(...lists: (readonly MonitorCard[])[]): MonitorCard[] {
  const monitors = new Map<string, MonitorCard>();
  for (const list of lists) for (const monitor of list) monitors.set(monitor.id, monitor);
  return [...monitors.values()];
}
