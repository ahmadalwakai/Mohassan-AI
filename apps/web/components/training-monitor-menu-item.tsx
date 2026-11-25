"use client";

import { Activity } from "lucide-react";
import Link from "next/link";
import styles from "./training-monitor-menu-item.module.css";

const localHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function TrainingMonitorMenuItem() {
  if (typeof window === "undefined" || !localHosts.has(window.location.hostname)) return null;
  return <Link className={styles.link} href="/training-monitor" prefetch={false}>
    <Activity aria-hidden="true" size={15} />مراقبة التدريب
  </Link>;
}
