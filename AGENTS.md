# Agent instructions

Read [CLAUDE.md](CLAUDE.md) and follow it exactly. The contract in short:
run the four steps in order with the user; for the company gate (step 3) and
title gate (step 4) always present BOTH flavors — the blanked LLM prompt and
the free deterministic filter (SQL over joined company attributes, or title
tokens) — and let the user choose. Never commit or publish harvested people
data; never put credentials in code; ask before LLM runs over full lists.
