#!/usr/bin/env python3
"""Step 2 — keep recent joiners.

Computes months-in-role from job_start_date CLIENT-SIDE (most providers have
no input filter for this) and flags people within the window. Nothing is
deleted — reruns with a different window just re-flag.
"""
import argparse, re, sys
from datetime import date
sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parent.parent))
from pipeline import db


def months_ago(ds):
    m = re.match(r"(\d{4})-(\d{2})", ds or "")
    if not m:
        return None
    t = date.today()
    return (t.year - int(m.group(1))) * 12 + (t.month - int(m.group(2)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--max-months", type=int, default=9,
                    help="keep people who started their current role at most this many months ago")
    args = ap.parse_args()

    conn = db.connect()
    rows = conn.execute("SELECT person_id, job_start_date FROM people").fetchall()
    kept = dropped = undated = 0
    for r in rows:
        m = months_ago(r["job_start_date"])
        recent = 1 if (m is not None and m <= args.max_months) else 0
        if m is None:
            undated += 1
        kept += recent
        dropped += (m is not None and not recent)
        conn.execute("UPDATE people SET months=?, recent=? WHERE person_id=?",
                     (m, recent, r["person_id"]))
    conn.commit()
    print(f"recent (≤{args.max_months}mo): {kept} | too old: {dropped} | "
          f"no usable date (excluded): {undated}")


if __name__ == "__main__":
    main()
