import { expect, mock, test } from "bun:test";

const accountA = "00000000-0000-0000-0000-00000000000a";
const accountB = "00000000-0000-0000-0000-00000000000b";
const domainB = "00000000-0000-0000-0000-0000000000db";

const query = mock(async (sql: string, params: unknown[] = []) => {
  if (sql.includes("FROM domains")) {
    return {
      rows: params[1] === accountB ? [{ id: domainB, user_id: accountB, dns_records: [] }] : [],
      rowCount: params[1] === accountB ? 1 : 0,
    };
  }

  return { rows: [], rowCount: 0 };
});

mock.module("./database", () => ({ query }));

const { getDomainById } = await import("./domains");

test("an account cannot read another account's domain by id", async () => {
  const result = await getDomainById(domainB, accountA);

  expect(result).toBeNull();
  expect(query).toHaveBeenCalledWith(
    expect.stringContaining("WHERE id = $1 AND user_id = $2"),
    [domainB, accountA],
  );
});

test("the owning account can read its domain by id", async () => {
  const result = await getDomainById(domainB, accountB);

  expect(result?.id).toBe(domainB);
  expect(result?.user_id).toBe(accountB);
});

test("a domain query always binds the account id", async () => {
  await getDomainById(domainB, accountA);

  const [, params] = query.mock.calls.at(-1) ?? [];
  expect(params).toEqual([domainB, accountA]);
});
