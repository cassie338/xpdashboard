import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";

const dmSans = localFont({
  src: "./fonts/dm-sans.woff2",
  variable: "--font-dm-sans",
  display: "swap",
  weight: "100 1000",
});

const dmSerifDisplay = localFont({
  src: [
    {
      path: "./fonts/dm-serif-display.woff2",
      weight: "400",
      style: "normal",
    },
    {
      path: "./fonts/dm-serif-display-italic.woff2",
      weight: "400",
      style: "italic",
    },
  ],
  variable: "--font-dm-serif-display",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Unbound Anywhere",
  description:
    "Vail Valley Unbound's remote learning dashboard for families on the move.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${dmSans.variable} ${dmSerifDisplay.variable}`}>
      <body>{children}</body>
    </html>
  );
}
