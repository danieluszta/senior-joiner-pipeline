/** Blitz API client. Base: https://api.blitz-api.ai/v2, auth header x-api-key.
 * Facts encoded here (see pipeline-guide.md step 1):
 *  - /search/people has NO input filter for job start date — recency is client-side.
 *  - results carry the whole career in experiences[]; callers must select the CURRENT role.
 *  - filter include-lists cap at 50 entries; callers chunk.
 */
import { fetchJson, limiter } from "./lib";

const BASE = process.env.BLITZ_BASE_URL ?? "https://api.blitz-api.ai/v2";
const throttle = limiter(Number(process.env.BLITZ_RPS ?? 20));

async function post(path: string, body: object): Promise<any> {
  const key = process.env.BLITZ_API_KEY;
  if (!key) throw new Error("BLITZ_API_KEY not set (see env.example)");
  await throttle();
  return fetchJson(`${BASE}${path}`, {
    method: "POST",
    headers: { "x-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export type Experience = {
  job_title?: string; job_start_date?: string; job_is_current?: boolean;
  company_name?: string; company_linkedin_url?: string; company_domain?: string;
};
export type Person = {
  full_name?: string; linkedin_url?: string; experiences?: Experience[];
};

/** Title-first people search, cursor-paginated. Yields raw person records. */
export async function* searchPeople(opts: {
  titles: string[]; country?: string; employeeRanges?: string[];
  industries?: string[]; maxPages?: number;
}): AsyncGenerator<Person> {
  const body: any = {
    people: { job_title: { include: opts.titles.slice(0, 50) } },
    company: {
      ...(opts.industries?.length ? { industry: { include: opts.industries.slice(0, 50) } } : {}),
      ...(opts.country ? { hq: { country_code: [opts.country] } } : {}),
      ...(opts.employeeRanges?.length ? { employee_range: opts.employeeRanges } : {}),
    },
    max_results: 50,
  };
  let cursor: string | undefined;
  for (let page = 0; page < (opts.maxPages ?? 4000); page++) {
    const r = await post("/search/people", cursor ? { ...body, cursor } : body);
    const got: Person[] = r?.results ?? [];
    for (const p of got) yield p;
    cursor = r?.cursor;
    if (!cursor || got.length === 0) return;
  }
}

/** Domain-first: resolve a domain to the company LinkedIn, then page its employees. */
export async function domainToLinkedin(domain: string): Promise<string | null> {
  const r = await post("/enrichment/domain-to-linkedin", { domain });
  return r?.company_linkedin_url ?? r?.linkedin_url ?? null;
}

export async function* employeesOf(companyLinkedinUrl: string, maxPages = 200): AsyncGenerator<Person> {
  for (let page = 1; page <= maxPages; page++) {
    const r = await post("/search/employee-finder", {
      company_linkedin_url: companyLinkedinUrl, max_results: 50, page,
    });
    const got: Person[] = r?.results ?? [];
    for (const p of got) yield p;
    if (got.length < 50) return;
  }
}

/** Company enrichment — the judge's evidence (about text, size, hq). */
export async function companyEnrich(companyLinkedinUrl: string): Promise<any> {
  const r = await post("/enrichment/company", { company_linkedin_url: companyLinkedinUrl });
  return r?.company ?? r ?? {};
}

/** Full career history for one person — step 2b fallback when the pull
 *  didn't already carry usable experiences[]. */
export async function personEnrich(linkedinUrl: string): Promise<Experience[]> {
  const r = await post("/enrichment/person", { linkedin_profile_url: linkedinUrl });
  return r?.experiences ?? r?.person?.experiences ?? [];
}
