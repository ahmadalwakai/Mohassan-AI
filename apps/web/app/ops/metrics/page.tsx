import { headers } from "next/headers";
import { ProductionMetrics } from "./production-metrics";
import { metricsPath, requestMetrics } from "./metrics-data";

export default async function ProductionMetricsPage() {
  // Use the same internal Fastify connection and cookie as the API proxy.
  const secret = process.env.INTERNAL_API_SECRET;
  const cookie = (await headers()).get("cookie");
  const state = secret
    ? await requestMetrics(new URL(metricsPath, process.env.MOHASSAN_SERVER_URL || "http://127.0.0.1:4000"), {
      headers: { "x-mohassan-internal": secret, cookie: cookie ?? "" },
      signal: AbortSignal.timeout(15_000),
    })
    : { kind: "error" as const };
  return <ProductionMetrics initialState={state} />;
}
