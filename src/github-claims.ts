const GITHUB_ID_CLAIM = "https://fossbilling.org/claims/github_id";
const GITHUB_LOGIN_EXPIRES_AT_CLAIM =
  "https://fossbilling.org/claims/github_login_expires_at";
const GITHUB_LOGIN_CLAIM = "https://fossbilling.org/claims/github_login";
const GITHUB_ORGS_CLAIM = "https://fossbilling.org/claims/github_orgs";
const GITHUB_ORGS_EXPIRES_AT_CLAIM =
  "https://fossbilling.org/claims/github_orgs_expires_at";

export const GITHUB_SCOPE = "github" as const;
export const DEFAULT_GITHUB_ORGS_MAX_AGE_SECONDS = 24 * 60 * 60;

// A complete membership snapshot must fit both D1 and the OAuth claim.
export const MAX_GITHUB_ORG_PAGES = 4;
export const MAX_GITHUB_ORGS = 300;
export const MAX_GITHUB_ORG_RESPONSE_BYTES = 256 * 1024;
export const MAX_GITHUB_ORGS_JSON_BYTES = 8 * 1024;
export const MAX_GITHUB_ORG_FETCH_MS = 5_000;

export function fitsGithubOrgsBudget(orgs: string[]): boolean {
  return (
    orgs.length <= MAX_GITHUB_ORGS &&
    new TextEncoder().encode(JSON.stringify(orgs)).byteLength <=
      MAX_GITHUB_ORGS_JSON_BYTES
  );
}

type GithubClaimUser = Record<string, unknown>;

export function getGithubOrgsMaxAgeMs(raw?: string): number {
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return DEFAULT_GITHUB_ORGS_MAX_AGE_SECONDS * 1000;
  }
  return seconds * 1000;
}

function evidenceExpiry(
  verifiedAt: unknown,
  maxAgeMs: number,
  now: number
): string | null {
  if (
    typeof verifiedAt !== "string" ||
    !Number.isFinite(maxAgeMs) ||
    maxAgeMs <= 0
  )
    return null;
  const verifiedAtMs = Date.parse(verifiedAt);
  if (!Number.isFinite(verifiedAtMs) || verifiedAtMs > now) return null;
  const expiresAtMs = verifiedAtMs + maxAgeMs;
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now) return null;
  const expiresAt = new Date(expiresAtMs);
  return Number.isFinite(expiresAt.getTime()) ? expiresAt.toISOString() : null;
}

function freshGithubOrgs(
  user: GithubClaimUser,
  maxAgeMs: number,
  now = Date.now()
): { orgs: string[]; expiresAt: string } | null {
  if (typeof user.githubOrgs !== "string") return null;
  if (typeof user.githubOrgsVerifiedAt !== "string") return null;
  if (
    new TextEncoder().encode(user.githubOrgs).byteLength >
    MAX_GITHUB_ORGS_JSON_BYTES
  )
    return null;

  const expiresAt = evidenceExpiry(user.githubOrgsVerifiedAt, maxAgeMs, now);
  if (!expiresAt) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(user.githubOrgs);
  } catch {
    return null;
  }
  if (
    !Array.isArray(parsed) ||
    !parsed.every((org) => typeof org === "string") ||
    !fitsGithubOrgsBudget(parsed)
  ) {
    return null;
  }

  return {
    orgs: parsed,
    expiresAt
  };
}

export function hasFreshGithubOrgs(
  user: GithubClaimUser,
  maxAgeMs: number,
  now = Date.now()
): boolean {
  return freshGithubOrgs(user, maxAgeMs, now) !== null;
}

export function githubClaims(
  user: GithubClaimUser,
  maxAgeMs: number,
  scopes: readonly string[],
  now = Date.now()
) {
  if (!scopes.includes(GITHUB_SCOPE)) return {};
  const claims: Record<string, unknown> = {};
  // The immutable provider ID is identity evidence; login is bounded display
  // metadata and must never become a durable authorization key.
  if (typeof user.githubId === "string" && /^[1-9]\d*$/.test(user.githubId)) {
    claims[GITHUB_ID_CLAIM] = user.githubId;
  }
  const loginExpiresAt = evidenceExpiry(
    user.githubLoginVerifiedAt,
    maxAgeMs,
    now
  );
  if (
    typeof user.githubLogin === "string" &&
    user.githubLogin &&
    loginExpiresAt
  ) {
    claims[GITHUB_LOGIN_CLAIM] = user.githubLogin;
    claims[GITHUB_LOGIN_EXPIRES_AT_CLAIM] = loginExpiresAt;
  }

  const orgs = freshGithubOrgs(user, maxAgeMs, now);
  if (orgs) {
    claims[GITHUB_ORGS_CLAIM] = orgs.orgs;
    claims[GITHUB_ORGS_EXPIRES_AT_CLAIM] = orgs.expiresAt;
  }

  return claims;
}
