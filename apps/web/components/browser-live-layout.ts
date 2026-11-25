import { browserLiveCorners as corners, type BrowserLiveCorner, type BrowserLiveMode } from "@mohassan/contracts";

const labels: Record<BrowserLiveCorner, string> = {
  "top-left": "أعلى اليسار", "top-right": "أعلى اليمين",
  "bottom-left": "أسفل اليسار", "bottom-right": "أسفل اليمين",
};
export const browserLiveCorners = corners.map((value) => ({ value, label: labels[value] }));

export type BrowserLiveApp = "web" | "desktop";
export type BrowserLiveSize = Extract<BrowserLiveMode, "small" | "medium">;
export type BrowserLivePreferences = { corner: BrowserLiveCorner; size: BrowserLiveSize };

export const defaultBrowserLivePreferences: BrowserLivePreferences = { corner: "bottom-left", size: "small" };

export function browserLiveCornerAt(x: number, y: number, width: number, height: number): BrowserLiveCorner {
  const horizontal = x < width / 2 ? "left" : "right";
  const vertical = y < height / 2 ? "top" : "bottom";
  return `${vertical}-${horizontal}`;
}

export const browserLivePreferenceKey = (app: BrowserLiveApp) => `mohassan-browser-live-view:v1:${app}`;

export function readBrowserLivePreferences(storage: Pick<Storage, "getItem">, app: BrowserLiveApp): BrowserLivePreferences {
  try {
    const saved = JSON.parse(storage.getItem(browserLivePreferenceKey(app)) ?? "null");
    return {
      corner: browserLiveCorners.find(({ value }) => value === saved?.corner)?.value ?? defaultBrowserLivePreferences.corner,
      size: saved?.size === "medium" ? "medium" : "small",
    };
  } catch {
    return defaultBrowserLivePreferences;
  }
}

export function writeBrowserLivePreferences(storage: Pick<Storage, "setItem">, app: BrowserLiveApp, value: BrowserLivePreferences) {
  try { storage.setItem(browserLivePreferenceKey(app), JSON.stringify(value)); } catch { /* Preference storage may be unavailable. */ }
}

export function browserLivePresentation(scope: string, attention: boolean, size: BrowserLiveSize, override: { scope: string; mode: BrowserLiveMode } | null) {
  if (override?.scope === scope) return override.mode;
  return attention ? "medium" : size;
}
