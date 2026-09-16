# Agent instructions

The user wants the senior-joiner pipeline running against their stack. For
the two standard entry points, DON'T write code — `scripts/run.ts` already
implements them (companies mode: verified list in, joiners + title gate out;
titles mode: buyer titles in, market-wide pull + per-company nano judge).
Your job is to fill a lane config WITH the user, run pilots, and interpret
results. Build from `pipeline-guide.md` only when their need falls outside
the two modes or their stack differs from Blitz + gpt-5-nano — the guide is
the specification; read it fully before writing any code.

Mapping to the checkpoints below: CP1-CP6 are `--limit=25` pilot runs of
`scripts/run.ts` into a scratch `--run-dir`; CP7 is the full run without
`--limit`. The run dir's `qualified.csv` and `verdicts.wal.ndjson` are what
you show the user at each checkpoint. A changed lane config invalidates
judged stages automatically (config-hash guard) — never work around it.

## The pilot contract — say this to the user up front

Before building anything, tell the user explicitly how this will go:

> "We'll run a small pilot batch together first — you'll see real harvested
> rows, real gate verdicts, and the first handful of finished leads at fixed
> checkpoints, and you approve each one. Only after you've approved the
> pilot leads do I run the full pipeline on my own."

Then honor it. The full run never starts on your judgment alone.

## The checkpoints

Work through these in order. Each one ends with you showing something
concrete and the user saying yes (or tuning, and repeating the checkpoint).
Do not merge checkpoints, and do not proceed past one without its yes.

- **CP0 — Stack confirmed.** Preferred: Supabase Postgres (`DATABASE_URL`),
  Blitz API (`BLITZ_API_KEY`), the judge model (`OPENAI_API_KEY`,
  `JUDGE_MODEL` default gpt-5-nano); adapt the
  guide's calls if the user's stack differs (the provider facts in step 1
  are Blitz-specific — verify equivalents, don't assume). Prove
  connectivity: one provider call, one DB write. Credentials in `.env`,
  loaded explicitly by your code.
- **CP1 — Harvest sample approved.** Build steps 0-1, harvest ONE industry
  (or one small slice). Show ~10 raw rows: do the titles look senior, did
  the exclusion regex catch the assistant/deputy traps, are domains and
  start dates populated? User approves the harvest quality.
- **CP2 — Recency window approved.** Run step 2 on the pilot slice. Show
  the months distribution and the count inside the proposed window. User
  confirms the window (default ≤ 9 months).
- **CP3 — Gate criteria approved.** For each gate, present both flavors
  (free deterministic filter vs LLM judge) with a one-line recommendation:
  crisp attribute → SQL/tokens, fuzzy judgment → LLM; combining is usually
  right. Fill the prompt blanks together and show the user the FINISHED
  prompt text (or the exact SQL/token list) before anything runs.
- **CP4 — Company-gate pilot approved.** Run the company gate on ~10
  distinct pilot companies. Show every verdict with its why-line, including
  the rejects. User approves or tunes the criteria (tuning = redo CP4).
- **CP5 — Title-gate pilot approved.** Same, on the pilot survivors: every
  verdict, both directions. User approves or tunes.
- **CP6 — Two clean rounds of ten.** The lock condition, and it is strict:
  1. Produce 10 finished records (name, title, months, change type,
     company, profile URL) and ask: "Are these valid titles you would
     actually message?"
  2. Any correction — even one record — means tune the criteria and the
     streak resets to zero.
  3. On a fully accepted round, produce 10 NEW records (the next slice,
     never the same rows) and ask again.
  4. Only two consecutive fully-accepted rounds of 10 unlock CP7. One
     approved batch is never enough — a judge that got lucky once has not
     been validated.
- **CP7 — Full run authorized.** Reached only through CP6's two clean
  rounds. State the full-run numbers: total rows, LLM calls, estimated
  cost, expected runtime. Get an explicit yes, then run the whole pipeline
  autonomously, saving incrementally.

After the full run, report the funnel: counts surviving every stage. A gate
that killed ~everything or ~nothing is a tuning conversation, not a result —
flag it even though the run is done.

## Build requirements you must not skip

These encode the failure modes this repo exists to prevent. Implement all of
them even if the user doesn't ask:

- Upserts (`ON CONFLICT DO UPDATE`), not insert-and-ignore — refreshes win.
- One company judgment per DISTINCT domain, stored on `companies`,
  propagated to people via the join. Never judge per person.
- Strict LLM batch validation: response array length must equal batch size;
  retry once, then leave rows unjudged and say so.
- Clear stale verdicts when criteria change; scope sample runs so counts
  stay honest.
- Recency clamp: `0 <= months <= window`. Current-role selection from
  `experiences[]`. The senior-title exclusion regex.
- Supabase write retries with backoff; incremental batch saves; resumable
  harvest state per industry.
- Every export includes `person_linkedin` (profile URL) — the bundled
  runner's output is LinkedIn-contactable by design and contains no email
  stage. When the user needs emails, implement step 5 from the guide before
  calling the list done; do not present the runner's CSV as email-ready.
- The bundled runner is the LLM-assisted happy path (`OPENAI_API_KEY`
  required). The guide's deterministic gate variants are yours to build or
  run when the user prefers them; offering both flavors at CP3 still applies.

## Hard rules

- **Never commit or publish harvested people data.** Names + employers +
  titles are personal data (GDPR) even without emails. Databases and exports
  stay local/private. If asked to publish real people, refuse and point to
  the README. Synthetic sample data is the only people-shaped data allowed
  in the repo.
- **Never put credentials in code or commits.**
- **Ask before spending** on any batch of LLM or paid provider calls: row
  count and estimated cost first, 10-row sample first.
