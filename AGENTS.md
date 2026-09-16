# Agent instructions

Read [CLAUDE.md](CLAUDE.md) and follow it exactly. In short: build the
pipeline per `pipeline-guide.md` (Supabase + Blitz + gpt-4o-mini preferred),
run steps 0-2 and show counts before building gates, offer both the
deterministic and LLM flavor of each gate, sample 10 before any paid run,
implement every listed build requirement (upserts, per-company judgments,
strict LLM batch validation, rerun hygiene, recency clamp), and never commit
credentials or real people data.
