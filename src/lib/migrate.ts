import { readdir } from "node:fs/promises";
import path from "node:path";
import { db } from "./database";

const MIGRATIONS_DIR = path.join(import.meta.dir, "../../migrations");

// App-wide advisory lock so concurrent containers (rolling deploys) never run
// migrations simultaneously; the second waits, then sees everything applied.
// Advisory lock keys in use: 724242 migrate, 724243 prune, 724244 outbound
// webhooks, 724245 rate-limit purge.
const MIGRATION_LOCK_KEY = 724_242;

export async function migrate(): Promise<void> {
  const client = await db.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )`);

    const applied = new Set<string>(
      (await client.query("SELECT name FROM schema_migrations")).rows.map(
        (r: { name: string }) => r.name
      )
    );
    const files = (await readdir(MIGRATIONS_DIR))
      .filter((f) => f.endsWith(".sql"))
      .sort();

    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await Bun.file(path.join(MIGRATIONS_DIR, file)).text();
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [
          file,
        ]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${file} failed: ${error}`);
      }
      console.log(`migrated: ${file}`);
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]);
    client.release();
  }
}
