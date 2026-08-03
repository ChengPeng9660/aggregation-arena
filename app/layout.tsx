import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host =
    requestHeaders.get("x-forwarded-host") ??
    requestHeaders.get("host") ??
    "aggregation-arena.openai.site";
  const protocol =
    requestHeaders.get("x-forwarded-proto") ??
    (host.startsWith("localhost") || host.startsWith("127.0.0.1") ? "http" : "https");
  const socialImage = `${protocol}://${host}/og.png`;

  return {
    title: "Aggregation Arena — Forecast Benchmark",
    description: "A live, auditable benchmark for probability aggregation methods.",
    openGraph: {
      title: "Aggregation Arena",
      description: "Live Forecast Aggregation Benchmark",
      type: "website",
      images: [{ url: socialImage, width: 1200, height: 630, alt: "Aggregation Arena" }],
    },
    twitter: {
      card: "summary_large_image",
      title: "Aggregation Arena",
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
