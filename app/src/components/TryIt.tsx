"use client";

import { WalletProvider } from "@/lib/wallet";
import Playground from "./Playground";
import Sandbox from "./Sandbox";

export default function TryIt() {
  return (
    <WalletProvider>
      <div className="space-y-12">
        <div>
          <div className="eyebrow">Try it · real transactions on Solana devnet</div>
          <h2 className="mt-1 text-2xl font-semibold">Trade the live NVDA pool</h2>
          <p className="mt-2 max-w-3xl text-sm text-muted">
            Get a demo wallet and test tokens, then swap or provide liquidity. The preview shows what the program will
            do, including when and why it will refuse, before you sign.
          </p>
          <div className="mt-5">
            <Playground />
          </div>
        </div>
        <div>
          <h2 className="text-2xl font-semibold">Run your own pool</h2>
          <p className="mt-2 max-w-3xl text-sm text-muted">
            Halts, market closes, dividends and permissioned access would disrupt the shared pool, so test them on a
            private pool where you hold every role. Each behavior below ticks off when you trigger it on-chain.
          </p>
          <div className="mt-5">
            <Sandbox />
          </div>
        </div>
      </div>
    </WalletProvider>
  );
}
