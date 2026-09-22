"use client";

import { ToastProvider } from "@/lib/toast";
import { WalletProvider } from "@/lib/wallet";

export default function Providers({ children }: { children: React.ReactNode }) {
  return (
    <WalletProvider>
      <ToastProvider>{children}</ToastProvider>
    </WalletProvider>
  );
}
