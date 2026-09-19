import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const inter = Inter({ variable: "--font-inter", subsets: ["latin"] });
const jetbrains = JetBrains_Mono({ variable: "--font-jetbrains", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Bellcurve — the AMM that knows when Wall Street is closed",
  description:
    "A market-hours-aware AMM for tokenized stocks on Solana: oracle-tight while the market is open, price discovery with a widening uncertainty spread while it is closed.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${inter.variable} ${jetbrains.variable} antialiased`}>
      <body className="min-h-screen">{children}</body>
    </html>
  );
}
