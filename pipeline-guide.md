# The pipeline guide

Step-by-step instructions for an agent to **build** the senior-joiner pipeline against the preferred stack: **Supabase (Postgres) as the backend, Blitz API as the lead provider, gpt-4o-mini as the judge** (cheapest model that judges company/title fit reliably; swap equivalents freely). Every step says what to build, why it exists, and the exact prompt or pattern to use.

Credentials come from the environment: `DATABASE_URL`, `BLITZ_API_KEY`, `OPENAI_API_KEY` (see `env.example`). Make loading `.env` an explicit part of whatever you build — don't assume the shell did it.

---

## Step 0 — Infrastructure

Create two tables plus a resume-state table in Supabase:

```sql
CREATE TABLE IF NOT EXISTS joiners (
  person_linkedin  text PRIMARY KEY,     -- profile URL: stable ID AND outreach field
  full_name        text,
  title            text,
  job_start_date   text,                 -- YYYY-MM from the provider
  months           int,                  -- step 2
  company_domain   text,
  company_name     text,
  company_linkedin text,
  email            text,                 -- step 5, optional
  recent           boolean,
  role_change_type text,                 -- step 2b: 'new_hire' | 'promotion' | 'unknown'
  prior_title      text,
  prior_company    text,
  title_pass       boolean, title_why text,
  harvested_at     timestamptz DEFAULT now(),
  updated_at       timestamptz DEFAULT now()
);
CREATE TABLE IF NOT EXISTS companies (
  domain        text PRIMARY KEY,
  name          text, linkedin_url text,
  industry      text, country text,
  size_min      int,  size_max int,
  about         text,
  company_pass  boolean, company_why text, judged_at timestamptz
);
CREATE TABLE IF NOT EXISTS harvest_state (
  industry text, country text, PRIMARY KEY (industry, country),
  completed_at timestamptz DEFAULT now(), pages int, joiners int
);
```

Build requirements:
- **UPSERT, never INSERT-and-ignore.** A recurring joiner pipeline re-sees people whose role or start date changed and companies with better data. `ON CONFLICT ... DO UPDATE` with `updated_at = now()`, so refreshes win over stale rows.
- **Company verdicts live on `companies`**, not on people — one judgment per domain (see step 3).
- **Retry Supabase writes.** Under parallel writes Supabase drops connections; wrap every write in a retry loop (5-6 attempts, linear backoff) and save incrementally in batches of a few hundred — never accumulate everything and write at the end.
- `harvest_state` makes the harvest resumable per industry: crash mid-run, restart, skip completed industries.

## Step 1 — Download seniors from Blitz

**What:** pull every person whose *current* title is senior, per industry, into `joiners`.

Call `POST /v2/search/people` with title include-filters and company filters, paginated by cursor (50 results/page):

```json
{
  "people":  {"job_title": {"include": ["chief", "vp", "vice president", "head",
              "director", "president", "directeur", "direktor", "geschäftsführer",
              "leiter", "responsable", "jefe", "direttore", "dyrektor", "hoofd"]}},
  "company": {"industry": {"include": ["<one industry per harvest run>"]},
              "hq": {"country_code": ["US"]},
              "employee_range": ["11-50", "51-200", "201-500"]},
  "max_results": 50
}
```

Blitz facts the implementation must respect:
- **There is no input filter for job start date.** `job_start_date` is output-only. Download everyone matching the title filter; recency is filtered client-side in step 2. Do not go hunting for a date parameter.
- **`experiences[]` returns the whole career.** Taking entry `[0]` silently gives you past or side roles. Select the experience with `job_is_current = true` **whose title matches the senior pattern**; fall back to the first current role.
- **Don't use `job_function` / `job_level` tags as the filter.** Tag recall loses roughly 30% of real buyers. Title tokens are the filter; tags are decoration.
- **Filter lists cap at 50 entries.** Chunk longer include-lists across calls.
- Harvest **one industry per call-loop** and record it in `harvest_state` — that is what makes the run resumable and parallelizable (6 industries in parallel is a good default).

After the title match, apply the exclusion regex — titles that contain a senior word but are not senior buyers:

```
executive assistant|\bea to\b|assistant to|chief of staff|deputy|intern\b|
chef de partie|chef de cuisine|sous chef|head chef|pastry
```

Store the person AND upsert their company row (name, domain, LinkedIn, industry, size range) — the join in step 3 depends on it.

## Step 2 — Recency filter (client-side, pure regex)

**What:** compute months-in-role and flag joiners within the window (default ≤ 9 months).

```python
m = re.match(r"(\d{4})-(\d{2})", job_start_date or "")
months = (today.year - int(m.group(1))) * 12 + (today.month - int(m.group(2)))
recent = months is not None and 0 <= months <= MAX_MONTHS
```

Build requirements:
- **Clamp at zero.** A provider glitch can return a future start date; `months <= MAX` alone lets a negative value pass. The test is `0 <= months <= MAX`.
- Missing/unparseable dates are *excluded and counted* — report them, don't silently keep or drop.
- Flag rows (`recent = true/false`), never delete — rerunning with a different window is then just a re-flag.

## Step 2b — New hire or promotion (pure code, no LLM)

**What:** classify every recent joiner as `new_hire` or `promotion`. This matters more than it looks: in one graded new-in-role batch (Growth Engine X's playbook), **8 of 10** "recent joiners" turned out to be internal promotions — and the outreach line differs. "Welcome aboard" copy sent to someone in year six at the company is a credibility kill.

The judgment is deterministic — the career history already contains the answer, so no model decides it:

1. Pull the person's full career history (Blitz `/v2/enrichment/person` returns the experiences list with company, title, start date). If your harvest already stored the full `experiences[]`, reuse it — no second call.
2. Collect their experiences at the matched company. Companies match by **LinkedIn slug**, with company-name equality as the fallback.
3. **Promotion** if either: they have **2 or more roles** listed at that company, or their **earliest start date there is older than the current title's start** (computed from the stored `months`, with a **2-month tolerance** for harvest lag).
4. **New hire** if the current role is their only, recent experience there. **Unknown** if the history shows no matching company at all (rare — 0 of 18 in the test batch).

Store `role_change_type`, plus `prior_title` and `prior_company` from the most recent earlier experience — they feed personalization later.

Copy hazard to carry into any messaging step: a promotion's *direction* is unprovable from history (2+ roles proves an internal move, not a step up). Say "stepped into the seat", never "moved up" or "got promoted"; and never say a promoted person "joined" the company.

## Step 3 — Company gate (join, enrich, judge ONCE per company)

**What:** decide whether each *company* employing a recent joiner fits the user's audience.

Offer the user both flavors, always:

**Deterministic flavor (free, no LLM).** The join to `companies` means crisp qualifiers need no model at all:

```sql
UPDATE companies SET company_pass = (industry ILIKE '%software%' AND size_max <= 500)
WHERE domain IN (SELECT DISTINCT company_domain FROM joiners WHERE recent);
```

Recommend this whenever the qualifier is an attribute (industry, size, country). Combine: deterministic first to shrink the pool, LLM on the remainder.

**LLM flavor.** Build it exactly like this:

1. **Select DISTINCT company domains** from recent joiners that have no verdict yet (`company_pass IS NULL`). Never iterate over people here — five joiners at one company must produce ONE judgment, not five potentially contradictory ones. The verdict is written to `companies` and reaches people through the join.
2. For each domain missing `about`, pull it via Blitz company enrichment (`/v2/enrichment/company-enrich`) and store it. The about text is the judge's main evidence.
3. Batch 10 companies per call to **gpt-4o-mini** (temperature 0) with the prompt in [`prompts/company_gate.txt`](prompts/company_gate.txt) — blanks: `{{WHAT_YOU_SELL}}`, `{{AUDIENCE}}`, `{{COMPANIES}}` (numbered lines: name, domain, industry, size, about[:200-400]).
4. **Validate the output length strictly.** If `scores` doesn't have exactly as many entries as the batch, retry the batch once; if it fails again, leave those rows unjudged (`NULL`) and report the count — never zip short and claim the batch was judged.
5. Write `company_pass = score >= 2`, `company_why = 'llm_score:N'`, `judged_at = now()`.

**Rerun hygiene:** when the user changes the audience definition, clear the old verdicts for the affected scope first (`company_pass = NULL WHERE ...`). A `--limit 10` sample run after a previous full run must not leave a mix of old-criteria and new-criteria verdicts in aggregate counts.

**Sample first, always:** judge 10 companies, show the user the verdicts and the why-lines, get a yes, then run the rest. State the estimated cost before the full run (rows ÷ 10 calls × their model's price).

## Step 4 — Title gate (prefilter free, judge cheap)

**What:** decide whether each surviving person's *title* owns the purchase.

**Deterministic prefilter first (free).** Derive buying-function tokens with ONE cheap call, then string-match stored titles:

```
A vendor sells {{WHAT_YOU_SELL}} to {{AUDIENCE}}. Which functions BUY this?
Pick 1-3 keys from ["compliance_risk", "operations", "finance", "marketing",
"engineering_it", "hr", "sales"] and add up to 6 extra title words specific
to this product (e.g. "chargeback", "dispute").
Return JSON: {"functions": ["..."], "extra_tokens": ["..."]}
```

Each function key expands to a token list (operations → operations, ops, plant, production, supply chain, logistics, quality, …; build the map once). Titles containing any token pass the prefilter. If the prefilter keeps nothing, pass everything through — a bad token set must not silently zero the pipeline.

**LLM judge on the survivors** (or as the sole gate if the user prefers): batch 10 per gpt-4o-mini call with [`prompts/title_gate.txt`](prompts/title_gate.txt) — blanks: `{{WHAT_YOU_SELL}}`, `{{BUYER_PROFILE}}`, `{{TITLES}}`. Same strict output-length validation and rerun hygiene as step 3.

Hard-exclude before the LLM (regex, free): `\bfounder\b|\bceo\b|\bowner\b|(?<!vice )\bpresident\b` for products bought by a function — a CEO "pass" from the model is usually flattery, and these titles reply worst to function-level outreach. Make the exclusion a user choice, default on.

## Step 5 (optional) — Emails, and the export

If the user's Blitz plan includes email enrichment, enrich **before** any further paid judging — only shippable leads deserve model spend. Expect roughly 10-25% hit rate; enrich down the freshness-sorted list until enough shippable leads exist.

The final export must carry the outreach fields, not just the qualification story:

```
full_name, title, months, role_change_type, prior_title, person_linkedin, email,
company_name, company_domain, company_why, title_why
```

`person_linkedin` is the profile URL — it is both the primary key and an outreach field; never drop it from the export.

**The export is personal data.** It stays local/private, never in a repo (see README).

---

## Order and reporting

Run 1 → 2 → 2b → 3 → 4 → (5), printing surviving counts at every step, e.g. `4,812 harvested → 1,102 recent → 214 companies pass → 371 people at passing companies → 88 titles pass → 61 with email`. If any gate kills ~everything or ~nothing, stop and tune with the user before continuing.
