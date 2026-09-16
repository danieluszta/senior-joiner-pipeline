# Senior Joiner Pipeline

An **instruction set for your coding agent** to build a lead pipeline around one signal: a company just hired a senior leader. New executives change vendors, build teams, and spend budget in their first months — and "months in role" is a dated, checkable fact, not a static attribute.

This repo contains no finished pipeline code on purpose. Enrichment code is trivial for an agent to write; what's hard to get right is the **flow, the provider quirks, the judging prompts, and the failure modes**. That's what this repo encodes. Open it in Claude Code (or any coding agent), say *"build this against my stack"*, and the agent follows [`pipeline-guide.md`](pipeline-guide.md).

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
