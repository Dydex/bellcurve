"use client";

import { useEffect, useState } from "react";
import type { PoolSnapshot } from "./pool";

// One poll shared by every component on the page.
let latest: PoolSnapshot | null = null;
let error: string | null = null;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

async function refresh() {
  try {
    const res = await fetch("/api/pool", { cache: "no-store" });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? res.statusText);
    latest = body;
    error = null;
  } catch (e: any) {
    error = e.message ?? "unavailable";
  }
  listeners.forEach((l) => l());
}

export function usePool() {
  const [, setTick] = useState(0);
  useEffect(() => {
    const l = () => setTick((t) => t + 1);
    listeners.add(l);
    if (!timer) {
      refresh();
      timer = setInterval(refresh, 10_000);
    }
    return () => {
      listeners.delete(l);
      if (listeners.size === 0 && timer) {
        clearInterval(timer);
        timer = null;
      }
    };
  }, []);
  return { pool: latest, error };
}

/** Seconds-resolution clock for countdowns between polls. */
export function useNow() {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}
