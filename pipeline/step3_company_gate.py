#!/usr/bin/env python3
"""Step 3 — company gate. Judges the COMPANY each recent joiner works at.

Two flavors:
  Deterministic (free, no LLM): --where "SQL over the companies table"
      python3 pipeline/step3_company_gate.py --where "industry LIKE '%software%' AND size_max <= 500"
  LLM (fuzzy judgments): fill the blanks of prompts/company_gate.txt
      python3 pipeline/step3_company_gate.py --sell "what you sell" --audience "who buys it"

The LLM flavor batches 10 companies per call and scores 0-3; >=2 passes.
Run with --limit 10 first to sanity-check verdicts before a full run.
"""
import argparse, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from pipeline import db, llm

PROMPT = Path(__file__).resolve().parent.parent / "prompts" / "company_gate.txt"


def candidates(conn, limit):
    q = """SELECT p.person_id, p.company_domain, c.name, c.industry, c.size_min, c.size_max,
                  c.country, c.about
           FROM people p LEFT JOIN companies c ON c.domain = p.company_domain
           WHERE p.recent = 1 ORDER BY p.months ASC"""
    rows = conn.execute(q + (f" LIMIT {int(limit)}" if limit else "")).fetchall()
    return [dict(r) for r in rows]


def run_where(conn, where):
    # deterministic: one UPDATE joining people to companies on the user's SQL condition
    conn.execute("UPDATE people SET company_pass = NULL, company_why = NULL WHERE recent = 1")
    conn.execute(f"""UPDATE people SET company_pass = 1, company_why = 'where-clause'
        WHERE recent = 1 AND company_domain IN
          (SELECT domain FROM companies WHERE {where})""")
    conn.execute("""UPDATE people SET company_pass = 0 WHERE recent = 1 AND company_pass IS NULL""")
    conn.commit()


def run_llm(conn, sell, audience, limit):
    cands = candidates(conn, limit)
    passed = 0
    for i in range(0, len(cands), 10):
        chunk = cands[i:i + 10]
        block = "\n".join(
            f"{j+1}. {c['name'] or c['company_domain']} ({c['company_domain']}) | "
            f"industry: {c['industry'] or '?'} | size: {c['size_min'] or '?'}-{c['size_max'] or '?'} | "
            f"about: {(c['about'] or '')[:200]}"
            for j, c in enumerate(chunk))
        prompt = llm.fill(PROMPT, WHAT_YOU_SELL=sell, AUDIENCE=audience, COMPANIES=block)
        scores = (llm.parse_json(llm.call(prompt)) or {}).get("scores") or []
        for c, s in zip(chunk, scores):
            ok = 1 if isinstance(s, (int, float)) and s >= 2 else 0
            passed += ok
            conn.execute("UPDATE people SET company_pass=?, company_why=? WHERE person_id=?",
                         (ok, f"llm_score:{s}", c["person_id"]))
        conn.commit()
    print(f"LLM-judged {len(cands)} companies, passed {passed}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--where", help="deterministic SQL condition over the companies table")
    ap.add_argument("--sell", help="LLM flavor: what you sell (fills {{WHAT_YOU_SELL}})")
    ap.add_argument("--audience", help="LLM flavor: who buys it (fills {{AUDIENCE}})")
    ap.add_argument("--limit", type=int, help="only judge the N freshest joiners (sample runs)")
    args = ap.parse_args()

    conn = db.connect()
    if args.where:
        run_where(conn, args.where)
    elif args.sell and args.audience:
        run_llm(conn, args.sell, args.audience, args.limit)
    else:
        raise SystemExit("pick a flavor: --where 'SQL' (deterministic) "
                         "or --sell '...' --audience '...' (LLM)")
    print(f"db now: {db.counts(conn)}")


if __name__ == "__main__":
    main()
