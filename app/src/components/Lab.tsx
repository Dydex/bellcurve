"use client";

import { PublicKey } from "@solana/web3.js";
import { useCallback, useEffect, useRef, useState } from "react";
import deployment from "@/data/deployment.json";
import {
  depositIx,
  ensureAccountsIxs,
  issuePassIx,
  passAddress,
  poolAddrs,
  readPoolState,
  revokePassIx,
  swapIx,
  updateConfigIx,
  updateMarketIx,
  withdrawIx,
  type PoolState,
} from "@/lib/actions";
import { coneHalfSpreadBps, quote, type Status } from "@/lib/quote";
import {
  createSandbox,
  loadSandbox,
  multiplierIx,
  realPrice,
  saveSandbox,
  sandboxAddrs,
  type Sandbox,
} from "@/lib/sandbox";
import { explorerAddress, send, type SendResult } from "@/lib/solana";
import { useToast } from "@/lib/toast";
import { useNow } from "@/lib/usePool";
import { useWallet } from "@/lib/wallet";
import { StatusPill, usd } from "./Market";
import { ActionLog, type LogEntry } from "./ui";
import { useFaucet } from "./WalletButton";

type Kind = "swap" | "deposit" | "withdraw" | "keeper" | "issuer" | "config" | "pass" | "attack";
type Role = "keeper" | "issuer" | "compliance" | "trader" | "attacker";

const CHECKS = [
  { id: "swap-open", title: "Trades track the exchange while open", role: "Keeper → Open, Trader → Buy" },
  { id: "discover", title: "Closed trades move the pool's own price", role: "Keeper → Close, Trader → Sell twice" },
  { id: "widen", title: "The closed spread widens with √time", role: "Keeper → Close, wait 5 minutes" },
  { id: "halt", title: "A halt blocks trading", role: "Keeper → Halt, Trader → Sell" },
  { id: "stale", title: "A silent keeper blocks trading", role: "Keeper → Open, Freeze, wait 30s, Trader → Sell" },
  { id: "lp-rules", title: "Deposits wait for a fresh price; withdrawals never do", role: "Close, Trader → Deposit, then Withdraw" },
  { id: "corporate", title: "Dividends and splits price correctly", role: "Issuer → dividend or split" },
  { id: "permissioned", title: "Permissioned pools need a trader pass", role: "Compliance → on, Trader → Sell, pass, Sell" },
  { id: "cap", title: "The daily volume cap holds", role: "Compliance → cap, Trader → Buy" },
  { id: "band", title: "Oversized trades hit the price band", role: "Trader → Dump 40%" },
  { id: "roles", title: "Only the keeper can post prices", role: "Attacker → post NVDA = $1" },
];

const ROLES: { id: Role; label: string; blurb: string }[] = [
  { id: "keeper", label: "Keeper", blurb: "You report what Nasdaq is doing. In production this is a bot reading the exchange." },
  { id: "issuer", label: "Issuer", blurb: "You are the company and its tokenizer, running corporate actions through the Token-2022 multiplier." },
  { id: "compliance", label: "Compliance", blurb: "You run the venue's controls: the ones the SEC's tokenized-stock exemption asks for." },
  { id: "trader", label: "Trader", blurb: "You trade and provide liquidity. Every button is a real devnet transaction." },
  { id: "attacker", label: "Attacker", blurb: "You try to cheat the shared live pool, which you do not control." },
];

const shared = poolAddrs(new PublicKey(deployment.baseMint), new PublicKey(deployment.quoteMint));

function MiniCone({ st, now }: { st: PoolState; now: number }) {
  const W = 360;
  const H = 110;
  const mins = st.market.status === "closed" ? (now - st.market.closeTs) / 60 : null;
  const xMax = Math.max(60, Math.ceil(((mins ?? 0) + 5) / 15) * 15);
  const yMax = coneHalfSpreadBps(st.params, xMax / 60) * 1.1;
  const x = (m: number) => 8 + (m / xMax) * (W - 16);
  const y = (b: number) => H / 2 - (b / yMax) * (H / 2 - 8);
  const pts = Array.from({ length: 61 }, (_, i) => (i / 60) * xMax);
  const line = (sign: number) => pts.map((m) => `${x(m)},${y(sign * coneHalfSpreadBps(st.params, m / 60))}`).join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Spread since the close">
      <line x1={8} x2={W - 8} y1={H / 2} y2={H / 2} stroke="var(--line)" />
      <polyline points={line(1)} fill="none" stroke="var(--bell)" strokeWidth="1.8" />
      <polyline points={line(-1)} fill="none" stroke="var(--bell)" strokeWidth="1.8" />
      {mins !== null && <line x1={x(mins)} x2={x(mins)} y1={6} y2={H - 6} stroke="var(--closed)" strokeWidth="1.5" />}
      <text x={W - 8} y={H - 2} textAnchor="end" fontSize="10" fill="var(--dim)">
        spread over {xMax} demo hours after the close
      </text>
    </svg>
  );
}

function ActionButton({
  label,
  hint,
  onClick,
  busy,
  tone = "default",
}: {
  label: string;
  hint: string;
  onClick: () => void;
  busy?: boolean;
  tone?: "default" | "danger";
}) {
  return (
    <button
      onClick={onClick}
      disabled={busy}
      className={`rounded-xl border p-4 text-left transition disabled:opacity-60 ${
        tone === "danger" ? "border-halted/40 bg-halted/5 hover:bg-halted/10" : "border-line bg-panel-2 hover:border-muted"
      }`}
    >
      <div className={`text-sm font-semibold ${tone === "danger" ? "text-halted" : "text-text"}`}>{busy ? "Sending…" : label}</div>
      <div className="mt-1 text-xs text-muted">{hint}</div>
    </button>
  );
}

export default function Lab() {
  const { signer, balances, refresh: refreshWallet, useDemo } = useWallet();
  const { request, busy: faucetBusy } = useFaucet();
  const toast = useToast();
  const now = useNow();
  const [sb, setSb] = useState<Sandbox | null>(null);
  const [st, setSt] = useState<PoolState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [done, setDone] = useState<Set<string>>(new Set());
  const [keeperOn, setKeeperOn] = useState(true);
  const [role, setRole] = useState<Role>("keeper");
  const seen = useRef<Set<string>>(new Set());

  const doneKey = sb ? `bellcurve-checks-${sb.baseMint}` : null;
  useEffect(() => setSb(signer ? loadSandbox(signer.publicKey) : null), [signer]);
  useEffect(() => {
    if (!doneKey) return;
    try {
      setDone(new Set(JSON.parse(localStorage.getItem(doneKey) ?? "[]")));
    } catch {}
  }, [doneKey]);
  const tick = useCallback(
    (id: string) =>
      setDone((d) => {
        if (d.has(id)) return d;
        const next = new Set(d).add(id);
        try {
          if (doneKey) localStorage.setItem(doneKey, JSON.stringify([...next]));
        } catch {}
        return next;
      }),
    [doneKey],
  );

  const reload = useCallback(async () => {
    if (!sb || !signer) return;
    const state = await readPoolState(sandboxAddrs(sb), signer.publicKey).catch(() => null);
    if (state) setSt(state);
  }, [sb, signer]);

  useEffect(() => {
    reload();
    const id = setInterval(reload, 6_000);
    return () => clearInterval(id);
  }, [reload]);

  useEffect(() => {
    if (st?.market.status === "closed" && now - st.market.closeTs >= 300) tick("widen");
  }, [st, now, tick]);

  const post = useCallback(
    async (status: Status, withPrice: boolean) => {
      if (!sb || !signer) throw new Error("no pool");
      const price = withPrice ? (await realPrice()) / sb.split : 0;
      return [await updateMarketIx(sandboxAddrs(sb), signer.publicKey, status, price, Math.floor(Date.now() / 1000))];
    },
    [sb, signer],
  );

  // The keeper loop: while open, refresh the reference price every 15 s unless frozen.
  useEffect(() => {
    if (!keeperOn || st?.market.status !== "open" || !signer) return;
    const id = setInterval(async () => {
      await send(signer, await post("open", true));
    }, 15_000);
    return () => clearInterval(id);
  }, [keeperOn, st?.market.status, signer, post]);

  const record = (action: string, result: SendResult) =>
    setLog((l) => [{ id: Date.now() + Math.random(), at: Date.now(), action, result }, ...l].slice(0, 12));

  const act = async (label: string, kind: Kind, build: () => Promise<any[]>) => {
    if (!signer) return;
    const status = st?.market.status;
    const permissioned = st?.permissioned;
    setBusy(label);
    try {
      const r = await send(signer, await build());
      record(label, r);
      toast(label, r);
      if (kind === "swap" && r.ok && status === "open") tick("swap-open");
      if (kind === "swap" && r.code === "Halted") tick("halt");
      if (kind === "swap" && r.code === "StalePrice") tick("stale");
      if (kind === "swap" && r.ok && status === "closed") {
        if (seen.current.has("closed-swap")) tick("discover");
        seen.current.add("closed-swap");
      }
      if (kind === "deposit" && r.code === "StalePrice") seen.current.add("deposit-refused");
      if (kind === "withdraw" && r.ok && status !== "open") seen.current.add("withdraw-ok");
      if (seen.current.has("deposit-refused") && seen.current.has("withdraw-ok")) tick("lp-rules");
      if (kind === "issuer" && r.ok) tick("corporate");
      if (kind === "swap" && r.code === "PassRequired") seen.current.add("pass-refused");
      if (kind === "swap" && r.ok && permissioned && seen.current.has("pass-refused")) tick("permissioned");
      if (r.code === "VolumeCapExceeded") tick("cap");
      if (r.code === "OutsideBand" || r.code === "InventoryLimit") tick("band");
      if (kind === "attack" && r.code === "ConstraintHasOne") tick("roles");
      await Promise.all([reload(), refreshWallet()]);
    } finally {
      setBusy(null);
    }
  };

  const intro = (
    <div className="max-w-3xl">
      <div className="eyebrow">Market lab</div>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">Run your own stock pool. Play every role.</h1>
      <p className="mt-3 text-muted">
        Spin up a private tokenized stock and Bellcurve pool on devnet. Be the exchange, the company, the compliance desk
        and the trader, and watch the program enforce every rule on-chain. Runs at 60× speed: a minute of closed market
        counts as an hour.
      </p>
    </div>
  );

  if (!signer || !sb) {
    const needsSol = !!signer && (balances?.sol ?? 0) < 0.03;
    return (
      <div className="space-y-8">
        {intro}
        <div className="panel grid gap-6 p-6 md:grid-cols-3">
          {[
            { n: 1, title: "Connect", done: !!signer, body: "A demo wallet lives in this browser: nothing to install." },
            { n: 2, title: "Fund", done: !!signer && !needsSol, body: "The faucet sends devnet SOL for fees and test tokens." },
            { n: 3, title: "Create your pool", done: false, body: "Four transactions: your stock, your USDC, your pool, $50k of liquidity." },
          ].map((s) => (
            <div key={s.n}>
              <div className={`num flex h-8 w-8 items-center justify-center rounded-full border text-sm ${s.done ? "border-open text-open" : "border-line text-muted"}`}>
                {s.done ? "✓" : s.n}
              </div>
              <div className="mt-3 font-semibold">{s.title}</div>
              <div className="mt-1 text-sm text-muted">{s.body}</div>
            </div>
          ))}
          <div className="md:col-span-3">
            {!signer ? (
              <button onClick={useDemo} className="rounded-xl bg-bell px-5 py-3 font-semibold text-bg hover:brightness-110">
                Connect a demo wallet
              </button>
            ) : needsSol ? (
              <button onClick={request} disabled={faucetBusy} className="rounded-xl bg-bell px-5 py-3 font-semibold text-bg hover:brightness-110 disabled:opacity-50">
                {faucetBusy ? "Sending…" : "Get test tokens"}
              </button>
            ) : (
              <div className="flex flex-wrap items-center gap-4">
                <button
                  disabled={busy === "create"}
                  onClick={async () => {
                    setBusy("create");
                    try {
                      const { sandbox, result } = await createSandbox(signer, setProgress);
                      toast("Create pool", result);
                      if (sandbox) setSb(sandbox);
                      await refreshWallet();
                    } finally {
                      setBusy(null);
                      setProgress(null);
                    }
                  }}
                  className="rounded-xl bg-bell px-5 py-3 font-semibold text-bg hover:brightness-110 disabled:opacity-60"
                >
                  {busy === "create" ? "Creating…" : "Create my pool"}
                </button>
                {progress && <span className="text-sm text-muted">{progress}…</span>}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  const a = sandboxAddrs(sb);
  const me = signer.publicKey;
  const pass = st?.permissioned && st.passExists ? passAddress(a.pool, me) : null;
  const q = st ? quote(st.params, st.market, st.reserves, now) : null;
  const tokens = (shares: number) => shares / (st?.multiplier ?? 1);
  const status = st?.market.status;

  const actions: Record<Role, React.ReactNode> = {
    keeper: (
      <>
        <ActionButton label="Open the market" hint="Post the real NVDA price. The spread tightens to a few bps." busy={busy === "open"} onClick={() => act("open", "keeper", () => post("open", true))} />
        <ActionButton label="Close the market" hint="4 PM: no more prices. The pool starts finding its own." busy={busy === "close"} onClick={() => act("close", "keeper", () => post("closed", false))} />
        <ActionButton label="Halt trading" hint="Nasdaq halted the stock. Swaps will be refused." tone="danger" busy={busy === "halt"} onClick={() => act("halt", "keeper", () => post("halted", false))} />
        <ActionButton
          label={keeperOn ? "Freeze the keeper" : "Restart the keeper"}
          hint={keeperOn ? "Simulate a dead price feed. Stale after 30s." : "Resume posting prices every 15s."}
          onClick={() => setKeeperOn((k) => !k)}
        />
      </>
    ),
    issuer: (
      <>
        <ActionButton
          label="Pay a 2% stock dividend"
          hint="Multiplier ×1.02. Holders' shares grow; the pool prices it instantly."
          busy={busy === "2% stock dividend"}
          onClick={() => act("2% stock dividend", "issuer", async () => [multiplierIx(sb, me, (st?.multiplier ?? 1) * 1.02)])}
        />
        <ActionButton
          label="Split 2-for-1"
          hint="Twice the shares at half the price. Value unchanged."
          busy={busy === "2-for-1 split"}
          onClick={() =>
            act("2-for-1 split", "issuer", async () => {
              const next = { ...sb, split: sb.split * 2 };
              const price = (await realPrice()) / next.split;
              const ixs = [multiplierIx(sb, me, (st?.multiplier ?? 1) * 2), await updateMarketIx(a, me, status ?? "open", price, Math.floor(Date.now() / 1000))];
              saveSandbox(next, me);
              setSb(next);
              return ixs;
            })
          }
        />
      </>
    ),
    compliance: (
      <>
        <ActionButton
          label={st?.permissioned ? "Open access to everyone" : "Require approved traders"}
          hint={st?.permissioned ? "Switch permissioned mode off." : "Permissioned mode: trades need a trader pass."}
          busy={busy?.startsWith("permissioned")}
          onClick={() => act(st?.permissioned ? "permissioned off" : "permissioned on", "config", async () => [await updateConfigIx(a, me, st!.params, !st!.permissioned, st!.dailyVolumeCap)])}
        />
        <ActionButton
          label={st?.passExists ? "Revoke my trader pass" : "Approve my wallet"}
          hint={st?.passExists ? "Remove the approval." : "Issue a trader pass, as a gatekeeper would after KYC."}
          busy={busy?.endsWith("pass")}
          onClick={() =>
            act(st?.passExists ? "revoke pass" : "issue pass", "pass", async () => [
              st?.passExists ? await revokePassIx(a, me, me) : await issuePassIx(a, me, me, Math.floor(Date.now() / 1000) + 3600),
            ])
          }
        />
        <ActionButton
          label={st?.dailyVolumeCap ? "Remove the volume cap" : "Cap volume at $1,000/day"}
          hint="Volume limits are a condition of the SEC exemption."
          busy={busy?.endsWith("cap")}
          onClick={() => act(st?.dailyVolumeCap ? "remove cap" : "set cap", "config", async () => [await updateConfigIx(a, me, st!.params, st!.permissioned, st!.dailyVolumeCap ? 0 : 1_000)])}
        />
      </>
    ),
    trader: (
      <>
        <ActionButton label="Buy $300" hint="Swap test USDC for stock." busy={busy === "buy $300"} onClick={() => act("buy $300", "swap", async () => [await swapIx(a, me, "buy", 300, pass)])} />
        <ActionButton label="Sell 1 share" hint="Swap stock for test USDC." busy={busy === "sell 1 share"} onClick={() => act("sell 1 share", "swap", async () => [await swapIx(a, me, "sell", tokens(1), pass)])} />
        <ActionButton
          label="Dump 40% of the pool"
          hint="An oversized order. Expect the price band."
          tone="danger"
          busy={busy === "dump 40%"}
          onClick={() => act("dump 40%", "swap", async () => [await swapIx(a, me, "sell", tokens((st?.reserves.base ?? 0) * 0.4), pass)])}
        />
        <ActionButton
          label="Deposit $1,000"
          hint="Needs an open market with a fresh price."
          busy={busy === "deposit $1,000"}
          onClick={() => act("deposit $1,000", "deposit", async () => [...ensureAccountsIxs(a, me), await depositIx(a, me, tokens(500 / (st?.market.refPrice || 1)), 500, pass)])}
        />
        <ActionButton
          label="Withdraw 10%"
          hint="Works in every market state, even halted."
          busy={busy === "withdraw 10%"}
          onClick={() => act("withdraw 10%", "withdraw", async () => [await withdrawIx(a, me, (st?.lpSupply ?? 0) * 0.1)])}
        />
      </>
    ),
    attacker: (
      <ActionButton
        label="Post NVDA = $1 to the live pool"
        hint="You are not the live pool's keeper. The program should refuse."
        tone="danger"
        busy={busy === "fake price"}
        onClick={() => act("fake price", "attack", async () => [await updateMarketIx(shared, me, "open", 1, Math.floor(Date.now() / 1000))])}
      />
    ),
  };

  const current = ROLES.find((r) => r.id === role)!;
  return (
    <div className="space-y-8">
      {intro}
      <div className="grid gap-5 lg:grid-cols-[1fr_360px]">
        <div className="space-y-5">
          <div className="panel p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="font-semibold">Your pool</div>
                <div className="mt-0.5 flex gap-3 text-xs text-dim">
                  <a className="hover:text-muted" href={explorerAddress(a.pool.toBase58())} target="_blank">
                    {a.pool.toBase58().slice(0, 6)}… ↗
                  </a>
                  <button
                    className="hover:text-halted"
                    onClick={() => {
                      saveSandbox(null, me);
                      setSb(null);
                      setSt(null);
                    }}
                  >
                    start over
                  </button>
                </div>
              </div>
              {status && <StatusPill status={status} />}
            </div>
            {st && (
              <>
                <div className="num mt-5 grid grid-cols-2 gap-4 sm:grid-cols-4">
                  <div>
                    <div className="text-xs text-muted">Reference</div>
                    <div className="text-lg">{usd(st.market.refPrice)}</div>
                    <div className="text-xs text-dim">
                      {status === "closed"
                        ? `closed ${((now - st.market.closeTs) / 60).toFixed(1)} demo h`
                        : `${now - st.market.refTs}s old · stale at ${st.params.maxStalenessSecs}s`}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-muted">Bid / Ask</div>
                    <div className="text-lg">{q ? `${q.bid.toFixed(2)} / ${q.ask.toFixed(2)}` : "—"}</div>
                    <div className="text-xs text-dim">{q ? `mid ${usd(q.mid)}` : status === "halted" ? "halted: trades refused" : "stale: trades refused"}</div>
                  </div>
                  <div>
                    <div className="text-xs text-muted">Spread</div>
                    <div className="text-lg">{q ? `±${q.halfSpreadBps.toFixed(0)} bps` : "—"}</div>
                    <div className="text-xs text-dim">multiplier ×{st.multiplier.toFixed(4)}</div>
                  </div>
                  <div>
                    <div className="text-xs text-muted">Liquidity</div>
                    <div className="text-lg">{usd(st.reserves.base * st.market.refPrice + st.reserves.quote, 0)}</div>
                    <div className="text-xs text-dim">
                      {st.permissioned ? "permissioned" : "open access"}
                      {st.dailyVolumeCap ? ` · cap ${usd(st.dailyVolumeCap, 0)}` : ""}
                    </div>
                  </div>
                </div>
                <div className="mt-4 grid items-center gap-4 sm:grid-cols-[1fr_1.3fr]">
                  <div>
                    <div className="flex h-2 overflow-hidden rounded-full bg-panel-2">
                      <div className="bg-bell" style={{ width: `${((q?.baseWeight ?? 0.5) * 100).toFixed(1)}%` }} />
                      <div className="flex-1 bg-closed/40" />
                    </div>
                    <div className="mt-1.5 text-xs text-dim">
                      {st.reserves.base.toFixed(2)} shares · {usd(st.reserves.quote, 0)} · volume today {usd(st.volumeToday, 0)} ·
                      keeper {keeperOn ? "running" : "frozen"}
                    </div>
                  </div>
                  <MiniCone st={st} now={now} />
                </div>
              </>
            )}
          </div>

          <div className="panel p-5">
            <div className="flex flex-wrap gap-1 rounded-lg bg-panel-2 p-1">
              {ROLES.map((r) => (
                <button
                  key={r.id}
                  onClick={() => setRole(r.id)}
                  className={`flex-1 rounded-md px-3 py-1.5 text-sm transition ${
                    role === r.id ? (r.id === "attacker" ? "bg-halted/20 text-halted" : "bg-panel text-text") : "text-muted hover:text-text"
                  }`}
                >
                  {r.label}
                </button>
              ))}
            </div>
            <p className="mt-4 text-sm text-muted">{current.blurb}</p>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">{actions[role]}</div>
          </div>
        </div>

        <div className="space-y-5">
          <div className="panel p-5">
            <div className="flex items-baseline justify-between">
              <h3 className="font-semibold">Verified on-chain</h3>
              <span className="num text-sm text-bell">
                {done.size}/{CHECKS.length}
              </span>
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-panel-2">
              <div className="h-full bg-open transition-all" style={{ width: `${(done.size / CHECKS.length) * 100}%` }} />
            </div>
            <ul className="mt-4 space-y-2.5">
              {CHECKS.map((c) => {
                const ok = done.has(c.id);
                return (
                  <li key={c.id} className="flex gap-3">
                    <span className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-xs ${ok ? "border-open bg-open/15 text-open" : "border-line"}`}>
                      {ok ? "✓" : ""}
                    </span>
                    <div>
                      <div className={`text-sm ${ok ? "text-text" : "text-muted"}`}>{c.title}</div>
                      <div className="text-xs text-dim">{c.role}</div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
          <div className="panel p-5">
            <h3 className="mb-3 font-semibold">Activity</h3>
            <ActionLog entries={log} />
          </div>
        </div>
      </div>
    </div>
  );
}
