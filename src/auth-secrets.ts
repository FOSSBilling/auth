import type { Env } from "./types";

// Worker bindings are not available through Better Auth's process env parser.
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
    const value = match[2].trim();
    if (!Number.isSafeInteger(version) || !value || seen.has(version)) {
      throw new Error("Invalid BETTER_AUTH_SECRETS version or value");
    }
    seen.add(version);
    return { version, value };
  });
  return { secret: legacySecret, secrets };
}
