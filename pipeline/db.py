"""SQLite storage: people joined to companies by company_domain.

Company attributes live in their own table so the deterministic company gate
(step 3 --where) can filter on industry/size/country without any LLM.
"""
import sqlite3
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent.parent / "leads.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS people (
    person_id       TEXT PRIMARY KEY,   -- provider URL/ID, or name@domain for CSV rows
    full_name       TEXT,
    title           TEXT,
    job_start_date  TEXT,               -- YYYY-MM or YYYY-MM-DD
    months          INTEGER,            -- filled by step 2
    company_domain  TEXT,
    company_name    TEXT,
    recent          INTEGER,            -- step 2: 1 = within window
    company_pass    INTEGER,            -- step 3: 1 = company qualified
    company_why     TEXT,
    title_pass      INTEGER,            -- step 4: 1 = title qualified
    title_why       TEXT,
    harvested_at    TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS companies (
    domain    TEXT PRIMARY KEY,
    name      TEXT,
    industry  TEXT,
    country   TEXT,
    size_min  INTEGER,
    size_max  INTEGER,
    about     TEXT
);
CREATE INDEX IF NOT EXISTS idx_people_domain ON people(company_domain);
"""


def connect():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    return conn


def counts(conn):
    q = conn.execute("""SELECT COUNT(*) total,
        SUM(recent) recent, SUM(company_pass) company_pass,
        SUM(recent AND company_pass AND title_pass) qualified FROM people""").fetchone()
    return dict(q)
