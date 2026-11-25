import type { BrowserLiveSnapshot, BrowserPremiumStepKind } from "@mohassan/contracts";

export type BrowserPremiumStatus = "reading" | "typing" | "waiting" | "done" | "failed";

export const browserPremiumStepLabels: Record<BrowserPremiumStepKind, string> = {
  opening: "يفتح الموقع",
  reading: "يقرأ الصفحة",
  typing: "يعبّئ النموذج",
  loading: "ينتظر تحميل الصفحة",
  handover: "ينتظر إكمال خطوتك",
  resumed: "استأنف التصفح",
  done: "اكتمل التصفح",
};

export const browserPremiumStatusLabels: Record<BrowserPremiumStatus, string> = {
  reading: "يقرأ",
  typing: "يكتب",
  waiting: "بانتظارك",
  done: "اكتمل",
  failed: "توقّف",
};

export function browserPremiumNarration(snapshot: BrowserLiveSnapshot, needsUser: boolean) {
  const steps = (snapshot.premium?.steps ?? []).slice(-6);
  const last = steps.at(-1);
  const fallback = (kind: BrowserPremiumStepKind) => ({ id: `state-${kind}`, kind });
  let status: BrowserPremiumStatus = "reading";
  let current = last ?? fallback("reading");

  if (needsUser || snapshot.status === "waiting_user" || snapshot.status === "waiting_input" || snapshot.status === "waiting_approval") {
    status = "waiting";
    current = last?.kind === "handover" ? last : fallback("handover");
  } else if (snapshot.status === "failed" || snapshot.status === "cancelled") {
    status = "failed";
  } else if (snapshot.status === "idle") {
    status = "done";
    current = last?.kind === "done" ? last : fallback("done");
  } else if (last?.kind === "typing") {
    status = "typing";
  } else if (last?.kind === "handover" || last?.kind === "done") {
    current = fallback("reading");
  }

  return {
    status,
    caption: status === "failed" ? "توقّف التصفح" : browserPremiumStepLabels[current.kind],
    steps: current.id === last?.id ? steps : [...steps.slice(-5), current],
  };
}

export function browserPremiumSiteDomain(value: string | null | undefined) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") ? url.host : null;
  } catch {
    return null;
  }
}

export function browserPremiumFavicon(value: string | null | undefined) {
  if (!value) return null;
  if (value.startsWith("/") && !value.startsWith("//") && !/[\\\s]/.test(value)) return value;
  if (value.length <= 65536 && /^data:image\/(?:png|jpeg|gif|webp|x-icon|vnd\.microsoft\.icon);base64,[a-z\d+/]+={0,2}$/i.test(value)) return value;
  return null;
}
