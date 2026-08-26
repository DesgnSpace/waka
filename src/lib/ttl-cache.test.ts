import { expect, test } from "bun:test";
import { TtlCache } from "./ttl-cache";

test("returns a stored value while it is within its TTL", () => {
  const cache = new TtlCache<string>(1000, 10);
  cache.set("a", "1", 0);
  expect(cache.get("a", 999)).toBe("1");
});

test("drops an entry once its TTL has passed", () => {
  const cache = new TtlCache<string>(1000, 10);
  cache.set("a", "1", 0);
  expect(cache.get("a", 1000)).toBeUndefined();
  expect(cache.size).toBe(0);
});

test("keeps independent expiries per key", () => {
  const cache = new TtlCache<string>(1000, 10);
  cache.set("a", "1", 0);
  cache.set("b", "2", 500);
  expect(cache.get("a", 1000)).toBeUndefined();
  expect(cache.get("b", 1000)).toBe("2");
});

test("evicts the oldest entry once capacity is reached", () => {
  const cache = new TtlCache<string>(60_000, 2);
  cache.set("a", "1", 0);
  cache.set("b", "2", 0);
  cache.set("c", "3", 0);
  expect(cache.get("a", 1)).toBeUndefined();
  expect(cache.get("b", 1)).toBe("2");
  expect(cache.get("c", 1)).toBe("3");
  expect(cache.size).toBe(2);
});

test("refreshing an existing key does not evict others or grow past capacity", () => {
  const cache = new TtlCache<string>(1000, 2);
  cache.set("a", "old", 0);
  cache.set("b", "2", 0);
  cache.set("a", "new", 900);
  expect(cache.size).toBe(2);
  expect(cache.get("b", 950)).toBe("2");
  expect(cache.get("a", 1500)).toBe("new");
});

test("a refreshed key keeps a fresh TTL from the new write time", () => {
  const cache = new TtlCache<string>(1000, 2);
  cache.set("a", "1", 0);
  cache.set("a", "again", 800);
  expect(cache.get("a", 1700)).toBe("again");
  expect(cache.get("a", 1801)).toBeUndefined();
});
