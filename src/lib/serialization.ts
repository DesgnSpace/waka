export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonValue(value: unknown, field: string): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${field} contains invalid JSON`);
  }
}

function parseArray(value: unknown, field: string): unknown[] {
  const parsed = parseJsonValue(value, field);
  if (parsed == null) return [];
  if (!Array.isArray(parsed)) {
    throw new Error(`${field} must be a JSON array`);
  }
  return parsed;
}

export function parseJsonArray(value: unknown, field: string): unknown[] {
  return parseArray(value, field);
}

export function parseJsonArrayOf<T>(
  value: unknown,
  field: string,
  isItem: (item: unknown) => item is T,
): T[];
export function parseJsonArrayOf<T>(
  value: unknown,
  field: string,
  isItem: (item: unknown) => item is T,
): T[] {
  return parseArray(value, field).map((item, index) => {
    if (!isItem(item)) {
      throw new Error(`${field}[${index}] has an invalid value`);
    }
    return item;
  });
}

export function parseStringArray(value: unknown, field: string): string[] {
  return parseJsonArrayOf(value, field, (item): item is string => typeof item === "string");
}

export function parseJsonObject(
  value: unknown,
  field: string,
): Record<string, unknown> {
  const parsed = parseJsonValue(value, field);
  if (parsed == null) return {};
  if (!isRecord(parsed)) {
    throw new Error(`${field} must be a JSON object`);
  }

  return parsed;
}
