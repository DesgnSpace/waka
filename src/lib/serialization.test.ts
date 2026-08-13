import { expect, test } from "bun:test";
import {
  parseJsonArray,
  parseJsonArrayOf,
  parseJsonObject,
  parseStringArray,
} from "./serialization";

test("parses stored JSON arrays and objects", () => {
  expect(parseJsonArray('["to@example.com"]', "recipients")).toEqual([
    "to@example.com",
  ]);
  expect(parseStringArray('["send"]', "permissions")).toEqual(["send"]);
  expect(parseJsonObject('{"status":"sent"}', "event_data")).toEqual({
    status: "sent",
  });
});

test("rejects malformed or incorrectly shaped stored JSON", () => {
  expect(() => parseJsonArray("{", "recipients")).toThrow(
    "recipients contains invalid JSON",
  );
  expect(() => parseJsonArray("{}", "recipients")).toThrow(
    "recipients must be a JSON array",
  );
  expect(() =>
    parseJsonArrayOf("[1]", "permissions", (value): value is string => typeof value === "string"),
  ).toThrow("permissions[0] has an invalid value");
  expect(() => parseJsonObject("[]", "event_data")).toThrow(
    "event_data must be a JSON object",
  );
});
