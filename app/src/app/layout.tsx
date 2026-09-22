import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import Header from "@/components/Header";
import Providers from "@/components/Providers";
import "./globals.css";

const inter = Inter({ variable: "--font-inter", subsets: ["latin"] });
const jetbrains = JetBrains_Mono({ variable: "--font-jetbrains", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Bellcurve — the AMM that knows when Wall Street is closed",
  description:
    "Tokenized-stock liquidity on Solana that tracks the exchange while it's open, discovers the price while it's closed, and stops when trading halts.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${inter.variable} ${jetbrains.variable} antialiased`}>
      <body className="min-h-screen">
        <Providers>
          <Header />
          {children}
          <footer className="mx-auto mt-24 max-w-7xl border-t border-line px-5 py-8 text-xs text-dim">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span>Bellcurve · built on Solana for Stocklana</span>
              <span>Devnet demo with test tokens · not investment advice</span>
            </div>
          </footer>
        </Providers>
      </body>
    </html>
  );
}
