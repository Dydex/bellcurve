"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { REPO_URL } from "@/lib/links";
import WalletButton from "./WalletButton";

const LINKS = [
  { href: "/trade", label: "Trade" },
  { href: "/lab", label: "Lab" },
  { href: "/research", label: "Research" },
];

export function Logo() {
  return (
    <Link href="/" className="flex items-center gap-2.5">
      <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden>
        <path d="M2 22 C 9 22, 10 5, 14 5 S 19 22, 26 22" fill="none" stroke="var(--bell)" strokeWidth="2.6" strokeLinecap="round" />
      </svg>
      <span className="text-lg font-semibold tracking-tight">Bellcurve</span>
    </Link>
  );
}

export default function Header() {
  const path = usePathname();
  return (
    <header className="sticky top-0 z-30 border-b border-line/60 bg-bg/80 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-5">
        <div className="flex items-center gap-8">
          <Logo />
          <nav className="hidden items-center gap-1 sm:flex">
            {LINKS.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                className={`rounded-lg px-3 py-1.5 text-sm transition ${
                  path === l.href ? "bg-panel-2 text-text" : "text-muted hover:text-text"
                }`}
              >
                {l.label}
              </Link>
            ))}
            <a href={REPO_URL} target="_blank" className="rounded-lg px-3 py-1.5 text-sm text-muted transition hover:text-text">
              GitHub ↗
            </a>
          </nav>
        </div>
        <div className="flex items-center gap-3">
          <span className="hidden rounded-full border border-closed/40 px-2.5 py-1 text-xs text-closed md:inline">Devnet</span>
          <WalletButton />
        </div>
      </div>
      <nav className="flex gap-1 px-5 pb-2 sm:hidden">
        {LINKS.map((l) => (
          <Link key={l.href} href={l.href} className={`rounded-lg px-3 py-1 text-sm ${path === l.href ? "bg-panel-2 text-text" : "text-muted"}`}>
            {l.label}
          </Link>
        ))}
      </nav>
    </header>
  );
}
