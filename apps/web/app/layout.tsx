import type { Metadata } from "next";
import { IBM_Plex_Sans_Arabic } from "next/font/google";
import { Providers } from "../components/providers";
import "./globals.css";

/** The chat screen's typeface. Other screens keep their own font through globals.css. */
const chatFont = IBM_Plex_Sans_Arabic({ subsets: ["arabic", "latin"], weight: ["400", "500", "600", "700"], variable: "--font-chat", display: "swap" });

export const metadata: Metadata = {
  title: "محسّن",
  description: "مساعدك الذكي",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ar" dir="rtl" className={chatFont.variable}><body><Providers>{children}</Providers></body></html>;
}
