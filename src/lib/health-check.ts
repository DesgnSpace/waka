// The pool holds only 5 clients (src/lib/database.ts), and during a database
// outage every request path stalls waiting for one. The health endpoint must
// therefore run at most one check at a time, reuse its answer across probes,
// and never wait on pg's own timeouts (a saturated pool queues connect()
// calls indefinitely).

export const CACHE_TTL_MS = 20_000;
export const STATEMENT_TIMEOUT_MS = 2_000;
export const CHECK_DEADLINE_MS = 4_000;

const SERVICE = "Waka";
const VERSION = "1.0.0";

export interface HealthReport {
  status: "healthy" | "unhealthy";
  timestamp: string;
  service: string;
  version: string;
  database: "up" | "down";
}

export interface DbClient {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}

export type DbRunner = <T>(callback: (client: DbClient) => Promise<T>) => Promise<T>;

interface Options {
  cacheTtlMs?: number;
  deadlineMs?: number;
}

function withDeadline(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`health check exceeded ${ms}ms`)), ms);
  });
  void promise.catch(() => {});
  return Promise.race([promise.then(() => undefined), deadline]).finally(() =>
    clearTimeout(timer)
  );
}

export function createHealthChecker(runner: DbRunner, options: Options = {}) {
  const ttl = options.cacheTtlMs ?? CACHE_TTL_MS;
  const deadline = options.deadlineMs ?? CHECK_DEADLINE_MS;

  let cached: { healthy: boolean; at: number } | null = null;
  let inFlight: Promise<boolean> | null = null;

  async function check(): Promise<boolean> {
    try {
      await withDeadline(
        runner(async (client) => {
          // is_local=true scopes the timeout to this transaction, so the
          // pooled client is handed back with its default settings.
          await client.query("SELECT set_config('statement_timeout', $1, true)", [
            String(STATEMENT_TIMEOUT_MS),
          ]);
          await client.query("SELECT 1");
        }),
        deadline,
      );
      return true;
    } catch {
      return false;
    }
  }

  return {
    async report(now: number = Date.now()): Promise<HealthReport> {
      if (!cached || now - cached.at >= ttl) {
        inFlight ??= check().then((healthy) => {
          cached = { healthy, at: now };
          return healthy;
        }).finally(() => {
          inFlight = null;
        });
        await inFlight;
      }
      const { healthy, at } = cached!;
      return {
        status: healthy ? "healthy" : "unhealthy",
        timestamp: new Date(at).toISOString(),
        service: SERVICE,
        version: VERSION,
        database: healthy ? "up" : "down",
      };
    },
  };
}
