# Senior Joiner Pipeline

Find companies that just hired a senior leader — and turn those people into qualified leads. New executives change vendors, build teams, and spend budget in their first months. This pipeline harvests **recent senior joiners**, then qualifies them in four steps you control.

This repo is built to be **handed to Claude Code** (or any coding agent): open it in the repo, say *"walk me through this"*, and the agent will explain each step, help you fill in the two qualification prompts, and run the pipeline with you.

## The four steps

```
1. harvest seniors      → pull people with senior titles (VP, Head, Director, C-level,
                          plus non-English equivalents) from your data provider
2. keep recent joiners  → compute months-in-role client-side, keep ≤ N months
3. company gate         → qualify the COMPANY each person works at
4. title gate           → qualify the PERSON's title against your buyer profile
```

Steps 3 and 4 each come in **two flavors, and the agent will offer you both**:

- **LLM gate** — a prompt template with blanks (`prompts/company_gate.txt`, `prompts/title_gate.txt`). You describe what you sell and who buys it; a cheap model scores each candidate. Costs money (fractions of a cent per lead), handles fuzzy judgments ("is this a logistics company?").
- **Deterministic gate** — no LLM at all. Step 3 can filter on the joined company attributes (industry, size, country) with plain SQL; step 4 can filter titles with token/regex matching. Free, instant, reproducible — and often enough when your qualifier is crisp ("industry = manufacturing", "title contains supply chain").

Mix them: deterministic first to shrink the pool, LLM only on what's left.

## Why "recent joiner" is a real signal

A signal has to be a **dated event that discriminates within your market** — not a static attribute. "Company has a VP of Ops" describes half the market. "Company's VP of Ops started 4 months ago" is dated, checkable, and correlates with new-vendor evaluation windows. The `months` column keeps every lead sortable by freshness.

## Setup

```bash
git clone https://github.com/danieluszta/senior-joiner-pipeline.git
cd senior-joiner-pipeline
pip install -r requirements.txt   # stdlib only — nothing installs today
cp env.example .env               # add your keys — .env is gitignored
```

You need:
- **A people-data provider** — any API or export that gives you people with titles, current-role start dates, and their companies (most LinkedIn-data vendors do). Wire yours into `pipeline/provider.py` (one function). No provider? `step1` also imports a CSV export.
- **An LLM API key** — only if you use the LLM gates.

Try it without either: `data/sample_joiners.csv` contains 40 synthetic rows.

```bash
python3 pipeline/step1_harvest.py --csv data/sample_joiners.csv
python3 pipeline/step2_recent.py --max-months 9
python3 pipeline/step3_company_gate.py --where "industry LIKE '%software%' AND size_max <= 500"
python3 pipeline/step4_title_gate.py --tokens operations,ops,supply,logistics
```

## Provider lessons (learned the hard way)

- Many providers have **no input filter for job start date** — it's output-only. Recency filtering must happen client-side; that's why step 2 exists as its own step.
- Providers that return a person's whole career history will hand you a **past** role if you grab the first array entry. Always select the *current* role whose title matches your senior pattern.
- Provider-side "seniority" or "function" tags lose real buyers (tag recall can drop ~30% of them). Match on **title tokens** instead; tags are a convenience, not ground truth.
- Non-English titles are invisible to English keyword filters. The harvest pattern includes common European equivalents (Geschäftsführer, directeur, dyrektor, …) — extend `SENIOR_TOKENS` for your markets.

## What's deliberately NOT here

**No real people.** The sample data is synthetic. Harvested data stays in your local SQLite file (`leads.db`, gitignored — as is `.env`).

Names, employers, titles, and start dates are **personal data under GDPR even without email addresses** — a person is identifiable from name + employer alone. Keeping a prospecting database with a lawful-basis argument (legitimate interest, B2B context) is one thing; **republishing those people in a public repo is another**, and you have no basis for it. So: run the pipeline, keep the output private, and never commit `leads.db`. The agent instructions repeat this rule.

## Repo map

| File | What it is |
|------|------------|
| `CLAUDE.md` / `AGENTS.md` | Operating instructions for the agent running the pipeline |
| `pipeline/provider.py` | The one function to adapt to your data provider |
| `pipeline/db.py` | SQLite schema: `people` + `companies`, joined by domain |
| `pipeline/step1_harvest.py` | Senior-title harvest (API or CSV import) |
| `pipeline/step2_recent.py` | Client-side recency filter |
| `pipeline/step3_company_gate.py` | Company qualification — LLM or SQL `--where` |
| `pipeline/step4_title_gate.py` | Title qualification — LLM or `--tokens` |
| `prompts/company_gate.txt` | Blanked company-judging prompt (you fill the blanks) |
| `prompts/title_gate.txt` | Blanked title-judging prompt |
| `data/sample_joiners.csv` | 40 synthetic rows to test the pipeline |

## License

MIT
