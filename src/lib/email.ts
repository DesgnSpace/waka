const EMAIL_ADDRESS_PATTERN = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;

export function isEmailAddress(value: string): boolean {
  if (value.length > 320) return false;
  return EMAIL_ADDRESS_PATTERN.test(value);
}
