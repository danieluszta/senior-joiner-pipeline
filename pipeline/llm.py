"""Minimal LLM helper for the gates. Uses any OpenAI-compatible chat API.

Env: LLM_API_KEY (required for LLM gates), LLM_MODEL (default gpt-4o-mini),
LLM_BASE_URL (default https://api.openai.com/v1).
"""
import json, os, re, urllib.request


def call(prompt):
    key = os.environ.get("LLM_API_KEY")
    if not key:
        raise SystemExit("LLM_API_KEY not set — configure .env, or use the "
                         "deterministic flavor of this gate (--where / --tokens).")
    body = json.dumps({
        "model": os.environ.get("LLM_MODEL", "gpt-4o-mini"),
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0,
    }).encode()
    req = urllib.request.Request(
        os.environ.get("LLM_BASE_URL", "https://api.openai.com/v1").rstrip("/") + "/chat/completions",
        data=body, headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)["choices"][0]["message"]["content"]


def parse_json(text):
    m = re.search(r"\{.*\}", text or "", re.S)
    try:
        return json.loads(m.group(0)) if m else {}
    except json.JSONDecodeError:
        return {}


def fill(template_path, **blanks):
    tpl = open(template_path, encoding="utf-8").read()
    missing = set(re.findall(r"\{\{(\w+)\}\}", tpl)) - set(blanks)
    if missing:
        raise SystemExit(f"prompt template has unfilled blanks: {sorted(missing)} — "
                         "pass them as CLI flags (see --help).")
    for k, v in blanks.items():
        tpl = tpl.replace("{{" + k + "}}", str(v))
    return tpl
