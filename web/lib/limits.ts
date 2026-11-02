import { neon } from "@neondatabase/serverless";
import { Fault } from "./security";

let localWindow = { start: 0, attempts: 0 };
export async function limitPairing(now = Date.now()): Promise<void> {
  let attempts: number;
  if (process.env.WASLA_TRANSPORT === "relay") {
    if (!process.env.DATABASE_URL || !process.env.WASLA_RELAY_INSTALLATION_ID) throw new Fault("not_configured", "الاتصال الخارجي غير مهيأ.", 503);
    const rows = await neon(process.env.DATABASE_URL).query(`INSERT INTO wasla_pair_windows(installation_id,window_start,attempts)
      VALUES ($1,now(),1) ON CONFLICT(installation_id) DO UPDATE SET
      attempts=CASE WHEN wasla_pair_windows.window_start < now()-interval '1 minute' THEN 1 ELSE LEAST(wasla_pair_windows.attempts+1,10000) END,
      window_start=CASE WHEN wasla_pair_windows.window_start < now()-interval '1 minute' THEN now() ELSE wasla_pair_windows.window_start END RETURNING attempts`, [process.env.WASLA_RELAY_INSTALLATION_ID]);
    attempts = rows[0].attempts;
  } else {
    if (now - localWindow.start >= 60_000) localWindow = { start: now, attempts: 0 };
    attempts = ++localWindow.attempts;
  }
  // Installation-wide limit cannot be evaded by spoofing forwarded IP headers.
  if (attempts > 10) throw new Fault("pair_rate_limited", "محاولات ربط كثيرة. انتظر دقيقة قبل المحاولة مجددًا.", 429);
}
