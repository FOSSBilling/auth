import { GITHUB_SCOPE } from "./github-claims";

// Better Auth 1.7.7 treats an individual UserInfo claim as an alternative to
// its backing scope. Keep the issuer's scope ceiling here, at the HTTP boundary.
export const OPAQUE_ACCESS_TOKEN_PREFIX = "fba_at_";
export const OAUTH_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  GITHUB_SCOPE
];

const CLAIM_SCOPE: Record<string, string> = {
  name: "profile",
  picture: "profile",
  given_name: "profile",
  family_name: "profile",
  email: "email",
  email_verified: "email"
};

function claimsObject(value: unknown): Record<string, unknown> | null {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
      return null;
    const userinfo = (parsed as { userinfo?: unknown }).userinfo;
    return userinfo !== null &&
      typeof userinfo === "object" &&
      !Array.isArray(userinfo)
      ? (userinfo as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function isAllowedClaim(claim: string, allowed: Set<string>): boolean {
  return !CLAIM_SCOPE[claim] || allowed.has(CLAIM_SCOPE[claim]);
}

export function permittedUserInfoClaims(
  value: unknown,
  scopes: readonly string[]
): Record<string, null> {
  const requested = claimsObject(value);
  if (!requested) return {};
  const allowed = new Set(scopes);
  return Object.fromEntries(
    Object.keys(requested)
      .filter((claim) => isAllowedClaim(claim, allowed))
      .map((claim) => [claim, null])
  );
}

export function hasUnscopedUserInfoClaims(
  value: unknown,
  scopes: readonly string[]
): boolean {
  const requested = claimsObject(value);
  if (!requested) return false; // The provider rejects malformed requests.
  const allowed = new Set(scopes);
  return Object.keys(requested).some(
    (claim) => CLAIM_SCOPE[claim] && !allowed.has(CLAIM_SCOPE[claim])
  );
}

export function filterUserInfoResponse(
  claims: Record<string, unknown>,
  scopes: readonly string[]
): Record<string, unknown> {
  const allowed = new Set(scopes);
  return Object.fromEntries(
    Object.entries(claims).filter(([claim]) => isAllowedClaim(claim, allowed))
  );
}
