#!/usr/bin/env python3
"""Download hourly bars (regular + extended hours) for the backtest.

Writes data/raw/<TICKER>_1h.csv with columns: ts,open,close,session
where session is pre | regular | post in America/New_York time.

Usage: python3 scripts/fetch_data.py [TICKER ...]
"""
import csv
import json
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

DEFAULT_TICKERS = ["SPY", "QQQ", "NVDA", "TSLA", "AAPL", "MSTR"]
URL = "https://query1.finance.yahoo.com/v8/finance/chart/{t}?range=730d&interval=1h&includePrePost=true"
NY = ZoneInfo("America/New_York")
OUT = Path(__file__).resolve().parent.parent / "data" / "raw"


def session_of(ts: int) -> str:
    local = datetime.fromtimestamp(ts, timezone.utc).astimezone(NY)
    minutes = local.hour * 60 + local.minute
    if minutes < 9 * 60 + 30:
        return "pre"
    if minutes < 16 * 60:
        return "regular"
    return "post"


def fetch(ticker: str) -> int:
    req = urllib.request.Request(URL.format(t=ticker), headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        result = json.load(resp)["chart"]["result"][0]
    quote = result["indicators"]["quote"][0]
    rows = []
    for ts, o, c in zip(result["timestamp"], quote["open"], quote["close"]):
        if o is None or c is None:
            continue
        rows.append((ts, round(o, 4), round(c, 4), session_of(ts)))
    # Yahoo appends a live partial bar; keep bars in strictly increasing order.
    rows.sort()
    OUT.mkdir(parents=True, exist_ok=True)
    with open(OUT / f"{ticker}_1h.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["ts", "open", "close", "session"])
        w.writerows(rows)
    return len(rows)


def main() -> None:
    tickers = sys.argv[1:] or DEFAULT_TICKERS
    for t in tickers:
        n = fetch(t)
        print(f"{t}: {n} bars")


if __name__ == "__main__":
    main()
