"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { browserPremiumBriefPath, BrowserPremiumBriefSchema, type BrowserPremiumBriefData } from "@mohassan/contracts";
import { BrowserPremiumBrief } from "./browser-premium-brief";
import styles from "./browser-premium-preflight.module.css";
import theme from "./browser-premium-tokens.module.css";

const previewDurationMs = 2_500;

function pageOrigin(url: string | undefined) {
  if (!url) return undefined;
  try {
    const address = new URL(url);
    return ["http:", "https:"].includes(address.protocol) ? address.origin : undefined;
  } catch { return undefined; }
}

function BriefDialog({ brief, finish }: { brief: BrowserPremiumBriefData; finish: (start: boolean) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    element.showModal();
    return () => element.close();
  }, []);

  useEffect(() => {
    if (brief.requiresStart) return;
    const timer = window.setTimeout(() => finish(true), previewDurationMs);
    return () => window.clearTimeout(timer);
  }, [brief, finish]);

  return <dialog ref={dialog} aria-label="موجز مهمة المتصفح" className={`${theme.theme} ${styles.dialog}`}
    onCancel={(event) => { event.preventDefault(); finish(false); }}>
    <BrowserPremiumBrief brief={brief} onStart={() => finish(true)} onCancel={() => finish(false)} />
  </dialog>;
}

type Context = { text: string; active: boolean; conversationId: string | null; pageUrl?: string; inputKey: string };
type Review = { abort: AbortController; key: string; resolve?: (start: boolean) => void };

export function useBrowserPremiumBrief({ text, active, conversationId, pageUrl, inputKey }: Context, onError: (message: string) => void) {
  const key = JSON.stringify([text, conversationId, inputKey]);
  const latest = useRef({ key, active });
  latest.current = { key, active };
  const review = useRef<Review | null>(null);
  const [brief, setBrief] = useState<BrowserPremiumBriefData | null>(null);

  const finish = useCallback((start: boolean) => {
    review.current?.resolve?.(start);
    setBrief(null);
  }, []);

  useEffect(() => {
    const request = review.current;
    if (request && (!active || request.key !== key)) {
      request.abort.abort();
      finish(false);
    }
  }, [active, finish, key]);

  useEffect(() => () => {
    review.current?.abort.abort();
    review.current?.resolve?.(false);
  }, []);

  async function beforeSend() {
    if (!active || !text.trim()) return true;
    if (review.current) return false;
    const request: Review = { abort: new AbortController(), key };
    review.current = request;
    const isCurrent = () => !request.abort.signal.aborted && latest.current.active && latest.current.key === key;
    try {
      const response = await fetch(browserPremiumBriefPath, {
        method: "POST", credentials: "same-origin", cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, currentOrigin: pageOrigin(pageUrl) }),
        signal: AbortSignal.any([request.abort.signal, AbortSignal.timeout(5_000)]),
      });
      if (response.status === 404) return isCurrent();
      if (!response.ok) throw new Error("Browser brief unavailable");
      const next = BrowserPremiumBriefSchema.nullable().parse(await response.json());
      if (!isCurrent() || !next) return isCurrent();
      const allowed = await new Promise<boolean>((resolve) => {
        request.resolve = resolve;
        setBrief(next);
      });
      return allowed && isCurrent();
    } catch {
      if (isCurrent()) onError("تعذّر تجهيز موجز المتصفح. حاول إرسال طلبك مجددًا.");
      return false;
    } finally {
      if (review.current === request) review.current = null;
    }
  }

  return { beforeSend, dialog: brief ? <BriefDialog brief={brief} finish={finish} /> : null };
}
