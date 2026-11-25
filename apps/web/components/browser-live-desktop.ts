import type { BrowserLiveCorner, BrowserLiveMode } from "@mohassan/contracts";

type DesktopBridge = {
  update(input: { corner: BrowserLiveCorner; mode: BrowserLiveMode }): Promise<void>;
  cornerAt(input: { x: number; y: number }): Promise<BrowserLiveCorner | null>;
  enabled(): Promise<boolean>;
  onEnabledChanged(listener: (enabled: boolean) => void): () => void;
};

type DesktopWindow = Window & { mohassanDesktop?: { shell?: string; browserLiveView?: DesktopBridge } };

export function browserLiveDesktop() {
  if (typeof window === "undefined") return null;
  const host = (window as DesktopWindow).mohassanDesktop;
  return host?.shell === "electron" ? (host.browserLiveView ?? null) : null;
}
