"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  depositIx,
  ensureAccountsIxs,
  issuePassIx,
  passAddress,
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
  type Sandbox as SandboxT,
} from "@/lib/sandbox";
import { explorerAddress, send, type SendResult } from "@/lib/solana";
import { useNow } from "@/lib/usePool";
import { useWallet } from "@/lib/wallet";
import { StatusPill } from "./LivePool";
import { ActionLog, Button, type LogEntry } from "./ui";

type Kind = "swap" | "deposit" | "withdraw" | "keeper" | "issuer" | "config" | "pass";

interface Check {
  id: string;
  title: string;
  how: string;
}

const CHECKS: Check[] = [
  { id: "swap-open", title: "Trade while the market is open", how: "Keeper → Open, then Buy or Sell. Fills a few bps from the reference." },
  { id: "halt", title: "A halt blocks trading", how: "Keeper → Halt, then try a trade: Halted." },
  { id: "stale", title: "A silent keeper blocks trading", how: "Open the market, Freeze keeper, wait 30 s, trade: StalePrice." },
  { id: "widen", title: "The closed spread widens with √time", how: "Keeper → Close and watch the half-spread for 5+ minutes (5 demo hours)." },
  { id: "discover", title: "Closed trades move the pool's own price", how: "While closed, sell twice: the second fill is lower, the mid moved." },
  { id: "lp-rules", title: "Deposits need a fresh price; withdrawals always work", how: "While closed or halted: Deposit is refused, Withdraw succeeds." },
  { id: "corporate", title: "Dividends and splits reprice correctly", how: "Issuer → dividend or split, then trade: prices stay consistent." },
  { id: "permissioned", title: "Permissioned mode requires a trader pass", how: "Compliance → Permissioned on, trade (PassRequired), issue your pass, trade again." },
  { id: "cap", title: "The daily volume cap is enforced", how: "Compliance → $1,000 cap, then trade until VolumeCapExceeded." },
  { id: "band", title: "Oversized trades hit the price band or inventory limit", how: "Trade → Dump 40% of the pool: OutsideBand or InventoryLimit." },
];

const usd = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function MiniCone({ st, now }: { st: PoolState; now: number }) {
  const W = 360;
  const H = 120;
  const mins = st.market.status === "closed" ? (now - st.market.closeTs) / 60 : null;
  const xMax = Math.max(60, Math.ceil(((mins ?? 0) + 5) / 15) * 15);
  const yMax = coneHalfSpreadBps(st.params, xMax / 60) * 1.1;
  const x = (m: number) => 8 + (m / xMax) * (W - 16);
  const y = (b: number) => H / 2 - (b / yMax) * (H / 2 - 8);
  const pts = Array.from({ length: 61 }, (_, i) => (i / 60) * xMax);
  const up = pts.map((m) => `${x(m)},${y(coneHalfSpreadBps(st.params, m / 60))}`).join(" ");
  const down = pts.map((m) => `${x(m)},${y(-coneHalfSpreadBps(st.params, m / 60))}`).join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Sandbox spread since the close">
      <line x1={8} x2={W - 8} y1={H / 2} y2={H / 2} stroke="var(--line)" />
      <polyline points={up} fill="none" stroke="var(--bell)" strokeWidth="1.8" />
      <polyline points={down} fill="none" stroke="var(--bell)" strokeWidth="1.8" />
      {mins !== null && <line x1={x(mins)} x2={x(mins)} y1={6} y2={H - 6} stroke="var(--closed)" strokeWidth="1.5" />}
      <text x={W - 8} y={H - 4} textAnchor="end" fontSize="10" fill="var(--dim)">
        {xMax} demo hours (minutes) after close
      </text>
    </svg>
  );
}

export default function Sandbox() {
  const { signer, refresh: refreshWallet, useDemo } = useWallet();
  const now = useNow();
  const [sb, setSb] = useState<SandboxT | null>(null);
  const [st, setSt] = useState<PoolState | null>(null);
  const [passExists, setPassExists] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [done, setDone] = useState<Set<string>>(new Set());
  const [keeperOn, setKeeperOn] = useState(true);
  const [lastKeep, setLastKeep] = useState(0);
  const seen = useRef<Set<string>>(new Set());

  const doneKey = sb ? `bellcurve-checks-${sb.baseMint}` : null;
  useEffect(() => {
    setSb(signer ? loadSandbox(signer.publicKey) : null);
  }, [signer]);
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
    if (state) {
      setSt(state);
      setPassExists(state.passExists);
    }
  }, [sb, signer]);

  useEffect(() => {
    reload();
    const id = setInterval(reload, 6_000);
    return () => clearInterval(id);
  }, [reload]);

  // Auto-tick the widening check after 5 demo hours closed.
  useEffect(() => {
    if (st?.market.status === "closed" && now - st.market.closeTs >= 300) tick("widen");
  }, [st, now, tick]);

  const post = useCallback(
    async (status: Status, withPrice: boolean) => {
      if (!sb || !signer) throw new Error("no sandbox");
      const price = withPrice ? (await realPrice()) / sb.split : 0;
      return [await updateMarketIx(sandboxAddrs(sb), signer.publicKey, status, price, Math.floor(Date.now() / 1000))];
    },
    [sb, signer],
  );

  // The keeper: while open, refresh the reference price every 15 s unless frozen.
  useEffect(() => {
    if (!keeperOn || st?.market.status !== "open" || !signer) return;
    const id = setInterval(async () => {
      const r = await send(signer, await post("open", true));
      if (r.ok) setLastKeep(Math.floor(Date.now() / 1000));
    }, 15_000);
    return () => clearInterval(id);
  }, [keeperOn, st?.market.status, signer, post]);

  if (!signer) {
    return (
      <div className="panel p-6">
        <p className="max-w-2xl text-sm text-muted">
          A sandbox pool needs a devnet wallet. Create the same browser-held demo wallet used above, then come back here.
        </p>
        <div className="mt-4">
          <Button onClick={useDemo}>Use a demo wallet</Button>
        </div>
      </div>
    );
  }

  const record = (action: string, result: SendResult) =>
    setLog((l) => [{ id: Date.now() + Math.random(), at: Date.now(), action, result }, ...l].slice(0, 12));

  const act = async (label: string, kind: Kind, build: () => Promise<any[]>) => {
    const status = st?.market.status;
    const permissioned = st?.permissioned;
    setBusy(label);
    try {
      const r = await send(signer, await build());
      record(label, r);
      // Checklist bookkeeping.
      if (kind === "swap" && r.ok && status === "open") tick("swap-open");
      if (kind === "swap" && r.code === "Halted") tick("halt");
      if (kind === "swap" && r.code === "StalePrice") tick("stale");
      if (kind === "swap" && r.ok && status === "closed") {
        if (seen.current.has("closed-swap")) tick("discover");
        seen.current.add("closed-swap");
      }
      if (kind === "deposit" && !r.ok && r.code === "StalePrice") seen.current.add("deposit-refused");
      if (kind === "withdraw" && r.ok && status !== "open") seen.current.add("withdraw-ok");
      if (seen.current.has("deposit-refused") && seen.current.has("withdraw-ok")) tick("lp-rules");
      if (kind === "issuer" && r.ok) tick("corporate");
      if (kind === "swap" && r.code === "PassRequired") seen.current.add("pass-refused");
      if (kind === "swap" && r.ok && permissioned && seen.current.has("pass-refused")) tick("permissioned");
      if (r.code === "VolumeCapExceeded") tick("cap");
      if (r.code === "OutsideBand" || r.code === "InventoryLimit") tick("band");
      if (kind === "keeper" && r.ok) setLastKeep(Math.floor(Date.now() / 1000));
      await Promise.all([reload(), refreshWallet()]);
    } finally {
      setBusy(null);
    }
  };

  if (!sb) {
    return (
      <div className="panel p-6">
        <p className="max-w-2xl text-sm text-muted">
          Creates your own test stock, test USDC and Bellcurve pool on devnet in four transactions (about 0.03 devnet
          SOL, covered by the faucet). You become its keeper, its issuer and its admin, so you can halt it, close it,
          pay a dividend or make it permissioned without touching the shared pool. It runs at 60× speed: each minute
          after the close widens the spread like an hour does.
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button
            busy={busy === "create"}
            onClick={async () => {
              setBusy("create");
              try {
                const { sandbox, result } = await createSandbox(signer, setProgress);
                record("create sandbox", result);
                if (sandbox) setSb(sandbox);
                await refreshWallet();
              } finally {
                setBusy(null);
                setProgress(null);
              }
            }}
          >
            Create my sandbox pool
          </Button>
          {progress && <span className="text-sm text-muted">{progress}…</span>}
        </div>
        {log[0] && (
          <div className="mt-4">
            <ActionLog entries={log.slice(0, 1)} />
          </div>
        )}
      </div>
    );
  }

  const a = sandboxAddrs(sb);
  const me = signer.publicKey;
  const pass = st?.permissioned && passExists ? passAddress(a.pool, me) : null;
  const q = st ? quote(st.params, st.market, st.reserves, now) : null;
  const tokens = (shares: number) => shares / (st?.multiplier ?? 1);
  const status = st?.market.status;
  const closedFor = st && status === "closed" ? now - st.market.closeTs : 0;
  const keeperAge = st ? now - st.market.refTs : 0;

  return (
    <div className="grid gap-4 xl:grid-cols-[1.35fr_1fr]">
      <div className="space-y-4">
        <div className="panel p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="eyebrow">Your sandbox pool · 60× speed</div>
              <div className="mt-1 flex gap-3 text-xs text-dim">
                <a className="hover:text-muted" href={explorerAddress(a.pool.toBase58())} target="_blank">
                  pool {a.pool.toBase58().slice(0, 6)}… ↗
                </a>
                <a className="hover:text-muted" href={explorerAddress(sb.baseMint)} target="_blank">
                  stock mint ↗
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
              <div className="num mt-5 grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
                <div>
                  <div className="eyebrow">Reference</div>
                  <div className="mt-1 text-lg">{usd(st.market.refPrice)}</div>
                  <div className="text-xs text-muted">
                    {status === "closed" ? `closed ${(closedFor / 60).toFixed(1)} demo h` : `${keeperAge}s old · stale at ${st.params.maxStalenessSecs}s`}
                  </div>
                </div>
                <div>
                  <div className="eyebrow">Bid / ask</div>
                  <div className="mt-1 text-lg">{q ? `${q.bid.toFixed(2)} / ${q.ask.toFixed(2)}` : "—"}</div>
                  <div className="text-xs text-muted">{q ? `mid ${usd(q.mid)}` : "halted"}</div>
                </div>
                <div>
                  <div className="eyebrow">Half-spread</div>
                  <div className="mt-1 text-lg">{q ? `±${q.halfSpreadBps.toFixed(0)} bps` : "—"}</div>
                  <div className="text-xs text-muted">multiplier ×{st.multiplier.toFixed(4)}</div>
                </div>
                <div>
                  <div className="eyebrow">Pool</div>
                  <div className="mt-1 text-lg">{usd(st.reserves.base * st.market.refPrice + st.reserves.quote)}</div>
                  <div className="text-xs text-muted">
                    {st.permissioned ? "permissioned" : "open access"} · cap {st.dailyVolumeCap ? usd(st.dailyVolumeCap) : "none"}
                  </div>
                </div>
              </div>
              <div className="mt-4 grid items-center gap-4 sm:grid-cols-[1fr_1.2fr]">
                <div>
                  <div className="mb-1 flex justify-between text-xs text-muted">
                    <span>{st.reserves.base.toFixed(2)} shares</span>
                    <span>{usd(st.reserves.quote)}</span>
                  </div>
                  <div className="flex h-2 overflow-hidden rounded-full bg-panel-2">
                    <div className="bg-bell" style={{ width: `${((q?.baseWeight ?? 0.5) * 100).toFixed(1)}%` }} />
                    <div className="flex-1 bg-closed/40" />
                  </div>
                  <div className="mt-1 text-xs text-dim">
                    volume today {usd(st.volumeToday)} · keeper {keeperOn ? "running" : "frozen"}
                    {lastKeep ? `, last post ${now - lastKeep}s ago` : ""}
                  </div>
                </div>
                <MiniCone st={st} now={now} />
              </div>
            </>
          )}
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div className="panel p-5">
            <div className="eyebrow">Keeper</div>
            <p className="mt-1 mb-3 text-xs text-muted">What the real market is doing. You sign these as the pool&apos;s keeper.</p>
            <div className="flex flex-wrap gap-2">
              <Button variant="ghost" busy={busy === "open"} onClick={() => act("open", "keeper", () => post("open", true))}>
                Open (real NVDA price)
              </Button>
              <Button variant="ghost" busy={busy === "close"} onClick={() => act("close", "keeper", () => post("closed", false))}>
                Close
              </Button>
              <Button variant="danger" busy={busy === "halt"} onClick={() => act("halt", "keeper", () => post("halted", false))}>
                Halt
              </Button>
              <Button variant="ghost" onClick={() => setKeeperOn((k) => !k)}>
                {keeperOn ? "Freeze keeper" : "Restart keeper"}
              </Button>
            </div>
          </div>

          <div className="panel p-5">
            <div className="eyebrow">Issuer</div>
            <p className="mt-1 mb-3 text-xs text-muted">Corporate actions through the Token-2022 Scaled UI Amount multiplier.</p>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="ghost"
                busy={busy === "2% stock dividend"}
                onClick={() => act("2% stock dividend", "issuer", async () => [multiplierIx(sb, me, (st?.multiplier ?? 1) * 1.02)])}
              >
                Pay 2% stock dividend
              </Button>
              <Button
                variant="ghost"
                busy={busy === "2-for-1 split"}
                onClick={() =>
                  act("2-for-1 split", "issuer", async () => {
                    const next = { ...sb, split: sb.split * 2 };
                    const price = (await realPrice()) / next.split;
                    const ixs = [
                      multiplierIx(sb, me, (st?.multiplier ?? 1) * 2),
                      await updateMarketIx(a, me, status ?? "open", price, Math.floor(Date.now() / 1000)),
                    ];
                    saveSandbox(next, me);
                    setSb(next);
                    return ixs;
                  })
                }
              >
                2-for-1 split
              </Button>
            </div>
          </div>

          <div className="panel p-5">
            <div className="eyebrow">Compliance</div>
            <p className="mt-1 mb-3 text-xs text-muted">The controls the SEC exemption asks permissioned venues for.</p>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="ghost"
                busy={busy?.startsWith("permissioned")}
                onClick={() =>
                  act(st?.permissioned ? "permissioned off" : "permissioned on", "config", async () => [
                    await updateConfigIx(a, me, st!.params, !st!.permissioned, st!.dailyVolumeCap),
                  ])
                }
              >
                Permissioned: {st?.permissioned ? "on" : "off"}
              </Button>
              <Button
                variant="ghost"
                busy={busy?.endsWith("my pass")}
                onClick={() =>
                  act(passExists ? "revoke my pass" : "issue my pass", "pass", async () => [
                    passExists ? await revokePassIx(a, me, me) : await issuePassIx(a, me, me, Math.floor(Date.now() / 1000) + 3600),
                  ])
                }
              >
                {passExists ? "Revoke my pass" : "Issue my trader pass"}
              </Button>
              <Button
                variant="ghost"
                busy={busy?.endsWith("cap")}
                onClick={() =>
                  act(st?.dailyVolumeCap ? "remove cap" : "set $1,000 cap", "config", async () => [
                    await updateConfigIx(a, me, st!.params, st!.permissioned, st!.dailyVolumeCap ? 0 : 1_000),
                  ])
                }
              >
                {st?.dailyVolumeCap ? "Remove volume cap" : "Set $1,000 daily cap"}
              </Button>
            </div>
          </div>

          <div className="panel p-5">
            <div className="eyebrow">Trade and liquidity</div>
            <p className="mt-1 mb-3 text-xs text-muted">Every button is a real swap, deposit or withdrawal on devnet.</p>
            <div className="flex flex-wrap gap-2">
              <Button variant="ghost" busy={busy === "buy $300"} onClick={() => act("buy $300", "swap", async () => [await swapIx(a, me, "buy", 300, pass)])}>
                Buy $300
              </Button>
              <Button
                variant="ghost"
                busy={busy === "sell 1 share"}
                onClick={() => act("sell 1 share", "swap", async () => [await swapIx(a, me, "sell", tokens(1), pass)])}
              >
                Sell 1 share
              </Button>
              <Button
                variant="danger"
                busy={busy === "dump 40% of the pool"}
                onClick={() => act("dump 40% of the pool", "swap", async () => [await swapIx(a, me, "sell", tokens((st?.reserves.base ?? 0) * 0.4), pass)])}
              >
                Dump 40% of the pool
              </Button>
              <Button
                variant="ghost"
                busy={busy === "deposit $1,000"}
                onClick={() =>
                  act("deposit $1,000", "deposit", async () => [
                    ...ensureAccountsIxs(a, me),
                    await depositIx(a, me, tokens(500 / (st?.market.refPrice || 1)), 500, pass),
                  ])
                }
              >
                Deposit $1,000
              </Button>
              <Button
                variant="ghost"
                busy={busy === "withdraw 10%"}
                onClick={() => act("withdraw 10%", "withdraw", async () => [await withdrawIx(a, me, (st?.lpSupply ?? 0) * 0.1)])}
              >
                Withdraw 10%
              </Button>
            </div>
          </div>
        </div>
      </div>

      <div className="space-y-4">
        <div className="panel p-5">
          <div className="flex items-baseline justify-between">
            <div className="eyebrow">Behaviors verified on-chain</div>
            <span className="num text-sm text-bell">
              {done.size}/{CHECKS.length}
            </span>
          </div>
          <ul className="mt-3 space-y-2.5">
            {CHECKS.map((c) => {
              const ok = done.has(c.id);
              return (
                <li key={c.id} className="flex gap-3">
                  <span
                    className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-xs ${
                      ok ? "border-open bg-open/15 text-open" : "border-line text-dim"
                    }`}
                  >
                    {ok ? "✓" : ""}
                  </span>
                  <div>
                    <div className={`text-sm ${ok ? "text-text" : "text-muted"}`}>{c.title}</div>
                    <div className="text-xs text-dim">{c.how}</div>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
        <div className="panel p-5">
          <div className="eyebrow">Sandbox activity</div>
          <div className="mt-3">
            <ActionLog entries={log} />
          </div>
        </div>
      </div>
    </div>
  );
}
