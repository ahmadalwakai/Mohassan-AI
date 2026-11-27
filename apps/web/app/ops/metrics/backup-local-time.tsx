"use client";

import { useSyncExternalStore } from "react";

const dateOptions = {
  calendar: "gregory", year: "numeric", month: "short", day: "numeric",
  hour: "numeric", minute: "2-digit", timeZoneName: "short",
} satisfies Intl.DateTimeFormatOptions;

const utc = new Intl.DateTimeFormat("ar", { ...dateOptions, timeZone: "UTC" });
const subscribe = () => () => {};

export function BackupLocalTime({ value }: { value: string }) {
  const timestamp = Date.parse(value);
  const label = useSyncExternalStore(
    subscribe,
    () => {
      const locale = navigator.languages.find(language => /^ar(?:-|$)/i.test(language)) ?? "ar";
      return new Intl.DateTimeFormat(locale, dateOptions).format(timestamp);
    },
    () => utc.format(timestamp),
  );
  return <time dateTime={value}>{label}</time>;
}
