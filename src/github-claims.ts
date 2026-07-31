const GITHUB_LOGIN_CLAIM = "https://fossbilling.org/claims/github_login";
const GITHUB_ORGS_CLAIM = "https://fossbilling.org/claims/github_orgs";
const GITHUB_ORGS_EXPIRES_AT_CLAIM =
  "https://fossbilling.org/claims/github_orgs_expires_at";

export const GITHUB_SCOPE = "github" as const;
export const DEFAULT_GITHUB_ORGS_MAX_AGE_SECONDS = 24 * 60 * 60;

type GithubClaimUser = Record<string, unknown>;

export function getGithubOrgsMaxAgeMs(raw?: string): number {
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return DEFAULT_GITHUB_ORGS_MAX_AGE_SECONDS * 1000;
  }
  return seconds * 1000;
}

function freshGithubOrgs(
  user: GithubClaimUser,
  maxAgeMs: number,
  now = Date.now()
): { orgs: string[]; expiresAt: string } | null {
  if (typeof user.githubOrgs !== "string") return null;
  if (typeof user.githubOrgsVerifiedAt !== "string") return null;

  const verifiedAtMs = Date.parse(user.githubOrgsVerifiedAt);
  if (!Number.isFinite(verifiedAtMs) || verifiedAtMs > now) return null;

  const expiresAtMs = verifiedAtMs + maxAgeMs;
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now) return null;
  const expiresAt = new Date(expiresAtMs);
  if (!Number.isFinite(expiresAt.getTime())) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(user.githubOrgs);
  } catch {
    return null;
  }
  if (
    !Array.isArray(parsed) ||
    !parsed.every((org) => typeof org === "string")
  ) {
    return null;
  }

  return {
    orgs: parsed,
    expiresAt: expiresAt.toISOString()
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
  if (typeof user.githubLogin !== "string" || !user.githubLogin) return {};

  const claims: Record<string, unknown> = {
    [GITHUB_LOGIN_CLAIM]: user.githubLogin
  };

  const orgs = freshGithubOrgs(user, maxAgeMs, now);
  if (orgs) {
    claims[GITHUB_ORGS_CLAIM] = orgs.orgs;
    claims[GITHUB_ORGS_EXPIRES_AT_CLAIM] = orgs.expiresAt;
  }

  return claims;
}
