/** gpt-5-nano judge calls.
 * Hard-learned params (see pipeline-guide.md / GEX new-in-role playbook):
 *  - reasoning_effort "minimal" is NOT optional: at default effort the model can burn the
 *    whole budget on reasoning and return empty content (finish_reason=length).
 *  - retry on finish_reason=length; never record it as an abstain.
 *  - batch verdicts are validated strictly: N in, exactly N out, or the batch retries
 *    once and is then reported unjudged. No silent short-zips.
 */
import { readFileSync } from "fs";
import { fetchJson, sha } from "./lib";

const MODEL = process.env.JUDGE_MODEL ?? "gpt-5-nano";

async function chat(prompt: string): Promise<string> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY not set (see env.example)");
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetchJson("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "user", content: prompt }],
        max_completion_tokens: 2000,
        reasoning_effort: "minimal",
      }),
    });
    const choice = r?.choices?.[0];
    if (choice?.finish_reason === "length") continue; // retry, never abstain
    return choice?.message?.content ?? "";
  }
  throw new Error("model returned finish_reason=length on every attempt");
}

export function parseJson(text: string): any {
  const m = /\{[\s\S]*\}/.exec(text ?? "");
  try { return m ? JSON.parse(m[0]) : {}; } catch { return {}; }
}

export function fillTemplate(path: string, blanks: Record<string, string>): { prompt: string; promptSha: string } {
  let tpl = readFileSync(path, "utf8");
  const missing = [...tpl.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).filter((k) => !(k in blanks));
  if (missing.length) throw new Error(`unfilled prompt blanks: ${[...new Set(missing)].join(", ")}`);
  for (const [k, v] of Object.entries(blanks)) tpl = tpl.split(`{{${k}}}`).join(v);
  return { prompt: tpl, promptSha: sha(tpl.split("\n").slice(0, 50).join("\n")) };
}

/** Judge one batch; expects `key` to hold an array. Returns the array only if its
 *  length matches `expect`; retries once, then returns null (caller records unjudged). */
export async function judgeBatch(prompt: string, key: string, expect: number): Promise<any[] | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const arr = parseJson(await chat(prompt))?.[key];
    if (Array.isArray(arr) && arr.length === expect) return arr;
  }
  return null;
}

export async function judgeOne(prompt: string): Promise<any> {
  return parseJson(await chat(prompt));
}
