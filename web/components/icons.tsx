type IconName = "chat" | "plus" | "book" | "history" | "activity" | "arrow" | "globe" | "spark" | "computer" | "link" | "external" | "refresh" | "shield" | "trash" | "check" | "stop" | "copy";
const paths: Record<IconName, string> = {
  chat: "M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z",
  plus: "M12 5v14M5 12h14",
  book: "M4 3h6a4 4 0 0 1 4 4v14a4 4 0 0 0-4-4H4V3Zm16 0h-2a4 4 0 0 0-4 4m0 14a4 4 0 0 1 4-4h2V3",
  history: "M3 11a9 9 0 1 1 2.3 6M3 4v7h7m2-4v5l3 2",
  activity: "M3 12h4l3-8 4 16 3-8h4",
  arrow: "M12 19V5m-6 6 6-6 6 6",
  globe: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM3 12h18M12 3c3 3.5 3 14.5 0 18-3-3.5-3-14.5 0-18Z",
  spark: "m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z",
  computer: "M4 4h16v12H4V4Zm4 16h8m-4-4v4",
  link: "m10 13 4-4m-7 8-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m4-1 1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0",
  external: "M14 3h7v7m0-7-9 9M10 4H4v16h16v-6",
  refresh: "M20 8a9 9 0 0 0-15-3L2 8m0-6v6h6m-4 8a9 9 0 0 0 15 3l3-3m0 6v-6h-6",
  shield: "M12 3 3 7v5c0 5 9 9 9 9s9-4 9-9V7l-9-4Zm-4 9 3 3 5-6",
  trash: "M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7",
  check: "m5 12 4 4L19 6",
  stop: "M6 6h12v12H6V6Z",
  copy: "M8 8h12v12H8V8ZM4 16H2V2h14v2",
};
export function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}
