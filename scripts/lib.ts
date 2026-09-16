/** Shared plumbing: env, hashing, atomic state, WAL, retrying fetch, recency math. */
import { createHash } from "crypto";
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, appendFileSync } from "fs";
import { join, dirname } from "path";

// ---------- env (.env loaded explicitly — never rely on the shell) ----------
export function loadEnv(dir: string): void {
  const p = join(dir, ".env");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

export const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function atomicWrite(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

// ---------- run state (GEX pattern: stages resumed from state + artifacts) ----------
export type StageStatus = "pending" | "done" | "failed" | "skipped";
export type StageState = { status: StageStatus; rows?: number; started?: string; finished?: string; error?: string };
export type RunState = { config_sha: string; run_id: string; stages: Record<string, StageState>; created: string };

export function loadState(runDir: string, stages: readonly string[], configSha: string): RunState {
  const p = join(runDir, "state.json");
  if (existsSync(p)) {
    const st: RunState = JSON.parse(readFileSync(p, "utf8"));
    if (st.config_sha !== configSha) {
      throw new Error(
        `lane config changed since this run started (state ${st.config_sha}, file ${configSha}).\n` +
        `Start a new --run-dir, or pass --accept-config-change to re-judge from the first judged stage.`);
    }
    for (const s of stages) if (!st.stages[s]) st.stages[s] = { status: "pending" };
    return st;
  }
  const st: RunState = {
    config_sha: configSha,
    run_id: `run_${Date.now().toString(36)}`,
    stages: Object.fromEntries(stages.map((s) => [s, { status: "pending" as StageStatus }])),
    created: new Date().toISOString(),
  };
  atomicWrite(p, JSON.stringify(st, null, 2));
  return st;
}

export const saveState = (runDir: string, st: RunState) =>
  atomicWrite(join(runDir, "state.json"), JSON.stringify(st, null, 2));

// ---------- write-ahead log: every verdict appended as one NDJSON line ----------
export function walAppend(runDir: string, record: object): void {
  mkdirSync(runDir, { recursive: true });
  appendFileSync(join(runDir, "verdicts.wal.ndjson"), JSON.stringify(record) + "\n");
}

export function readNdjson<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}
export function writeNdjson(path: string, rows: object[]): void {
  atomicWrite(path, rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));
}

// ---------- fetch with backoff (429/5xx, honors Retry-After) ----------
export async function fetchJson(url: string, init: RequestInit, tries = 5): Promise<any> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, init);
      if (r.status === 429 || r.status >= 500) {
        const ra = Number(r.headers.get("retry-after")) || 0;
        await sleep(Math.max(ra * 1000, 1000 * 2 ** i + Math.random() * 300));
        lastErr = new Error(`HTTP ${r.status}`);
        continue;
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
      return await r.json();
    } catch (e) {
      lastErr = e;
      await sleep(1000 * 2 ** i + Math.random() * 300);
    }
  }
  throw lastErr;
}

// ---------- simple rate limiter ----------
export function limiter(perSecond: number) {
  let stamps: number[] = [];
  return async () => {
    for (;;) {
      const now = Date.now();
      stamps = stamps.filter((t) => t > now - 1000);
      if (stamps.length < perSecond) { stamps.push(now); return; }
      await sleep(1050 - (now - stamps[0]));
    }
  };
}

// ---------- recency + seniority ----------
export const SENIOR_TOKENS = ["chief", "vp", "vice president", "head", "director", "president",
  "directeur", "direktor", "geschäftsführer", "leiter", "responsable", "jefe", "direttore",
  "dyrektor", "hoofd"];
export const SENIOR = /chief|\bvp\b|vice president|head|director|president|directeur|direktor|geschäftsführ|leiter|responsable|jefe|direttore|dyrektor|hoofd/i;
export const EXCLUDE = /executive assistant|\bea to\b|assistant to|chief of staff|deputy|intern\b|chef de partie|chef de cuisine|sous chef|head chef|pastry/i;
export const TITLE_BAN = /\bfounder\b|\bceo\b|\bowner\b|(?<!vice )\bpresident\b/i;

/** Months since YYYY-MM; null when unparseable. */
export function monthsAgo(ds: string | undefined | null): number | null {
  const m = /^(\d{4})-(\d{2})/.exec(ds ?? "");
  if (!m) return null;
  const t = new Date();
  return (t.getFullYear() - Number(m[1])) * 12 + (t.getMonth() + 1 - Number(m[2]));
}
/** The clamp matters: a future start date yields negative months and must NOT pass. */
export const isRecent = (months: number | null, max: number) =>
  months !== null && months >= 0 && months <= max;

export const cleanDomain = (d: string) =>
  (d ?? "").toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "").trim();

export function csvEscape(v: unknown): string {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export function writeCsv(path: string, header: string[], rows: Record<string, unknown>[]): void {
  const lines = [header.join(",")].concat(rows.map((r) => header.map((h) => csvEscape(r[h])).join(",")));
  atomicWrite(path, lines.join("\n") + "\n");
}
