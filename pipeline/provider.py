"""Adapt this ONE function to your people-data provider.

Contract: yield one dict per person:
    {
      "person_id":      unique stable id (profile URL is ideal),
      "full_name":      str,
      "title":          str,   # title of the person's CURRENT role
      "job_start_date": str,   # "YYYY-MM" or "YYYY-MM-DD" of the CURRENT role
      "company_name":   str,
      "company_domain": str,
      "industry":       str or None,
      "country":        str or None,
      "size_min":       int or None,   # employee range of the company
      "size_max":       int or None,
      "about":          str or None,   # company description, if the API has one
    }

Gotchas that bite every provider integration:
- If the API returns a career history array, pick the entry that is CURRENT
  (a flag like job_is_current) AND whose title matches your senior pattern.
  Grabbing entry [0] silently returns past or side roles.
- Most providers have NO input filter on job start date — return everyone
  matching the title search and let step 2 filter recency client-side.
- Read the API key from the environment (see env.example), never hardcode it.
"""
import os


def search_people(title_tokens, country=None, employee_ranges=None):
    """Yield person dicts matching any of title_tokens. Adapt to your API."""
    api_key = os.environ.get("PROVIDER_API_KEY")
    if not api_key:
        raise SystemExit("PROVIDER_API_KEY not set — configure .env, or use "
                         "step1_harvest.py --csv <file> to import an export instead.")
    raise NotImplementedError(
        "Wire your provider here: typically a paginated POST to a people-search "
        "endpoint with title include-filters, mapping each result to the dict "
        "documented above.")
