#!/usr/bin/env tsx
/** Orchestrator for the senior-joiner pipeline. Two modes (lane.json "mode"):
 *
 *   companies — the user has a verified list of target companies. We find recent
 *               senior joiners AT those companies and gate their titles.
 *               Stages: PRECHECK → PULL → RECENT → CHANGE_TYPE → TITLE_GATE → FINALIZE
 *
 *   titles    — no list. The user names the titles they sell to; we pull those
 *               people market-wide and judge each DISTINCT company with gpt-5-nano.
 *               Stages: PRECHECK → PULL → RECENT → CHANGE_TYPE → COMPANY_JUDGE
 *                       → (TITLE_GATE if lane.title_judge) → FINALIZE
 *
 * GEX-pattern run mechanics: state.json resumability, config-hash guard, run lock,
 * verdict WAL, per-stage artifacts in --run-dir. Pilot runs: --limit=N.
 *
 * Usage: npx tsx scripts/run.ts --config=lane.json [--run-dir=runs/acme] [--limit=25]
 *        [--accept-config-change] [--steal-lock]
 */
import { readFileSync, existsSync, mkdirSync, rmdirSync } from "fs";
import { join, dirname, resolve } from "path";
import {
  loadEnv, sha, loadState, saveState, walAppend, readNdjson, writeNdjson, writeCsv,
  SENIOR, EXCLUDE, TITLE_BAN, SENIOR_TOKENS, monthsAgo, isRecent, cleanDomain, RunState,
} from "./lib";
import * as blitz from "./blitz";
import { fillTemplate, judgeBatch, judgeOne } from "./nano";
import { upsertRows } from "./db";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..");
loadEnv(ROOT);

// ---------- args + config ----------
const argv = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  return m ? [m[1], m[2] ?? "true"] : [a, "true"];
}));
if (!argv.config) { console.error("Usage: npx tsx scripts/run.ts --config=lane.json [--run-dir=DIR] [--limit=N]"); process.exit(2); }

type Lane = {
  mode: "companies" | "titles";
  what_you_sell: string; audience?: string; buyer_profile?: string;
  domains_file?: string; buyer_titles?: string[];
  country?: string; employee_ranges?: string[]; industries?: string[];
  max_months?: number; title_judge?: boolean; exclude_top_titles?: boolean;
};
const configRaw = readFileSync(argv.config, "utf8");
const lane: Lane = JSON.parse(configRaw);
const MAX_MONTHS = lane.max_months ?? 9;
const LIMIT = argv.limit ? Number(argv.limit) : Infinity;
const runDir = argv["run-dir"] ?? join(ROOT, "runs", sha(configRaw).slice(0, 8));
mkdirSync(runDir, { recursive: true });

// precondition checks live here, not scattered
function precheck(): void {
  if (!["companies", "titles"].includes(lane.mode)) throw new Error(`lane.mode must be "companies" or "titles"`);
  if (!lane.what_you_sell) throw new Error("lane.what_you_sell is required (fills the judge prompts)");
  if (lane.mode === "companies" && !lane.domains_file) throw new Error("companies mode needs lane.domains_file");
  if (lane.mode === "companies" && !lane.buyer_profile) throw new Error("companies mode needs lane.buyer_profile (title gate)");
  if (lane.mode === "titles" && !lane.buyer_titles?.length) throw new Error("titles mode needs lane.buyer_titles");
  if (lane.mode === "titles" && !lane.audience) throw new Error("titles mode needs lane.audience (company judge)");
  if (!process.env.BLITZ_API_KEY) throw new Error("BLITZ_API_KEY not set");
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY not set (judges run on gpt-5-nano)");
}

// ---------- state + lock ----------
const STAGES = ["PRECHECK", "PULL", "RECENT", "CHANGE_TYPE", "COMPANY_JUDGE", "TITLE_GATE", "FINALIZE"] as const;
type Stage = (typeof STAGES)[number];
const configSha = sha(configRaw);
let state: RunState;
try { state = loadState(runDir, STAGES, configSha); }
catch (e: any) {
  if (argv["accept-config-change"]) {
    const st: RunState = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    for (const s of ["COMPANY_JUDGE", "TITLE_GATE", "FINALIZE"]) st.stages[s] = { status: "pending" };
    st.config_sha = configSha; saveState(runDir, st); state = st;
    console.log("config change accepted — judged stages invalidated");
  } else { console.error(`FATAL: ${e.message}`); process.exit(2); }
}
const lockDir = join(runDir, "run.lock.d");
try { mkdirSync(lockDir); } catch {
  if (!argv["steal-lock"]) { console.error(`FATAL: run already in progress (${lockDir}). --steal-lock to override.`); process.exit(2); }
}
process.on("exit", () => { try { rmdirSync(lockDir); } catch {} });

async function stage(name: Stage, fn: () => Promise<number | "skipped">): Promise<void> {
  const st = state.stages[name];
  if (st.status === "done" || st.status === "skipped") { console.log(`[${name}] ${st.status} (${st.rows ?? "-"} rows)`); return; }
  st.status = "pending"; st.started = new Date().toISOString(); saveState(runDir, state);
  try {
    const out = await fn();
    if (out === "skipped") st.status = "skipped";
    else { st.status = "done"; st.rows = out; }
  } catch (e: any) {
    st.status = "failed"; st.error = String(e?.message ?? e).slice(0, 300); saveState(runDir, state);
    console.error(`[${name}] FAILED: ${st.error}`);
    process.exit(1);
  }
  st.finished = new Date().toISOString(); saveState(runDir, state);
  console.log(`[${name}] ${state.stages[name].status} (${state.stages[name].rows ?? "-"} rows)`);
}

// ---------- row shape ----------
type Row = {
  person_linkedin: string; full_name: string; title: string; job_start_date: string;
  months?: number | null; company_name: string; company_linkedin: string; company_domain: string;
  role_change_type?: string; prior_title?: string; prior_company?: string;
  company_pass?: boolean | null; company_why?: string; title_pass?: boolean | null; title_why?: string;
  experiences?: blitz.Experience[];
};
const A = {
  pull: join(runDir, "pull.ndjson"), recent: join(runDir, "recent.ndjson"),
  change: join(runDir, "change.ndjson"), companies: join(runDir, "companies.ndjson"),
  titled: join(runDir, "titled.ndjson"), out: join(runDir, "qualified.csv"),
};

// select the CURRENT experience whose title matches; never experiences[0]
function currentExp(p: blitz.Person, matcher: (t: string) => boolean): blitz.Experience | null {
  const exps = p.experiences ?? [];
  const current = exps.filter((e) => e.job_is_current);
  return current.find((e) => matcher(e.job_title ?? "")) ?? null;
}

function toRow(p: blitz.Person, exp: blitz.Experience, domainOverride?: string): Row | null {
  if (!p.linkedin_url) return null;
  return {
    person_linkedin: p.linkedin_url, full_name: p.full_name ?? "",
    title: (exp.job_title ?? "").trim(), job_start_date: exp.job_start_date ?? "",
    company_name: exp.company_name ?? "", company_linkedin: exp.company_linkedin_url ?? "",
    company_domain: domainOverride ?? cleanDomain(exp.company_domain ?? ""),
    experiences: (p.experiences ?? []).map((e) => ({
      job_title: e.job_title, job_start_date: e.job_start_date, job_is_current: e.job_is_current,
      company_name: e.company_name, company_linkedin_url: e.company_linkedin_url,
    })),
  };
}

// ---------- stages ----------
async function pull(): Promise<number> {
  const rows: Row[] = []; const seen = new Set<string>();
  const keep = (r: Row | null) => {
    if (r && r.title && !EXCLUDE.test(r.title) && !seen.has(r.person_linkedin)) { seen.add(r.person_linkedin); rows.push(r); }
  };
  if (lane.mode === "companies") {
    const text = readFileSync(lane.domains_file!, "utf8").trim().split("\n");
    const header = text[0].split(",").map((c) => c.replace(/"/g, "").trim());
    const idx = header.indexOf("company_domain");
    const domains = (idx >= 0 ? text.slice(1).map((l) => l.split(",")[idx]) : text).map(cleanDomain).filter(Boolean);
    console.log(`[PULL] ${domains.length} target companies`);
    for (const d of domains) {
      if (rows.length >= LIMIT) break;
      try {
        const li = await blitz.domainToLinkedin(d);
        if (!li) { console.log(`  ${d}: no LinkedIn match, skipped`); continue; }
        for await (const p of blitz.employeesOf(li)) {
          const exp = currentExp(p, (t) => SENIOR.test(t));
          keep(exp ? toRow(p, exp, d) : null);
          if (rows.length >= LIMIT) break;
        }
      } catch (e: any) { console.log(`  ${d}: pull error after retries (${String(e?.message).slice(0, 80)}) — skipped, not fatal`); }
    }
  } else {
    const buyerTokens = lane.buyer_titles!.map((t) => t.toLowerCase());
    const matcher = (t: string) => { const lo = t.toLowerCase(); return buyerTokens.some((b) => lo.includes(b)); };
    for await (const p of blitz.searchPeople({
      titles: lane.buyer_titles!, country: lane.country ?? "US",
      employeeRanges: lane.employee_ranges ?? ["11-50", "51-200", "201-500"],
      industries: lane.industries,
    })) {
      const exp = currentExp(p, matcher); // search matches PAST roles too; gate on the current one
      keep(exp ? toRow(p, exp) : null);
      if (rows.length >= LIMIT) break;
    }
  }
  writeNdjson(A.pull, rows);
  return rows.length;
}

async function recent(): Promise<number> {
  const rows = readNdjson<Row>(A.pull);
  let undated = 0;
  const kept = rows.filter((r) => {
    r.months = monthsAgo(r.job_start_date);
    if (r.months === null) undated++;
    return isRecent(r.months, MAX_MONTHS);
  });
  console.log(`[RECENT] ≤${MAX_MONTHS}mo: ${kept.length} | dropped: ${rows.length - kept.length} (${undated} undated)`);
  writeNdjson(A.recent, kept);
  return kept.length;
}

// step 2b — deterministic new-hire vs promotion (no LLM; see pipeline-guide.md)
const liSlug = (url: string) => (url ?? "").toLowerCase().replace(/\/+$/, "").split("/").pop() ?? "";
async function changeType(): Promise<number> {
  const rows = readNdjson<Row>(A.recent);
  for (const r of rows) {
    let exps = r.experiences ?? [];
    if (exps.length < 2) { try { exps = await blitz.personEnrich(r.person_linkedin); } catch { /* keep what we have */ } }
    const slug = liSlug(r.company_linkedin);
    const atCompany = exps.filter((e) =>
      (slug && liSlug(e.company_linkedin_url ?? "") === slug) ||
      (!!r.company_name && (e.company_name ?? "").trim().toLowerCase() === r.company_name.trim().toLowerCase()));
    const starts = atCompany.map((e) => monthsAgo(e.job_start_date)).filter((m): m is number => m !== null);
    const earliest = starts.length ? Math.max(...starts) : null; // months ago: bigger = earlier
    if (atCompany.length === 0) r.role_change_type = "unknown";
    else if (atCompany.length >= 2 || (earliest !== null && r.months !== null && earliest > (r.months ?? 0) + 2))
      r.role_change_type = "promotion";
    else r.role_change_type = "new_hire";
    const prior = exps.filter((e) => !e.job_is_current)
      .sort((a, b) => (monthsAgo(a.job_start_date) ?? 9999) - (monthsAgo(b.job_start_date) ?? 9999))[0];
    r.prior_title = prior?.job_title ?? ""; r.prior_company = prior?.company_name ?? "";
    delete r.experiences; // history served its purpose; keep artifacts lean
  }
  const promo = rows.filter((r) => r.role_change_type === "promotion").length;
  console.log(`[CHANGE_TYPE] promotions: ${promo} | new hires: ${rows.filter((r) => r.role_change_type === "new_hire").length} | unknown: ${rows.filter((r) => r.role_change_type === "unknown").length}`);
  writeNdjson(A.change, rows);
  return rows.length;
}

async function companyJudge(): Promise<number | "skipped"> {
  if (lane.mode === "companies") return "skipped"; // the user's list IS the verification
  const rows = readNdjson<Row>(A.change);
  const byKey = new Map<string, Row[]>();
  for (const r of rows) {
    const k = r.company_domain || liSlug(r.company_linkedin);
    if (!k) { r.company_pass = false; r.company_why = "no company key"; continue; }
    (byKey.get(k) ?? byKey.set(k, []).get(k)!).push(r);
  }
  const companies = [...byKey.entries()].map(([key, people]) => ({ key, people, name: people[0].company_name, linkedin: people[0].company_linkedin, domain: people[0].company_domain }));
  console.log(`[COMPANY_JUDGE] ${companies.length} DISTINCT companies (one verdict each, propagated to ${rows.length} people)`);
  const enriched: { key: string; name: string; domain: string; size: string; about: string }[] = [];
  for (const c of companies) {
    let about = "", size = "";
    if (c.linkedin) { try { const e = await blitz.companyEnrich(c.linkedin); about = e?.about ?? ""; size = e?.size ?? ""; } catch { /* judge on what we have */ } }
    enriched.push({ key: c.key, name: c.name, domain: c.domain, size, about });
  }
  for (let i = 0; i < enriched.length; i += 10) {
    const chunk = enriched.slice(i, i + 10);
    const block = chunk.map((c, j) => `${j + 1}. ${c.name || c.key} (${c.domain || "?"}) | size: ${c.size || "?"} | about: ${c.about.slice(0, 300)}`).join("\n");
    const { prompt, promptSha } = fillTemplate(join(ROOT, "prompts", "company_gate.txt"),
      { WHAT_YOU_SELL: lane.what_you_sell, AUDIENCE: lane.audience!, COMPANIES: block });
    const scores = await judgeBatch(prompt, "scores", chunk.length);
    chunk.forEach((c, j) => {
      const s = scores?.[j];
      const pass = scores === null ? null : (typeof s === "number" && s >= 2);
      for (const r of byKey.get(c.key) ?? []) { r.company_pass = pass; r.company_why = scores === null ? "unjudged:batch_invalid" : `llm_score:${s}`; }
      walAppend(runDir, { kind: "company", key: c.key, verdict: pass, score: s ?? null, prompt_sha: promptSha, run_id: state.run_id, at: new Date().toISOString() });
    });
    if (scores === null) console.log(`  batch ${i / 10 + 1}: invalid model output twice — ${chunk.length} companies left UNJUDGED (reported, not guessed)`);
  }
  writeNdjson(A.change, rows);
  const passed = companies.filter((c) => byKey.get(c.key)?.[0].company_pass).length;
  console.log(`[COMPANY_JUDGE] passed: ${passed}/${companies.length} companies`);
  return companies.length;
}

async function titleGate(): Promise<number | "skipped"> {
  if (lane.mode === "titles" && !lane.title_judge) return "skipped"; // search titles were the user's own
  const rows = readNdjson<Row>(A.change).filter((r) => lane.mode === "companies" || r.company_pass);
  // free deterministic prefilter: one nano call derives buying-function tokens
  const FUNCTIONS: Record<string, string[]> = {
    compliance_risk: ["compliance", "risk", "aml", "fraud", "regulatory", "audit", "kyc"],
    operations: ["operations", "ops", "plant", "production", "manufacturing", "supply chain", "maintenance", "facilities", "logistics", "quality"],
    finance: ["finance", "financial", "cfo", "treasury", "accounting", "controller"],
    marketing: ["marketing", "brand", "growth", "digital", "ecommerce", "e-commerce"],
    engineering_it: ["engineering", "technology", "cto", "information", "it ", "software", "infrastructure", "security", "data"],
    hr: ["hr", "people", "human resources", "talent"],
    sales: ["sales", "revenue", "commercial", "business development"],
  };
  let toks: string[] = [];
  try {
    const v = await judgeOne(
      `A vendor sells ${lane.what_you_sell} to ${lane.audience ?? lane.buyer_profile}. Which functions BUY this? ` +
      `Pick 1-3 keys from ${JSON.stringify(Object.keys(FUNCTIONS))} and add up to 6 extra title words specific to this product.\n` +
      `Return JSON: {"functions": ["..."], "extra_tokens": ["..."]}`);
    for (const f of v?.functions ?? []) toks.push(...(FUNCTIONS[f] ?? []));
    toks.push(...(v?.extra_tokens ?? []).map((t: string) => String(t).toLowerCase()));
  } catch { /* fall through to keep-all */ }
  let pre = toks.length ? rows.filter((r) => toks.some((t) => r.title.toLowerCase().includes(t))) : rows;
  if (!pre.length) { console.log("[TITLE_GATE] prefilter kept nothing — passing all through (bad token set must not zero the run)"); pre = rows; }
  if (lane.exclude_top_titles !== false) pre = pre.filter((r) => !TITLE_BAN.test(r.title));
  for (let i = 0; i < pre.length; i += 10) {
    const chunk = pre.slice(i, i + 10);
    const block = chunk.map((r, j) => `${j + 1}. ${r.title.slice(0, 70)} @ ${r.company_name || r.company_domain}`).join("\n");
    const { prompt, promptSha } = fillTemplate(join(ROOT, "prompts", "title_gate.txt"),
      { WHAT_YOU_SELL: lane.what_you_sell, BUYER_PROFILE: lane.buyer_profile ?? lane.audience ?? "", TITLES: block });
    const owns = await judgeBatch(prompt, "owns", chunk.length);
    chunk.forEach((r, j) => {
      r.title_pass = owns === null ? null : owns[j] === true;
      r.title_why = owns === null ? "unjudged:batch_invalid" : (owns[j] === true ? "llm:owns" : "llm:not_owner");
      walAppend(runDir, { kind: "title", person: r.person_linkedin, verdict: r.title_pass, prompt_sha: promptSha, run_id: state.run_id, at: new Date().toISOString() });
    });
  }
  const all = readNdjson<Row>(A.change);
  const byId = new Map(pre.map((r) => [r.person_linkedin, r]));
  writeNdjson(A.titled, all.map((r) => byId.get(r.person_linkedin) ?? r));
  const passed = pre.filter((r) => r.title_pass).length;
  console.log(`[TITLE_GATE] tokens: [${toks.slice(0, 10).join(", ")}${toks.length > 10 ? ", …" : ""}] | judged ${pre.length}, passed ${passed}`);
  return pre.length;
}

async function finalize(): Promise<number> {
  const src = existsSync(A.titled) ? A.titled : A.change;
  const rows = readNdjson<Row>(src);
  const qualified = rows.filter((r) =>
    (lane.mode === "companies" || r.company_pass) &&
    (state.stages.TITLE_GATE.status === "skipped" || r.title_pass));
  const header = ["full_name", "title", "months", "role_change_type", "prior_title",
    "person_linkedin", "company_name", "company_domain", "company_why", "title_why"];
  writeCsv(A.out, header, qualified as any);
  upsertRows("joiners",
    ["person_linkedin", "full_name", "title", "job_start_date", "months", "company_domain",
     "company_name", "company_linkedin", "recent", "role_change_type", "prior_title", "prior_company", "title_pass", "title_why"],
    "person_linkedin",
    rows.map((r) => ({ ...r, recent: true })));
  const funnel = [
    `pulled ${state.stages.PULL.rows}`, `recent ${state.stages.RECENT.rows}`,
    state.stages.COMPANY_JUDGE.status === "skipped" ? "company judge skipped (verified list)" : `companies judged ${state.stages.COMPANY_JUDGE.rows}`,
    state.stages.TITLE_GATE.status === "skipped" ? "title gate skipped (user's own titles)" : `titles judged ${state.stages.TITLE_GATE.rows}`,
    `QUALIFIED ${qualified.length}`,
  ].join(" → ");
  console.log(`\n${funnel}\n-> ${A.out}  (contains personal data — keep it PRIVATE, never commit)`);
  return qualified.length;
}

// ---------- main ----------
(async () => {
  await stage("PRECHECK", async () => { precheck(); return 0; });
  await stage("PULL", pull);
  await stage("RECENT", recent);
  await stage("CHANGE_TYPE", changeType);
  await stage("COMPANY_JUDGE", companyJudge);
  await stage("TITLE_GATE", titleGate);
  await stage("FINALIZE", finalize);
})();
