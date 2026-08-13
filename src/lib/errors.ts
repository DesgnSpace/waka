export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (isObject(error) && typeof error.message === "string") return error.message;
  return String(error);
}

export function errorCode(error: unknown): string | undefined {
  if (!isObject(error) || !("code" in error)) return undefined;
  const code = error.code;
  return typeof code === "string" ? code : undefined;
}

export function errorName(error: unknown): string | undefined {
  if (!isObject(error) || !("name" in error)) return undefined;
  const name = error.name;
  return typeof name === "string" ? name : undefined;
}

export function errorHttpStatus(error: unknown): number | undefined {
  if (!isObject(error) || !("$metadata" in error)) return undefined;
  const metadata = error.$metadata;
  if (!isObject(metadata) || !("httpStatusCode" in metadata)) return undefined;
  const status = metadata.httpStatusCode;
  return typeof status === "number" ? status : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
