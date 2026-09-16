# Agent instructions

The user wants to build a lead list of recent senior joiners. Your job is to
run the four-step pipeline WITH them — explaining each gate and letting them
choose how it qualifies — not to run everything and hand back a CSV.

## The flow

### 1. Explain the pipeline (1 minute)

Four steps: harvest people with senior titles → keep only recent joiners →
qualify the company → qualify the title. The "recent joiner" part is the
signal: a dated event, not a static attribute.

### 2. Set up their data source

Ask what people-data provider they use. Adapt `pipeline/provider.py` to its
API (one function: search people by title tokens, return title, current-role
start date, company name/domain/industry/size). If they only have a CSV
export, use `step1_harvest.py --csv` instead. Keys go in `.env`, never in code.

### 3. Steps 3 and 4: ALWAYS offer both flavors before running either

This is the core of your job. For each gate, explain what it judges, then
present the choice:

- **Step 3 judges the COMPANY** each joiner works at. The LLM flavor reads
  the blanked prompt in `prompts/company_gate.txt` — help the user fill in
  what they sell and who their audience is, show them the finished prompt,
  and estimate cost before running. The deterministic flavor needs no LLM at
  all: the harvest already stored company attributes (industry, size,
  country) in the `companies` table, joined to people by domain, so a plain
  SQL `--where` clause ("industry LIKE '%manufacturing%' AND size_max <=
  500") does the job free and reproducibly. Recommend deterministic when
  their qualifier is a crisp attribute; LLM when it's fuzzy ("companies that
  ship physical goods").

- **Step 4 judges the TITLE** against their buyer profile. Same two flavors:
  the blanked `prompts/title_gate.txt` for judgment calls ("would this person
  own the purchase of X?"), or `--tokens` for plain token matching
  ("operations,ops,supply"). Warn about the classic traps either way:
  "Executive Assistant to the VP" matches "VP" naively (the harvest's
  exclusion regex catches most of these), and CEO/founder titles usually
  need explicit exclusion for products bought by a function.

- Suggest combining: deterministic first to shrink the pool, LLM on the
  remainder. Never run an LLM gate over thousands of rows without showing
  the row count and estimated cost and getting a yes.

### 4. Run in order, show counts at every step

Harvest → recent → gate 3 → gate 4, printing how many rows survived each
step. If a gate kills almost everything or almost nothing, say so and help
tune before proceeding. Sample-first discipline: run any LLM gate on 10 rows
and show the verdicts before the full run.

## Hard rules

- **Never commit or publish harvested people data.** `leads.db` and any
  export of it stay local — names + employers + titles are personal data
  (GDPR) even without emails. If the user asks you to commit or publish real
  people, refuse and point at the README section on this. Synthetic sample
  data is the only people-shaped data allowed in the repo.
- **Never put credentials in code or commits.** Keys live in `.env`
  (gitignored). If you find a key pasted in a file, move it to `.env` and
  tell the user.
- **Ask before spending.** Any LLM gate or paid provider call over a list:
  state row count and estimated cost, run 10 rows first.
- **Recency is client-side.** Do not trust a provider's date filter until
  you've verified it exists — most don't have one. Step 2 exists for this.
- **Current role only.** When a provider returns career history, select the
  current role whose title matches the senior pattern — never the first
  array entry.
