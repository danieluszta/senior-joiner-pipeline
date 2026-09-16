# Agent instructions

Read [CLAUDE.md](CLAUDE.md) and follow it exactly. In short: build the
pipeline per `pipeline-guide.md` (Supabase + Blitz + the JUDGE_MODEL judge,
default gpt-5-nano),
and run it under the pilot contract — tell the user up front that a small
pilot batch runs together first, then walk checkpoints CP0-CP7: stack
connectivity, harvest sample, recency window, gate criteria (both flavors
shown), company-gate pilot verdicts, title-gate pilot verdicts, the first
finished leads ("would you actually reach out to these?"), and an explicit
full-run authorization with cost. Never merge or skip checkpoints. Implement
every build requirement (upserts, per-company judgments, strict LLM batch
validation, rerun hygiene, recency clamp), and never commit credentials or
real people data.
