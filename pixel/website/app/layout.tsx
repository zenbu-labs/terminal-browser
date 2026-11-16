import type { Metadata } from "next";
import { JetBrains_Mono } from "next/font/google";
import { Analytics } from "@vercel/analytics/next";
import "./globals.css";

const mono = JetBrains_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
  weight: ["400", "600"],
  adjustFontFallback: false,
});

const DESCRIPTION = "Build graphical applications in the terminal";

export const metadata: Metadata = {
  metadataBase: new URL("https://pixelgui.com"),
  title: "pixelgui",
  description: DESCRIPTION,
  openGraph: {
    title: "pixelgui",
    description: DESCRIPTION,
    url: "/",
    siteName: "pixelgui",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "pixelgui",
    description: DESCRIPTION,
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={mono.variable}>
      <body>
        {children}
        <Analytics />
      </body>
    </html>
  );
}
