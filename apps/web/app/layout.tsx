import type { Metadata } from "next";
import { Alexandria } from "next/font/google";
import { Providers } from "../components/providers";
import "./globals.css";

/**
 * The chat screen's typeface: Alexandria, the owner's choice on 2026-11-23 (IBM Plex Sans Arabic before). A variable font, so
 * one file per subset carries every weight the chat uses (400 to 700). Other screens keep their own font through globals.css.
 */
const chatFont = Alexandria({ subsets: ["arabic", "latin"], variable: "--font-chat", display: "swap" });

export const metadata: Metadata = {
  title: "موحسن",
  description: "مساعدك الذكي",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ar" dir="rtl" className={chatFont.variable}><body><Providers>{children}</Providers></body></html>;
}
