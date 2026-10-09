// Better Auth accepts this published fallback outside production mode. Never
// allow an unconfigured Worker to use it for signed OAuth state or sessions.
import type { Env } from "./types";

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

// Worker bindings are not available through Better Auth's process env parser.
// Every configured value is strength-validated, including rotation keyring
// entries, so a weak replacement cannot slip in beside a strong legacy secret.
export function getAuthSecretOptions(
  env: Pick<Env, "BETTER_AUTH_SECRET" | "BETTER_AUTH_SECRETS">
) {
  const legacySecret = env.BETTER_AUTH_SECRET;
  const keyring = env.BETTER_AUTH_SECRETS;
  if (!keyring) {
    if (!legacySecret) throw new Error("A Better Auth secret is required");
    return { secret: legacySecret };
  }

  const seen = new Set<number>();
  const secrets = keyring.split(",").map((entry) => {
    const match = /^([0-9]+):(.+)$/.exec(entry.trim());
    if (!match) throw new Error("Invalid BETTER_AUTH_SECRETS entry");
    const version = Number(match[1]);
    const value = requireBetterAuthSecret(match[2].trim());
    if (!Number.isSafeInteger(version) || seen.has(version)) {
      throw new Error("Invalid BETTER_AUTH_SECRETS version or value");
    }
    seen.add(version);
    return { version, value };
  });
  return { secret: legacySecret, secrets };
}
