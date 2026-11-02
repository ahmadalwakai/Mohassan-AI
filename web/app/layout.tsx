import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { Providers } from "./providers";
import "./globals.css";

export const metadata: Metadata = {
  title: "وصلة — Wasla Hybrid AI",
  description: "محادثة مع مساعدك المحلي، بحث بمصادر، ومعرفة تحفظها باختيارك.",
  icons: { icon: "/connect.png", apple: "/connect.png" },
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#143d30" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="ar" dir="rtl"><body><Providers>{children}</Providers></body></html>;
}
