export function parseJsonArray<T>(
  value: unknown,
  field: string,
  isItem: (item: unknown) => item is T,
): T[] {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (parsed == null) return [];
  if (!Array.isArray(parsed)) {
    throw new Error(`${field} must be a JSON array`);
  }

  return parsed.map((item, index) => {
    if (!isItem(item)) {
      throw new Error(`${field}[${index}] has an invalid value`);
    }
    return item;
  });
}

export function parseStringArray(value: unknown, field: string): string[] {
  return parseJsonArray(value, field, (item): item is string => typeof item === "string");
}

export function parseJsonObject(
  value: unknown,
  field: string,
): Record<string, unknown> {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (parsed == null) return {};
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${field} must be a JSON object`);
  }

  return Object.fromEntries(Object.entries(parsed));
}
