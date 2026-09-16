#!/usr/bin/env python3
"""Step 1 — harvest seniors.

Pulls people whose CURRENT title is senior (VP/Head/Director/C-level plus
common non-English equivalents) from your provider, or imports a CSV export
with the same columns as pipeline/provider.py documents.
"""
import argparse, csv, re, sys
sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parent.parent))
from pipeline import db, provider

SENIOR_TOKENS = ["chief", "vp", "vice president", "head", "director", "president",
                 "directeur", "direktor", "geschäftsführer", "leiter", "responsable",
                 "jefe", "direttore", "dyrektor", "hoofd"]
SENIOR = re.compile(r"chief|\bvp\b|vice president|head|director|president|directeur|"
                    r"direktor|geschäftsführ|leiter|responsable|jefe|direttore|dyrektor|hoofd", re.I)
# titles that CONTAIN a senior word but are not senior buyers
EXCLUDE = re.compile(r"executive assistant|\bea to\b|assistant to|chief of staff|deputy|"
                     r"intern\b|chef de partie|chef de cuisine|sous chef|head chef|pastry", re.I)


def keep(title):
    return bool(title) and SENIOR.search(title) and not EXCLUDE.search(title)


def store(conn, p):
    if not keep(p.get("title")):
        return 0
    pid = p.get("person_id") or f'{p.get("full_name")}@{p.get("company_domain")}'
    conn.execute("""INSERT OR IGNORE INTO people
        (person_id, full_name, title, job_start_date, company_domain, company_name)
        VALUES (?,?,?,?,?,?)""",
        (pid, p.get("full_name"), p.get("title"), p.get("job_start_date"),
         (p.get("company_domain") or "").lower().replace("www.", ""), p.get("company_name")))
    if p.get("company_domain"):
        conn.execute("""INSERT OR IGNORE INTO companies
            (domain, name, industry, country, size_min, size_max, about)
            VALUES (?,?,?,?,?,?,?)""",
            ((p["company_domain"] or "").lower().replace("www.", ""), p.get("company_name"),
             p.get("industry"), p.get("country"), p.get("size_min"), p.get("size_max"),
             p.get("about")))
    return 1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv", help="import a CSV export instead of calling the provider API")
    ap.add_argument("--country", default=None)
    args = ap.parse_args()

    conn = db.connect()
    n = 0
    if args.csv:
        with open(args.csv, newline="", encoding="utf-8") as f:
            for row in csv.DictReader(f):
                n += store(conn, row)
    else:
        for p in provider.search_people(SENIOR_TOKENS, country=args.country):
            n += store(conn, p)
    conn.commit()
    print(f"harvested {n} seniors | db now: {db.counts(conn)}")


if __name__ == "__main__":
    main()
