// Better Auth accepts this published fallback outside production mode. Never
// allow an unconfigured Worker to use it for signed OAuth state or sessions.
const BETTER_AUTH_DEFAULT_SECRET = "better-auth-secret-12345678901234567890";
const EXAMPLE_SECRET = "replace-with-openssl-rand-base64-32";

function isRepeatedPattern(value: string): boolean {
  for (let width = 1; width <= value.length / 2; width++) {
    if (
      value.length % width === 0 &&
      value === value.slice(0, width).repeat(value.length / width)
    ) {
      return true;
    }
  }
  return false;
}

export function requireBetterAuthSecret(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 32 ||
    value !== value.trim()
  ) {
    throw new Error(
      "BETTER_AUTH_SECRET must be a random secret of at least 32 characters"
    );
  }

  if (value === BETTER_AUTH_DEFAULT_SECRET || value === EXAMPLE_SECRET) {
    throw new Error(
      "BETTER_AUTH_SECRET must not use a published example value"
    );
  }

  // This catches repeated or very low-diversity values. It cannot prove the
  // value was generated randomly; deployment instructions require that.
  const estimatedBits = value.length * Math.log2(new Set(value).size);
  if (estimatedBits < 120 || isRepeatedPattern(value)) {
    throw new Error(
      "BETTER_AUTH_SECRET must be a random secret with sufficient diversity"
    );
  }

  return value;
}
