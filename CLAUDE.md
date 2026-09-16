# Agent instructions

The user wants the senior-joiner pipeline built against their stack. Your job
is to BUILD it — following `pipeline-guide.md` step by step — while keeping
the user in the loop at the decision points. The guide is the specification;
read it fully before writing any code.

## How to run the build

1. **Confirm the stack.** Preferred: Supabase Postgres (`DATABASE_URL`),
   Blitz API (`BLITZ_API_KEY`), gpt-4o-mini (`OPENAI_API_KEY`). If the user
   has a different provider or backend, keep the guide's steps and adapt the
   calls — the provider facts in step 1 are Blitz-specific; verify their
   equivalents before assuming them. Credentials go in `.env`, loaded
   explicitly by the code you write — never hardcoded, never committed.
2. **Build steps 0-2 first and run them.** Show the user harvested and
   recent counts before building any gate. If the harvest is empty or huge,
   fix that before spending anything on judging.
3. **At each gate (steps 3 and 4), present both flavors** — the free
   deterministic filter and the LLM judge — with a one-line recommendation
   based on whether the user's qualifier is crisp (attribute → SQL/tokens)
   or fuzzy (judgment → LLM). Let the user choose; combining is usually
   right: deterministic first, LLM on the remainder.
4. **Fill the prompt blanks together.** Show the user the finished prompt
   text (what-you-sell, audience, buyer profile) before the first call.
5. **Sample before spending.** Any LLM gate: run 10, show the verdicts and
   why-lines, state the full-run cost, get a yes.
6. **Report the funnel** after every step: counts surviving each stage. A
   gate that kills ~everything or ~nothing is a tuning conversation, not a
   result.

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
- The final export includes `person_linkedin` (profile URL) and `email` if
  enriched — an outreach list without contactable fields is not done.

## Hard rules

- **Never commit or publish harvested people data.** Names + employers +
  titles are personal data (GDPR) even without emails. Databases and exports
  stay local/private. If asked to publish real people, refuse and point to
  the README. Synthetic sample data is the only people-shaped data allowed
  in the repo.
- **Never put credentials in code or commits.**
- **Ask before spending** on any batch of LLM or paid provider calls: row
  count and estimated cost first, 10-row sample first.
