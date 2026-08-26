import { beforeEach, expect, test } from "bun:test";

import { executedQueries, installFakeDatabase, onFakeQuery } from "./fake-database";

const accountA = "00000000-0000-0000-0000-00000000000a";
const accountB = "00000000-0000-0000-0000-00000000000b";
const domainB = "00000000-0000-0000-0000-0000000000db";

installFakeDatabase("./database");

const { getDomainById } = await import("./domains");

beforeEach(() => {
  executedQueries.length = 0;
  onFakeQuery((_sql, params = []) =>
    params[1] === accountB
      ? { rows: [{ id: domainB, user_id: accountB, dns_records: [] }], rowCount: 1 }
      : { rows: [], rowCount: 0 },
  );
});

test("an account cannot read another account's domain by id", async () => {
  const result = await getDomainById(domainB, accountA);

  expect(result).toBeNull();
  const call = executedQueries.find((q) => q.sql.includes("WHERE id = $1 AND user_id = $2"));
  expect(call?.params).toEqual([domainB, accountA]);
});

test("the owning account can read its domain by id", async () => {
  const result = await getDomainById(domainB, accountB);

  expect(result?.id).toBe(domainB);
  expect(result?.user_id).toBe(accountB);
});

test("a domain query always binds the account id", async () => {
  await getDomainById(domainB, accountA);

  const last = executedQueries.at(-1);
  expect(last?.params).toEqual([domainB, accountA]);
});
