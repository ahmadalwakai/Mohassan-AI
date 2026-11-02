import { neon } from "@neondatabase/serverless";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import { Fault, envelopeSchema, keyFrom, seal, unseal, sameSecret } from "./security";
import type { UpstreamRequest, UpstreamResponse } from "./upstream";

const responseSchema = z.object({ status: z.number().int().min(100).max(599), body: z.record(z.string(), z.unknown()) });
const installation = () => {
  const id = process.env.WASLA_RELAY_INSTALLATION_ID;
  if (!id || !/^[a-zA-Z0-9_-]{8,80}$/.test(id)) throw new Fault("relay_unconfigured", "الاتصال الخارجي غير مهيأ.", 503);
  return id;
};
function database() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Fault("relay_unconfigured", "قاعدة بيانات الاتصال الخارجي غير مهيأة.", 503);
  return neon(url);
}
function aad(direction: string, id: string) { return `wasla:${direction}:v1:${installation()}:${id}`; }
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export function requireWorker(request: Request): void {
  const token = process.env.WASLA_RELAY_TOKEN;
  if (!token || token.length < 32 || !sameSecret(request.headers.get("authorization") || "", `Bearer ${token}`)) throw new Fault("unauthorized", "غير مصرح.", 401);
}
export async function relayRequest(input: UpstreamRequest): Promise<UpstreamResponse> {
  const sql = database(); const owner = installation(); const id = randomUUID();
  const key = keyFrom(process.env.WASLA_RELAY_KEY_BASE64);
  const encrypted = seal({ ...input, expires_at: Math.floor(Date.now() / 1000) + 300 }, key, aad("request", id));
  // Encryption applies even when conversation history is off. Queue rows have a
  // five-minute expiry and are not knowledge, chat history or application logs.
  await sql.query("DELETE FROM wasla_relay_jobs WHERE installation_id=$1 AND expires_at < now()", [owner]);
  const [, inserted] = await sql.transaction([
    sql.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [owner]),
    sql.query(`INSERT INTO wasla_relay_jobs(id,installation_id,request,expires_at)
    SELECT $1,$2,$3::jsonb,now()+interval '5 minutes'
    WHERE (SELECT count(*) FROM wasla_relay_jobs WHERE installation_id=$2 AND state IN ('queued','leased')) < 24 RETURNING id`, [id, owner, JSON.stringify(encrypted)])
  ], { isolationLevel: "ReadCommitted" });
  if (!inserted.length) throw new Fault("relay_busy", "هناك طلبات اتصال كثيرة. انتظر قليلًا.", 429);
  const end = Date.now() + (input.path === "/v1/chat" ? 265_000 : 25_000);
  try {
    while (Date.now() < end) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const rows = await sql.query("SELECT state,response FROM wasla_relay_jobs WHERE id=$1 AND installation_id=$2 AND expires_at>now()", [id, owner]);
      if (!rows.length) break;
      if (rows[0].state === "done") return responseSchema.parse(unseal(rows[0].response, key, aad("response", id)));
    }
    throw new Fault("relay_timeout", "لم يصل رد الكمبيوتر. شغّل وصلة؛ لم يُعد إرسال الطلب تلقائيًا.", 504);
  } finally {
    // A leased action can still finish; deleting transport state never retries it.
    await sql.query("DELETE FROM wasla_relay_jobs WHERE id=$1 AND installation_id=$2", [id, owner]).catch(() => undefined);
  }
}
export async function pollWorker(input: unknown) {
  const data = z.object({ installation_id: z.string(), worker_id: z.string().min(1).max(128) }).strict().parse(input);
  if (data.installation_id !== installation()) throw new Fault("unauthorized", "غير مصرح.", 401);
  const lease = randomBytes(32).toString("base64url"); const sql = database();
  await sql.query("DELETE FROM wasla_relay_jobs WHERE installation_id=$1 AND expires_at < now()", [data.installation_id]);
  // Each job is leased once. Expired leases are never requeued: a request may
  // have executed even if its response was lost. The action journal is a second guard.
  const rows = await sql.query(`UPDATE wasla_relay_jobs SET state='leased',lease_hash=$2,worker_id=$3
    WHERE id=(SELECT id FROM wasla_relay_jobs WHERE installation_id=$1 AND state='queued' AND expires_at>now() ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
    RETURNING id,request`, [data.installation_id, digest(lease), data.worker_id]);
  return { job: rows.length ? { id: rows[0].id, lease_token: lease, request: rows[0].request } : null };
}
export async function completeWorker(input: unknown) {
  const data = z.object({ installation_id: z.string(), job_id: z.uuid(), lease_token: z.string().min(32).max(100), response: envelopeSchema }).strict().parse(input);
  if (data.installation_id !== installation()) throw new Fault("unauthorized", "غير مصرح.", 401);
  responseSchema.parse(unseal(data.response, keyFrom(process.env.WASLA_RELAY_KEY_BASE64), aad("response", data.job_id)));
  const rows = await database().query(`UPDATE wasla_relay_jobs SET state='done',response=$4::jsonb
    WHERE id=$1 AND installation_id=$2 AND lease_hash=$3 AND state='leased' AND expires_at>now() RETURNING id`,
    [data.job_id, data.installation_id, digest(data.lease_token), JSON.stringify(data.response)]);
  // A late or duplicate result has no side effect; no execution is rescheduled.
  return { accepted: rows.length === 1 };
}
