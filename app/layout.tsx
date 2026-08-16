import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export function generateMetadata(): Metadata {
  const socialImage = "https://www.aggrena.com/og.png";

  return {
    metadataBase: new URL("https://www.aggrena.com"),
    title: "Aggrena — Forecast Aggregation Benchmark",
    description: "A live, auditable benchmark for probability aggregation methods.",
    openGraph: {
      title: "Aggrena",
      description: "Live Forecast Aggregation Benchmark",
      url: "https://www.aggrena.com",
      siteName: "Aggrena",
      type: "website",
      images: [{ url: socialImage, width: 1200, height: 630, alt: "Aggrena" }],
    },
    twitter: {
      card: "summary_large_image",
      title: "Aggrena",
      description: "Live Forecast Aggregation Benchmark",
      images: [socialImage],
    },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className={`${geistSans.variable} ${geistMono.variable}`}>{children}</body>
    </html>
  );
}
