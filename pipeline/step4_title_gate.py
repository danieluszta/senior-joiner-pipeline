#!/usr/bin/env python3
"""Step 4 — title gate. Judges whether the PERSON's title fits your buyer profile.

Two flavors:
  Deterministic (free, no LLM): --tokens "operations,ops,supply,logistics"
      keeps titles containing any token (case-insensitive substring match)
  LLM (judgment calls): fill the blanks of prompts/title_gate.txt
      python3 pipeline/step4_title_gate.py --sell "what you sell" --buyer "who owns the purchase"

Runs only on people who passed steps 2 and 3. --export writes the final list.
"""
import argparse, csv, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from pipeline import db, llm

PROMPT = Path(__file__).resolve().parent.parent / "prompts" / "title_gate.txt"


def candidates(conn, limit):
    q = """SELECT person_id, full_name, title, months, company_name, company_domain
           FROM people WHERE recent = 1 AND company_pass = 1 ORDER BY months ASC"""
    rows = conn.execute(q + (f" LIMIT {int(limit)}" if limit else "")).fetchall()
    return [dict(r) for r in rows]


def run_tokens(conn, tokens):
    toks = [t.strip().lower() for t in tokens.split(",") if t.strip()]
    n = 0
    for c in candidates(conn, None):
        ok = 1 if any(t in (c["title"] or "").lower() for t in toks) else 0
        n += ok
        conn.execute("UPDATE people SET title_pass=?, title_why=? WHERE person_id=?",
                     (ok, "token-match" if ok else "no-token", c["person_id"]))
    conn.commit()
    print(f"token gate passed {n}")


def run_llm(conn, sell, buyer, limit):
    cands = candidates(conn, limit)
    passed = 0
    for i in range(0, len(cands), 10):
        chunk = cands[i:i + 10]
        block = "\n".join(f"{j+1}. {c['title'][:70]} @ {c['company_name'] or c['company_domain']}"
                          for j, c in enumerate(chunk))
        prompt = llm.fill(PROMPT, WHAT_YOU_SELL=sell, BUYER_PROFILE=buyer, TITLES=block)
        verdicts = (llm.parse_json(llm.call(prompt)) or {}).get("owns") or []
        for c, v in zip(chunk, verdicts):
            ok = 1 if v is True else 0
            passed += ok
            conn.execute("UPDATE people SET title_pass=?, title_why=? WHERE person_id=?",
                         (ok, f"llm:{v}", c["person_id"]))
        conn.commit()
    print(f"LLM-judged {len(cands)} titles, passed {passed}")


def export(conn, path):
    rows = conn.execute("""SELECT full_name, title, months, company_name, company_domain
        FROM people WHERE recent=1 AND company_pass=1 AND title_pass=1
        ORDER BY months ASC""").fetchall()
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["full_name", "title", "months_in_role", "company_name", "company_domain"])
        w.writerows([tuple(r) for r in rows])
    print(f"exported {len(rows)} qualified leads -> {path} (keep this file PRIVATE)")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tokens", help="deterministic flavor: comma-separated title tokens")
    ap.add_argument("--sell", help="LLM flavor: what you sell")
    ap.add_argument("--buyer", help="LLM flavor: who owns the purchase (fills {{BUYER_PROFILE}})")
    ap.add_argument("--limit", type=int, help="only judge N candidates (sample runs)")
    ap.add_argument("--export", help="write final qualified leads to this CSV")
    args = ap.parse_args()

    conn = db.connect()
    if args.tokens:
        run_tokens(conn, args.tokens)
    elif args.sell and args.buyer:
        run_llm(conn, args.sell, args.buyer, args.limit)
    elif not args.export:
        raise SystemExit("pick a flavor: --tokens 'a,b,c' (deterministic) "
                         "or --sell '...' --buyer '...' (LLM)")
    if args.export:
        export(conn, args.export)
    print(f"db now: {db.counts(conn)}")


if __name__ == "__main__":
    main()
