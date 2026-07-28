import { logger } from "@better-auth/core/env";

// Overrides Better Auth's default GitHub getUserInfo so we can additionally
// read the user's own org memberships (requires the read:org scope granted
// in auth.ts) and persist both onto the user row as githubLogin/githubOrgs —
// see the comment on those columns in db/schema.ts for why.

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

async function fetchActiveOrgLogins(accessToken: string): Promise<string[]> {
  try {
    const response = await fetch(
      "https://api.github.com/user/memberships/orgs?state=active",
      { headers: GITHUB_API_HEADERS(accessToken) }
    );
    if (!response.ok) return [];
    const memberships = (await response.json()) as GithubOrgMembership[];
    return memberships.map((m) => m.organization.login.toLowerCase());
  } catch (error) {
    // Best-effort — org membership is only ever an additive verification
    // signal downstream, never something sign-in itself should fail on.
    logger.error("Failed to fetch GitHub org memberships:", error);
    return [];
  }
}

export async function getGithubUserInfo(token: { accessToken?: string }) {
  if (!token.accessToken) return null;
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

  const githubOrgs = await fetchActiveOrgLogins(token.accessToken);

  return {
    user: {
      id: String(profile.id),
      name: profile.name || profile.login,
      email,
      image: profile.avatar_url,
      emailVerified,
      githubLogin: profile.login,
      githubOrgs: JSON.stringify(githubOrgs)
    },
    data: profile
  };
}
