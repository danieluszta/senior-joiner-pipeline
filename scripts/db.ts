/** Optional Supabase/Postgres sync (GEX registry pattern: psql shell-out, no driver dep).
 * Without DATABASE_URL the run is file-only — the run dir's artifacts are the output. */
import { execFileSync } from "child_process";
import { writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const q = (v: unknown) => (v === null || v === undefined || v === "")
  ? "NULL" : `'${String(v).replace(/'/g, "''")}'`;

export function upsertRows(table: string, cols: string[], conflictKey: string, rows: Record<string, unknown>[]): void {
  const url = process.env.DATABASE_URL;
  if (!url) { console.log(`DATABASE_URL not set — skipping ${table} sync (file artifacts are the output)`); return; }
  if (!rows.length) return;
  const updates = cols.filter((c) => c !== conflictKey).map((c) => `${c}=EXCLUDED.${c}`).join(", ");
  const sqlParts: string[] = [];
  for (let i = 0; i < rows.length; i += 200) {
    const values = rows.slice(i, i + 200)
      .map((r) => `(${cols.map((c) => q(r[c])).join(",")})`).join(",\n");
    sqlParts.push(`INSERT INTO ${table} (${cols.join(",")}) VALUES\n${values}\n` +
      `ON CONFLICT (${conflictKey}) DO UPDATE SET ${updates};`);
  }
  const f = join(tmpdir(), `sjp_upsert_${process.pid}_${Date.now()}.sql`);
  writeFileSync(f, sqlParts.join("\n"));
  try {
    execFileSync("psql", [url, "-v", "ON_ERROR_STOP=1", "-q", "-f", f], { stdio: ["ignore", "inherit", "inherit"] });
    console.log(`synced ${rows.length} rows -> ${table}`);
  } finally { rmSync(f, { force: true }); }
}
