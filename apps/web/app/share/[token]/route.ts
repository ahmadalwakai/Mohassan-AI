import { createHash } from "node:crypto";
import { ConversationShareTokenSchema, PublicConversationShareSchema, type PublicConversationShare } from "@mohassan/contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const stylesheet = `
:root{color-scheme:light dark;font:100%/1.85 system-ui,Tahoma,Arial,sans-serif;background:#faf9f6;color:#22201c}
body{margin:0}
main,footer{width:min(46rem,calc(100% - 2rem));margin-inline:auto;overflow-wrap:anywhere}
main{padding-block:2rem 1rem}
h1{font-size:clamp(1.4rem,4vw,2.2rem);line-height:1.5;margin:0 0 1.5rem}
article{border-block-start:1px solid #dcd7cb;padding-block:1rem}
article header{display:flex;align-items:baseline;flex-wrap:wrap;gap:.4rem 1rem}
h2{font-size:1rem;margin:0}
time,footer{color:#605b52;font-size:.875rem}
.message{white-space:pre-wrap;margin:.5rem 0}
ul{margin:.25rem 0 0}
a{color:#16634f}
footer{border-block-start:1px solid #dcd7cb;padding-block:1rem 2rem}
@media(prefers-color-scheme:dark){
  :root{background:#1e1d1b;color:#edebe5}
  article,footer{border-color:#45413a}
  time,footer{color:#c1baad}
  a{color:#7bd7bb}
}
`;
// CSP Level 3 hashes the UTF-8 inline style content (retrieved 2026-11-25).
// https://www.w3.org/TR/CSP3/#does-element-match-source-list-for-type-and-source
const styleHash = createHash("sha256").update(stylesheet).digest("base64");
const headers = {
  "Content-Type": "text/html; charset=utf-8",
  "Content-Security-Policy": `default-src 'none'; style-src 'sha256-${styleHash}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  "X-Robots-Tag": "noindex, nofollow",
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
};
const date = new Intl.DateTimeFormat("ar", { calendar: "gregory", dateStyle: "medium", timeZone: "UTC" });
const dateTime = new Intl.DateTimeFormat("ar", { calendar: "gregory", dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });
const entities: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escape = (text: string) => text.replace(/[&<>"']/g, character => entities[character]);

function safeSourceUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

function html(title: string, body: string, status: number): Response {
  return new Response(`<!doctype html>
<html lang="ar" dir="rtl">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title><style>${stylesheet}</style></head>
<body>${body}</body>
</html>`, { status, headers });
}

function unavailable(status = 404): Response {
  const title = status === 404 ? "رابط المشاركة غير متاح" : "تعذر تحميل المشاركة";
  return html(title, `<main><h1>${title}</h1></main>`, status);
}

function conversation({ snapshot, sharedAt }: PublicConversationShare): Response {
  const messages = snapshot.messages.map(message => {
    const sources = message.sources.flatMap(source => {
      const href = safeSourceUrl(source.url);
      return href ? [`<li><a dir="auto" href="${escape(href)}" rel="noreferrer noopener">${escape(source.title)}</a></li>`] : [];
    });
    return `<article>
<header><h2>${message.role === "user" ? "المستخدم" : "موحسن"}</h2><time datetime="${escape(message.createdAt)}">${dateTime.format(new Date(message.createdAt))}</time></header>
<p class="message" dir="auto">${escape(message.text)}</p>
${sources.length ? `<div>المصادر<ul>${sources.join("")}</ul></div>` : ""}
</article>`;
  });
  return html(snapshot.title, `<main><h1 dir="auto">${escape(snapshot.title)}</h1>${messages.join("")}</main>
<footer>مشاركة من موحسن · <time datetime="${escape(sharedAt)}">${date.format(new Date(sharedAt))}</time></footer>`, 200);
}

export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }): Promise<Response> {
  const { token } = await params;
  if (!ConversationShareTokenSchema.safeParse(token).success) return unavailable();
  const secret = process.env.INTERNAL_API_SECRET;
  if (!secret) return unavailable(503);
  try {
    // The public request carries capability access only. Browser cookies stay at the web origin.
    const target = new URL(`/api/chat/conversation-shares/public/${token}`, process.env.MOHASSAN_SERVER_URL || "http://127.0.0.1:4000");
    const response = await fetch(target, {
      headers: { "x-mohassan-internal": secret },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]),
    });
    if (response.status === 404) return unavailable();
    if (!response.ok) return unavailable(503);
    return conversation(PublicConversationShareSchema.parse(await response.json()));
  } catch {
    return unavailable(503);
  }
}
