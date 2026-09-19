#!/usr/bin/env python3
"""Bundle backtest results, real weekend gaps and the devnet deployment for the dashboard.

Writes app/src/data/{backtest,gaps,deployment}.json and app/src/idl/bellcurve.json.
Run after the backtest: python3 scripts/build_dashboard_data.py
"""
import csv
import json
import shutil
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "app" / "src" / "data"
NY = ZoneInfo("America/New_York")
WEEKEND_SECS = 24 * 3600


def weekend_gaps(ticker: str) -> list[dict]:
    """Every closed period longer than a day: hours closed and the price move across it."""
    rows = list(csv.DictReader(open(ROOT / "data" / "raw" / f"{ticker}_1h.csv")))
    gaps = []
    for prev, nxt in zip(rows, rows[1:]):
        end = min(int(prev["ts"]) + 3600, int(nxt["ts"]))
        gap = int(nxt["ts"]) - end
        if gap > WEEKEND_SECS:
            close, reopen = float(prev["close"]), float(nxt["open"])
            gaps.append(
                {
                    "closed": datetime.fromtimestamp(end, timezone.utc).astimezone(NY).strftime("%Y-%m-%d"),
                    "hours": round(gap / 3600, 1),
                    "move_bps": round((reopen / close - 1) * 1e4, 1),
                }
            )
    return gaps


def main() -> None:
    DATA.mkdir(parents=True, exist_ok=True)
    backtest = json.load(open(ROOT / "results" / "backtest.json"))
    for name in ("15s", "60s"):
        latency = json.load(open(ROOT / "results" / f"latency_{name}.json"))
        backtest[f"latency_{name}"] = {
            t["ticker"]: {v["name"]: round(v["lp_vs_hodl_pct"], 3) for v in t["informed_only"]}
            for t in latency["tickers"]
        }
    json.dump(backtest, open(DATA / "backtest.json", "w"))

    gaps = {t["ticker"]: weekend_gaps(t["ticker"]) for t in backtest["tickers"]}
    json.dump(gaps, open(DATA / "gaps.json", "w"))

    shutil.copy(ROOT / "deploy" / "devnet.json", DATA / "deployment.json")
    (ROOT / "app" / "src" / "idl").mkdir(exist_ok=True)
    shutil.copy(ROOT / "target" / "idl" / "bellcurve.json", ROOT / "app" / "src" / "idl" / "bellcurve.json")
    print({t: len(g) for t, g in gaps.items()})


if __name__ == "__main__":
    main()
