import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { Fault, boundedJSON, keyFrom, packSession, requireSameOrigin, unpackSession } from "@/lib/security";
import { configured, upstream } from "@/lib/upstream";
import { completeWorker, pollWorker, requireWorker } from "@/lib/relay";
import { limitPairing } from "@/lib/limits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;
const cookieName = "wasla_session";
const message = z.object({ role: z.enum(["user", "assistant"]), content: z.string().min(1).refine((value) => [...value].length <= 8000) }).strict();
const chatSchema = z.object({
  messages: z.array(message).min(1).max(16).refine((items) => items.at(-1)?.role === "user" && items.reduce((n, item) => n + [...item.content].length, 0) <= 24_000),
  mode: z.enum(["auto", "live_web", "local"]).default("auto"), request_id: z.uuid(),
  remember: z.boolean().default(false), use_memory: z.boolean().default(false), allow_cloud: z.boolean().default(false), conversation_id: z.uuid().optional(),
}).strict();
type Context = { params: Promise<{ route: string[] }> };
function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" } });
}
function clear(response: NextResponse) { response.cookies.set(cookieName, "", { httpOnly: true, sameSite: "strict", secure: process.env.NODE_ENV === "production", path: "/api", maxAge: 0 }); }
function translateStatus(body: Record<string, unknown>) {
  const caps = Array.isArray(body.capabilities) ? body.capabilities : [];
  return { configured: true, paired: true, name: body.name, model: body.model, busy: body.busy,
    capabilities: { local: caps.includes("local"), live_web: caps.includes("live_web"), knowledge: caps.includes("knowledge"), memory: caps.includes("memory") },
    app_actions_enabled: body.app_actions_enabled === true, cloud_configured: body.cloud_configured === true, storage: body.storage || "sqlite" };
}
async function handle(request: NextRequest, context: Context) {
  try {
    const route = (await context.params).route.join("/");
    const method = request.method;
    if (route.startsWith("relay/")) {
      if (method !== "POST" || request.nextUrl.search) throw new Fault("invalid_route", "مسار غير صالح.", 404);
      requireWorker(request);
      const data = await boundedJSON(request, route === "relay/result" ? 1_500_000 : 65_536);
      if (route === "relay/poll") return json(await pollWorker(data));
      if (route === "relay/result") return json(await completeWorker(data));
      throw new Fault("invalid_route", "مسار غير صالح.", 404);
    }
    if (method !== "GET") requireSameOrigin(request);
    if (request.nextUrl.search && !["knowledge", "conversations"].includes(route)) throw new Fault("invalid_query", "معاملات غير مدعومة.");
    if (route === "status" && method === "GET" && !configured()) return json({ configured: false, paired: false });
    if (!configured()) throw new Fault("not_configured", "لم يكتمل إعداد اتصال الواجهة بالكمبيوتر.", 503);
    const sessionKey = keyFrom(process.env.WASLA_SESSION_KEY);
    if (route === "pair" && method === "POST") {
      const data = z.object({ code: z.string().regex(/^\d{8}$/) }).strict().parse(await boundedJSON(request));
      await limitPairing();
      const result = await upstream({ method: "POST", path: "/v1/pair", body: { ...data, device_name: "Wasla Web" } });
      if (result.status !== 200) return json(result.body, result.status);
      const paired = z.object({ token: z.string().min(16).max(512), device_id: z.string().min(1).max(128), name: z.string() }).parse(result.body);
      const response = json({ paired: true, name: paired.name });
      response.cookies.set(cookieName, packSession({ token: paired.token, device_id: paired.device_id, exp: Date.now() + 30 * 86400_000 }, sessionKey), {
        httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "strict", path: "/api", maxAge: 30 * 86400,
      });
      return response;
    }
    const session = unpackSession(request.cookies.get(cookieName)?.value, sessionKey);
    if (!session) {
      if (route === "status" && method === "GET") return json({ configured: true, paired: false });
      throw new Fault("unauthorized", "اربط الكمبيوتر أولًا.", 401);
    }
    let path = `/v1/${route}`; let body: unknown;
    if (route === "chat" && method === "POST") body = chatSchema.parse(await boundedJSON(request));
    else if (route === "knowledge" || route === "conversations") {
      const keys = Array.from(request.nextUrl.searchParams.keys());
      if (keys.some((key) => key !== "id") || keys.length > 1) throw new Fault("invalid_query", "معاملات غير مدعومة.");
      const id = request.nextUrl.searchParams.get("id");
      if (id) path += `/${z.uuid().parse(id).toLowerCase()}`;
      if (route === "knowledge" && method === "POST" && !id) body = z.object({ title: z.string().trim().min(1).max(160), content: z.string().trim().min(1).max(20_000) }).strict().parse(await boundedJSON(request));
      else if (!(method === "GET" || method === "DELETE" && id)) throw new Fault("invalid_route", "عملية غير مدعومة.", 405);
    } else if (route === "settings" && method === "PATCH") body = z.object({ memory_enabled: z.boolean() }).strict().parse(await boundedJSON(request));
    else if (!(["status", "settings", "metrics"].includes(route) && method === "GET") && !(route === "session" && method === "DELETE")) throw new Fault("not_found", "عملية غير مدعومة.", 404);
    const result = await upstream({ method, path, body, authorization: `Bearer ${session.token}` });
    const response = json(route === "status" && result.status === 200 ? translateStatus(result.body) : result.body, result.status);
    if (result.status === 401 || route === "session" && result.status === 200) clear(response);
    return response;
  } catch (error) {
    if (error instanceof Fault) return json({ error: { code: error.code, message: error.message } }, error.status);
    if (error instanceof z.ZodError) return json({ error: { code: "invalid_request", message: "راجع بيانات الطلب وحدود طول الرسالة." } }, 400);
    // Never include upstream exception text: it can contain connection strings.
    return json({ error: { code: "service_unavailable", message: "تعذّر إكمال العملية. راجع إعداد وصلة على الكمبيوتر." } }, 503);
  }
}
export { handle as GET, handle as POST, handle as PATCH, handle as DELETE };
