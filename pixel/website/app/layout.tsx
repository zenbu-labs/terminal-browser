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
  title: "pixel",
  description: DESCRIPTION,
  openGraph: {
    title: "Pixel",
    description: DESCRIPTION,
    url: "/",
    siteName: "Pixel",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Pixel",
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
