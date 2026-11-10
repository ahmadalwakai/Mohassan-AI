/**
 * A Google Ads sign-in started from the chat leaves the app for Google's page.
 * This note, kept for the tab only, tells the app which question to answer on return.
 */
const KEY = "mohassan-ads-connect";

export interface PendingAdsConnect { conversationId: string; questionId: string }

export const pendingAdsConnect = {
  peek(): PendingAdsConnect | null {
    try {
      const value = JSON.parse(sessionStorage.getItem(KEY) ?? "null") as Partial<PendingAdsConnect> | null;
      return value && typeof value.conversationId === "string" && typeof value.questionId === "string" ? { conversationId: value.conversationId, questionId: value.questionId } : null;
    } catch { return null; }
  },
  set(value: PendingAdsConnect) { try { sessionStorage.setItem(KEY, JSON.stringify(value)); } catch { /* The manual «تم تسجيل الدخول» button still works. */ } },
  take(): PendingAdsConnect | null {
    const value = this.peek();
    try { sessionStorage.removeItem(KEY); } catch { /* Nothing to clear. */ }
    return value;
  },
};

export const adsConnectProblems: Record<string, string> = {
  denied: "لم تكتمل الموافقة في Google. اضغط «تسجيل الدخول إلى Google» للمحاولة مجددًا.",
  failed: "تعذر إكمال الربط مع Google. حاول مجددًا.",
  signin: "انتهت جلستك هنا. سجّل الدخول ثم أعد المحاولة.",
};
