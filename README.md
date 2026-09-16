# Senior Joiner Pipeline

An **instruction set for your coding agent** to build a lead pipeline around one signal: a company just hired a senior leader. New executives change vendors, build teams, and spend budget in their first months — and "months in role" is a dated, checkable fact, not a static attribute.

This repo encodes the **flow, the provider quirks, the judging prompts, and the failure modes** in [`pipeline-guide.md`](pipeline-guide.md) — and ships a working orchestrator for the two standard entry points ([`scripts/`](scripts/), TypeScript, `npx tsx`, no dependencies):

- **`mode: "companies"`** — you already have a verified list of target companies. The pipeline finds recent senior joiners *at those companies* and gates their titles (token prefilter, then a gpt-5-nano ownership judge). No company judging — your list is the verification.
- **`mode: "titles"`** — no list. You name the titles you sell to; the pipeline pulls those people market-wide, then judges each **distinct** company with gpt-5-nano (one verdict per company, propagated to its people).

Both modes filter to **recent joiners** (months-in-role computed client-side, `0 ≤ months ≤ window`) and classify each joiner **new hire vs promotion** deterministically from career history.

```bash
cp env.example .env            # BLITZ_API_KEY, OPENAI_API_KEY, optional DATABASE_URL
npx tsx scripts/run.ts --config=lane.example.titles.json --limit=25   # pilot first
npx tsx scripts/run.ts --config=lane.example.titles.json              # full run
```

Run mechanics are GEX-grade: `state.json` resumability with a config-hash guard (a changed lane config invalidates judged stages instead of silently mixing verdicts), a run lock, exponential backoff on 429/5xx, strict batch validation on every judge call (10 in must mean 10 verdicts out, retried once, then reported unjudged — never silently zipped short), and an append-only WAL where every verdict carries the judge-prompt SHA. Output syncs to Supabase/Postgres when `DATABASE_URL` is set; otherwise the run directory's artifacts are the output. For anything beyond these two modes, hand the guide to your agent and say *"build this against my stack"*.

The agent runs it as a **pilot first, autonomy second**: it will tell you up front that a small batch runs together with you — you approve the harvest sample, the gate criteria, the pilot verdicts, and the first finished leads at fixed checkpoints (CP0–CP7 in [`CLAUDE.md`](CLAUDE.md)) — and only then does it run the full pipeline on its own, with the cost stated and approved.

## The stack it targets

- **Supabase (Postgres)** as the backend — the schema, upsert rules, and connection-retry requirements are in the guide. Any Postgres works.
- **Blitz API** as the lead provider — the guide encodes its real behavior: no input filter on job start date (recency is client-side), whole-career `experiences[]` (current-role selection is mandatory), seniority tags that lose ~30% of real buyers (title tokens are the filter), 50-entry filter caps.
- **gpt-4o-mini** as the judge — the cheapest model that reliably scores company and title fit in batches of 10. Swap in any equivalent.

Different provider or backend? The guide's steps still apply; the agent adapts the calls.

## The flow

```
0. infrastructure   → joiners + companies + harvest_state tables (upserts, retries, resume state)
1. download seniors → Blitz people search by senior-title tokens, per industry, current role only
2. recency filter   → months-in-role regex, client-side, 0 ≤ months ≤ window
3. company gate     → join person→company, dedupe to distinct domains, pull about text,
                      judge ONCE per company (4o-mini, 10/batch) — or free SQL on industry/size
4. title gate       → free token prefilter, then strict buyer-ownership judge — or tokens only
5. emails (optional)→ enrich before further spend; export carries profile URL + email
```

Every LLM gate has a **free deterministic alternative** (SQL over company attributes, title-token matching), and the agent is instructed to offer both before running either.

## What's in the guide that code wouldn't show you

- One judgment **per company**, propagated to its people — never one per person (five joiners at one company must not get five contradicting verdicts).
- Strict LLM output validation: a batch of 10 must return exactly 10 scores, or it retries and then reports unjudged rows — no silent short-zips.
- Rerun hygiene: stale verdicts are cleared when criteria change, so sample runs don't mix old and new judgments.
- Upserts everywhere: a recurring pipeline re-sees people whose roles changed; the fresh data must win.
- The recency clamp (`0 ≤ months`), the current-role trap, the assistant/chef/deputy exclusion regex, sample-10-before-the-full-run cost discipline.

## Files

| File | What it is |
|------|------------|
| [`scripts/run.ts`](scripts/run.ts) | The orchestrator: both modes, staged, resumable (`--config`, `--run-dir`, `--limit`) |
| [`scripts/blitz.ts`](scripts/blitz.ts) / [`scripts/nano.ts`](scripts/nano.ts) | Blitz client (throttle, backoff) and the gpt-5-nano judge (strict batch validation) |
| [`scripts/lib.ts`](scripts/lib.ts) / [`scripts/db.ts`](scripts/db.ts) | State/WAL/recency plumbing; optional Postgres sync via psql |
| [`lane.example.companies.json`](lane.example.companies.json) / [`lane.example.titles.json`](lane.example.titles.json) | Lane configs for the two modes |
| [`pipeline-guide.md`](pipeline-guide.md) | The build instructions: schema, per-step behavior, provider facts, prompts, failure modes |
| [`CLAUDE.md`](CLAUDE.md) / [`AGENTS.md`](AGENTS.md) | How the agent should run the build with the user |
| [`prompts/company_gate.txt`](prompts/company_gate.txt) | Blanked company-judging prompt (score 0–3, batched) |
| [`prompts/title_gate.txt`](prompts/title_gate.txt) | Blanked title-ownership prompt |
| [`data/sample_joiners.csv`](data/sample_joiners.csv) | 40 synthetic rows showing the harvest output shape |
| [`env.example`](env.example) | The three credentials, as environment variables |

## No real people, ever

The sample rows are synthetic (`.example` domains). Names + employer + title + start date are **personal data under GDPR even without email addresses**. Run the pipeline, keep the output in your database and private exports — never commit it, never publish it. `.gitignore` enforces this for the obvious paths and the agent instructions repeat it.

## License

MIT
