import type { Metadata } from "next";
import { TrainingMonitor } from "./monitor";

export const metadata: Metadata = { title: "مراقبة التدريب | موحسن" };

export default function TrainingMonitorPage() {
  return <TrainingMonitor />;
}
