import { logger } from "@better-auth/core/env";

// Overrides Better Auth's default GitHub getUserInfo so we can additionally
// read the user's own org memberships (requires the read:org scope granted
// in auth.ts) and persist them onto the user row as githubLogin/githubOrgs,
// plus a successful-fetch timestamp — see the comment on those columns in
// db/schema.ts for why.
//
// Returning githubLogin/githubOrgs directly on getUserInfo's `user` object
// would NOT persist them: Better Auth's additionalFields `input: false`
// (required so a signed-in user can't forge these via POST /update-user)
// makes it strip any field with that flag out of the OAuth profile too,
// via the same schema used for client input. So this instead stashes the
// fetched values keyed by GitHub's numeric id (== the account row's
// accountId in every sign-in/link path) and auth.ts's databaseHooks reads
// them back once the account row lands, bypassing that filter entirely.
const pendingGithubProfiles = new Map<
  string,
  { login: string; orgs: string[] | null }
>();

export function consumeGithubProfile(
  accountId: string
): { login: string; orgs: string[] | null } | undefined {
  const profile = pendingGithubProfiles.get(accountId);
  pendingGithubProfiles.delete(accountId);
  return profile;
}

interface GithubProfile {
  id: number;
  login: string;
  name: string | null;
  email: string | null;
  avatar_url: string;
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
    // GitHub paginates this endpoint (default page size 30); loop until a
    // page comes back short of perPage instead of assuming a single page
    // covers every membership.
    for (let page = 1; ; page++) {
      const response = await fetch(
        `https://api.github.com/user/memberships/orgs?state=active&per_page=${perPage}&page=${page}`,
        { headers: GITHUB_API_HEADERS(accessToken) }
      );
      if (!response.ok) {
        logger.error(
          `Failed to fetch GitHub org memberships: status ${response.status}`
        );
        return null;
      }
      const memberships = (await response.json()) as GithubOrgMembership[];
      logins.push(
        ...memberships.map((m) => m.organization.login.toLowerCase())
      );
      if (memberships.length < perPage) break;
    }
    return logins;
  } catch (error) {
    // Best-effort — org membership is only ever an additive verification
    // signal downstream, never something sign-in itself should fail on.
    logger.error("Failed to fetch GitHub org memberships:", error);
    return null;
  }
}

export async function getGithubUserInfo(token: { accessToken?: string }) {
  if (!token.accessToken) return null;
  try {
    const headers = GITHUB_API_HEADERS(token.accessToken);

    const profileResponse = await fetch("https://api.github.com/user", {
      headers
    });
    if (!profileResponse.ok) return null;
    const profile = (await profileResponse.json()) as GithubProfile;

    let email = profile.email;
    let emailVerified = false;
    const emailsResponse = await fetch("https://api.github.com/user/emails", {
      headers
    });
    if (emailsResponse.ok) {
      const emails = (await emailsResponse.json()) as GithubEmail[];
      if (!email) {
        email = (emails.find((e) => e.primary) ?? emails[0])?.email ?? null;
      }
      emailVerified = emails.find((e) => e.email === email)?.verified ?? false;
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

    const githubOrgs = await fetchActiveOrgLogins(token.accessToken);
    pendingGithubProfiles.set(String(profile.id), {
      login: profile.login,
      orgs: githubOrgs
    });

    return {
      user: {
        id: String(profile.id),
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
