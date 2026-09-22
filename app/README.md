# Bellcurve dashboard

Next.js app for Bellcurve: the live devnet pool, the weekend-gap chart, backtest results, Nasdaq's halt feed, and the Try it playground and sandbox pools. See the [project README](../README.md) for how it fits together.

```bash
pnpm install
python3 ../scripts/build_dashboard_data.py   # bundle backtest results, gaps and the deployment
pnpm dev                                      # or: pnpm build && pnpm start
```

Environment variables (all optional locally):

| Variable | Purpose |
|---|---|
| `FAUCET_KEYPAIR` | JSON byte array of the faucet key (devnet SOL plus the test tokens' mint authority). Defaults to `~/.config/solana/bellcurve-faucet.json` |
| `RPC_URL` | RPC endpoint for server routes |
| `NEXT_PUBLIC_RPC_URL` | RPC endpoint for the browser |
