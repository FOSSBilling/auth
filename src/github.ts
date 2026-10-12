import { logger } from "@better-auth/core/env";
import { AsyncLocalStorage } from "node:async_hooks";
import type { GithubProfile } from "better-auth/social-providers";
import {
  fitsGithubOrgsBudget,
  MAX_GITHUB_ORG_FETCH_MS,
  MAX_GITHUB_ORG_PAGES,
  MAX_GITHUB_ORG_RESPONSE_BYTES
} from "./github-claims.ts";

// Also reads the user's org memberships (needs the read:org scope in
// auth.ts) and persists them as githubLogin/githubOrgs — see db/schema.ts.
// getUserInfo cannot return these directly: additionalFields `input: false`
// strips them from OAuth profiles too, so they are stashed here keyed by
// GitHub id and picked up by auth.ts's databaseHooks. The pending-profile
// map is request-scoped (see runWithGithubProfileStaging) so rejected
// callbacks cannot leak into other requests sharing the cached auth
// instance within a Worker isolate.
type GithubProfileEvidence = {
  login: string;
  loginVerifiedAt: string;
  orgs: string[] | null;
};

// AsyncLocalStorage propagates the store through better-auth's awaits:
// getGithubUserInfo stashes during the callback and the databaseHooks pick
// the values back up within the same request's async chain. Callers that
// never enter the scope (direct createAuth use, e.g. tests) fall back to a
// per-instance map, matching the pre-ALS per-request construction behavior.
const staging = new AsyncLocalStorage<Map<string, GithubProfileEvidence>>();

export function runWithGithubProfileStaging<T>(fn: () => T): T {
  return staging.run(new Map(), fn);
}

interface GithubEmail {
  email: string;
  primary: boolean;
  verified: boolean;
}

interface GithubOrgMembership {
  organization: { login: string };
}

const GITHUB_API_HEADERS = (accessToken: string) => ({
  "User-Agent": "FOSSBilling-auth",
  Authorization: `Bearer ${accessToken}`
});

async function readBoundedMemberships(
  response: Response
): Promise<GithubOrgMembership[] | null> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_GITHUB_ORG_RESPONSE_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (
    !Array.isArray(parsed) ||
    parsed.length > 100 ||
    !parsed.every(
      (item) =>
        item &&
        typeof item === "object" &&
        "organization" in item &&
        item.organization &&
        typeof item.organization === "object" &&
        "login" in item.organization &&
        typeof item.organization.login === "string"
    )
  ) {
    return null;
  }
  return parsed as GithubOrgMembership[];
}

// Returns null on any failure (rather than a possibly-partial array) so
// callers can tell "confirmed zero active memberships" apart from "couldn't
// tell" — persisting the latter as the former would overwrite a
// previously-verified githubOrgs with an empty one on a transient GitHub
// API hiccup, silently un-verifying every claim that depended on it.
async function fetchActiveOrgLogins(
  accessToken: string
): Promise<string[] | null> {
  try {
    const logins: string[] = [];
    const perPage = 100;
    const deadline = Date.now() + MAX_GITHUB_ORG_FETCH_MS;
    const signal = AbortSignal.timeout(MAX_GITHUB_ORG_FETCH_MS);
    // GitHub paginates this endpoint (default page size 30); loop until a
    // page comes back short of perPage instead of assuming a single page
    // covers every membership.
    for (let page = 1; page <= MAX_GITHUB_ORG_PAGES; page++) {
      if (Date.now() >= deadline) return null;
      const response = await fetch(
        `https://api.github.com/user/memberships/orgs?state=active&per_page=${perPage}&page=${page}`,
        { headers: GITHUB_API_HEADERS(accessToken), signal }
      );
      if (!response.ok) {
        logger.error(
          `Failed to fetch GitHub org memberships: status ${response.status}`
        );
        return null;
      }
      const memberships = await readBoundedMemberships(response);
      if (!memberships || Date.now() >= deadline) return null;
      logins.push(
        ...memberships.map((m) => m.organization.login.toLowerCase())
      );
      if (!fitsGithubOrgsBudget(logins)) return null;
      if (memberships.length < perPage) break;
      // A full final page is not proof that the list is complete.
      if (page === MAX_GITHUB_ORG_PAGES) return null;
    }
    return logins;
  } catch (error) {
    // Best-effort — org membership is only ever an additive verification
    // signal downstream, never something sign-in itself should fail on.
    logger.error("Failed to fetch GitHub org memberships:", error);
    return null;
  }
}

export function createGithubProfileStaging() {
  const fallback = new Map<string, GithubProfileEvidence>();

  function pendingProfiles(): Map<string, GithubProfileEvidence> {
    return staging.getStore() ?? fallback;
  }

  function consumeGithubProfile(
    accountId: string
  ): GithubProfileEvidence | undefined {
    const profiles = pendingProfiles();
    const profile = profiles.get(accountId);
    profiles.delete(accountId);
    return profile;
  }

  function clearGithubProfileStaging() {
    pendingProfiles().clear();
  }

  async function getGithubUserInfo(token: { accessToken?: string }) {
    if (!token.accessToken) return null;
    try {
      const headers = GITHUB_API_HEADERS(token.accessToken);
      // All three calls only need the token, so overlap the emails and
      // org-membership round trips with the profile fetch instead of
      // trailing behind it.
      const orgsPending = fetchActiveOrgLogins(token.accessToken);
      // Awaiting the two responses together keeps either fetch's rejection
      // inside the surrounding try — a later, conditional await would miss
      // it on the early-return path below.
      const [profileResponse, emailsResponse] = await Promise.all([
        fetch("https://api.github.com/user", { headers }),
        fetch("https://api.github.com/user/emails", { headers })
      ]);
      if (!profileResponse.ok) return null;
      const profile = (await profileResponse.json()) as GithubProfile;
      const loginVerifiedAt = new Date().toISOString();

      let email = profile.email;
      let emailVerified = false;
      if (emailsResponse.ok) {
        const emails = (await emailsResponse.json()) as GithubEmail[];
        if (!email) {
          email = (emails.find((e) => e.primary) ?? emails[0])?.email ?? null;
        }
        emailVerified =
          emails.find((e) => e.email === email)?.verified ?? false;
      }

      // better-auth's user.email column is NOT NULL, and overrideUserInfoOnSignIn
      // means this return value overwrites the existing row — a GitHub account
      // with no accessible email (none set, all private) must fail the sign-in
      // rather than risk writing/overwriting email with null.
      if (!email) {
        logger.error(
          `GitHub sign-in has no accessible email for GitHub user ${profile.id}`
        );
        return null;
      }

      const githubOrgs = await orgsPending;
      pendingProfiles().set(String(profile.id), {
        login: profile.login,
        loginVerifiedAt,
        orgs: githubOrgs
      });

      return {
        // better-auth resolves the account's provider-assigned id from
        // `data` (below) via the github provider's `accountSubject`, not from
        // `user.id` — `user` is only ever applied to the local user row, so
        // an `id` field here would be inert at best.
        user: {
          name: profile.name || profile.login,
          email,
          image: profile.avatar_url,
          emailVerified
        },
        data: profile
      };
    } catch (error) {
      logger.error("Failed to fetch GitHub user info:", error);
      return null;
    }
  }

  return {
    getGithubUserInfo,
    consumeGithubProfile,
    clearGithubProfileStaging
  };
}
