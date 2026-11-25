import { sql, type Kysely } from 'kysely';
import { nextMonitorBudgetDay } from '../schedule.js';

// Five renders an hour averaged across the UTC day. Each render can read at
// most four regions, so both browser work and OCR work have a daily ceiling.
export const MONITOR_VISUAL_DAILY_LIMIT = 5 * 24;

export async function reserveMonitorVisualRead(db: Kysely<any>, at: number): Promise<number | null> {
  const instant = new Date(at);
  const day = instant.toISOString().slice(0, 10);
  const { rows } = await sql`INSERT INTO smart_monitor_visual_budget (budget_key, budget_day, attempts)
    VALUES ('visual', ${day}::date, 1)
    ON CONFLICT (budget_key) DO UPDATE SET budget_day = EXCLUDED.budget_day,
      attempts = CASE WHEN smart_monitor_visual_budget.budget_day < EXCLUDED.budget_day THEN 1
                      ELSE smart_monitor_visual_budget.attempts + 1 END
    WHERE smart_monitor_visual_budget.budget_day < EXCLUDED.budget_day OR
      (smart_monitor_visual_budget.budget_day = EXCLUDED.budget_day
        AND smart_monitor_visual_budget.attempts < ${MONITOR_VISUAL_DAILY_LIMIT})
    RETURNING budget_key`.execute(db);
  return rows.length ? null : nextMonitorBudgetDay(instant).getTime();
}
