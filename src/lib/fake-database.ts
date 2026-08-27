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

export async function fakeTransaction<T>(cb: (client: { query: typeof fakeQuery }) => Promise<T>): Promise<T> {
  return cb({ query: fakeQuery });
}

const fakePool = { connect: async () => ({ query: fakeQuery, release: () => {} }) };
export const fakeDatabase = {
  query: fakeQuery,
  transaction: fakeTransaction,
  pool: fakePool,
  db: fakePool,
};

export function installFakeDatabase(specifier: string): void {
  mock.module(specifier, () => fakeDatabase);
}
