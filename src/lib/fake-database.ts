import { mock } from "bun:test";

export interface FakeQueryResult {
  rows: Record<string, unknown>[];
  rowCount: number;
}

type FakeImpl = (
  sql: string,
  params?: unknown[],
) => FakeQueryResult | Promise<FakeQueryResult>;

let impl: FakeImpl = () => ({ rows: [], rowCount: 0 });

export const executedQueries: Array<{ sql: string; params: unknown[] }> = [];

export function onFakeQuery(next: FakeImpl): void {
  impl = next;
}

export async function fakeQuery(sql: string, params: unknown[] = []): Promise<FakeQueryResult> {
  executedQueries.push({ sql, params });
  return impl(sql, params);
}

// bun's mock.module is process-global and keyed by resolved path, so every
// suite that fakes the database must register this same module object instead
// of its own factory; per-suite behavior goes through onFakeQuery.
export const fakeDatabase = {
  query: fakeQuery,
  transaction: <T>(callback: (client: { query: typeof fakeQuery }) => Promise<T>): Promise<T> =>
    callback({ query: fakeQuery }),
};

export function installFakeDatabase(specifier: string): void {
  mock.module(specifier, () => fakeDatabase);
}
