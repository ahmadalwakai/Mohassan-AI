"use client";

import { useEffect, useState } from "react";
import { BrowserPremiumTargetSchema, type BrowserLiveSnapshot, type BrowserPremiumTarget } from "@mohassan/contracts";
import { BrowserLiveView } from "../../components/browser-premium-view";
import { BrowserPremiumBrief } from "../../components/browser-premium-brief";

const id = "00000000-0000-4000-8000-000000000001";
const at = "2026-11-25T00:00:00Z";
const domain = "accounts.example.test";

const steps = ["opening", "loading", "reading", "typing", "handover", "resumed", "done"] as const;
const handovers = {
  login: { kind: "login", code: "needs_login", prompt: "أدخل بريدك الإلكتروني وكلمة المرور في نافذة تسجيل الدخول." },
  code: { kind: "code", code: "needs_code", prompt: "أدخل رمز التحقق المرسل إلى هاتفك." },
  hands: { kind: "hands_on", code: "hands_on", prompt: "أكمل التحقق المطلوب على الصفحة." },
} as const;

function makeSnapshot(state: string, target: BrowserPremiumTarget | undefined): BrowserLiveSnapshot {
  const handover = handovers[state as keyof typeof handovers];
  const approval = state === "approval";
  const waiting = Boolean(handover) || approval;
  const through = waiting ? "handover" : steps.find(step => step === state) ?? "reading";
  return {
    conversationId: id,
    runId: "00000000-0000-4000-8000-000000000002",
    status: handover ? "waiting_input" : approval ? "waiting_approval" : state === "done" ? "idle" : state === "failed" ? "failed" : "running",
    title: "بوابة الحساب",
    caption: "قراءة الصفحة",
    visibility: {
      version: 1,
      level: waiting ? 3 : 2,
      code: handover?.code ?? (approval ? "needs_approval" : "browser_started"),
      reason: "متابعة مهمة المتصفح",
      lang: "ar",
      decidedAt: at,
      requested: 2,
      canView: true,
      history: [],
    },
    secure: handover ? { id, kind: handover.kind, site: domain, prompt: handover.prompt, note: null, fields: [] } : null,
    approval: approval ? { id, prompt: "هل تريد إرسال الطلب؟", detail: "سيرسل الموقع الطلب المكتمل." } : null,
    premium: {
      site: { domain, favicon: "/browser-premium-favicon.png" },
      target: target ?? (handover ? { x: .25, y: .355, width: .5, height: .24 } : undefined),
      steps: steps.slice(0, steps.indexOf(through) + 1).map((kind, index) => ({ id: String(index), kind })),
    },
  };
}

export default function BrowserPremiumFixture() {
  const [scenario, setScenario] = useState<{ state: string; mini: boolean; target?: BrowserPremiumTarget } | null>(null);
  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    const mode = query.get("size") ?? "small";
    const mini = query.get("mini") === "1";
    const app = mini ? "desktop" : "web";
    document.documentElement.dir = query.get("dir") ?? "rtl";
    localStorage.setItem(`mohassan-browser-live-view:v1:${app}`, JSON.stringify({ corner: "bottom-right", size: mode }));
    const target = BrowserPremiumTargetSchema.safeParse(JSON.parse(query.get("target") ?? "null"));
    setScenario({ state: query.get("state") ?? "reading", mini, target: target.data });
  }, []);

  const [briefDismissed, dismissBrief] = useState(false);
  if (!scenario) return null;
  const isBrief = scenario.state === "brief" || scenario.state === "brief-read";
  return <main aria-label="اختبار واجهة المتصفح" style={{ padding: 16, maxWidth: 520, marginInline: "auto" }}>
    {isBrief && !briefDismissed ? <BrowserPremiumBrief brief={{
      summary: "فتح بوابة الحساب وقراءة تفاصيل الطلب.",
      sites: [domain],
      needs: scenario.state === "brief" ? ["login", "code", "approval"] : [],
      requiresStart: scenario.state === "brief",
    }} onStart={() => dismissBrief(true)} onCancel={() => dismissBrief(true)} /> : null}
    {!isBrief || briefDismissed ? <BrowserLiveView snapshot={makeSnapshot(isBrief ? "reading" : scenario.state, scenario.target)}
      app={scenario.mini ? "desktop" : "web"} desktopMini={scenario.mini} onAttentionFinished={() => {}} /> : null}
  </main>;
}
