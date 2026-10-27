import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "XP Dashboard",
  description: "A simple weekly effort dashboard for families.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
