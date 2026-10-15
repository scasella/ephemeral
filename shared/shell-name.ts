export const SHELL_NAME_MAX_CHARACTERS = 80;
export const SHELL_NAME_ERROR = `Shell name must contain 1–${SHELL_NAME_MAX_CHARACTERS} Unicode characters without control characters.`;

// Count Unicode code points, not UTF-16 code units. Reject controls before
// trimming, and reject lone surrogates that cannot round-trip through storage.
export function shellNameValue(name: unknown): string | null {
  if (typeof name !== 'string' || /[\u0000-\u001f\u007f-\u009f]/.test(name) || /[\uD800-\uDFFF]/u.test(name)) return null;
  const value = name.trim();
  return value && [...value].length <= SHELL_NAME_MAX_CHARACTERS ? value : null;
}
