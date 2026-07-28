import { betterAuth } from "better-auth/minimal";
import { jwt } from "better-auth/plugins";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { oauthProvider } from "@better-auth/oauth-provider";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./db/schema";
import { getGithubUserInfo, consumeGithubProfile } from "./github";
import type { Env } from "./types";

const PRODUCTION_URL = "https://auth.fossbilling.net";

export function getBaseUrl(env: Env): string {
  return env.BETTER_AUTH_URL ?? PRODUCTION_URL;
}

export function getTrustedOrigins(env: Env): string[] {
  const baseURL = getBaseUrl(env);
  return [
    baseURL,
    "https://extensions.fossbilling.org",
    ...(baseURL !== PRODUCTION_URL
      ? ["http://localhost:4321", "http://localhost:8787"]
      : [])
  ];
}

// Used to gate the /account page's callbackURL query param — better-auth's
// own /link-social endpoint doesn't validate callbackURL against
// trustedOrigins itself (unlike sign-in/reset-password routes), so we do it
// here before ever handing that URL back to the client.
export function isTrustedCallbackUrl(env: Env, url: string): boolean {
  try {
    return getTrustedOrigins(env).includes(new URL(url).origin);
  } catch {
    return false;
  }
}

function isAdminEmail(env: Env, email?: string | null): boolean {
  if (!email) return false;
  const admins = (env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  return admins.includes(email.toLowerCase());
}

// Omitted entirely (rather than emitted as null/[]) when a user has never
// completed a GitHub sign-in since the githubLogin/githubOrgs columns were
// added — downstream consumers treat a missing claim the same as "unknown",
// never as "confirmed not a member of anything".
function githubClaims(user: Record<string, unknown>) {
  const githubLogin = user.githubLogin as string | null | undefined;
  const githubOrgsRaw = user.githubOrgs as string | null | undefined;
  if (!githubLogin) return {};
  let githubOrgs: string[] = [];
  if (githubOrgsRaw) {
    try {
      githubOrgs = JSON.parse(githubOrgsRaw) as string[];
    } catch {
      // Malformed stored value shouldn't break token/userinfo issuance —
      // treat it the same as "no orgs" rather than throwing.
      githubOrgs = [];
    }
  }
  return {
    "https://fossbilling.org/claims/github_login": githubLogin,
    "https://fossbilling.org/claims/github_orgs": githubOrgs
  };
}

export function createAuth(env: Env) {
  const baseURL = getBaseUrl(env);
  const db = drizzle(env.AUTH_DB, { schema });

  async function persistGithubProfile(account: {
    accountId: string;
    userId: string;
  }) {
    const profile = consumeGithubProfile(account.accountId);
    if (!profile) return;
    // orgs is null when fetchActiveOrgLogins couldn't complete (rate limit,
    // transient GitHub error) — leave the existing githubOrgs value alone
    // rather than overwriting confirmed data with "couldn't tell".
    await db
      .update(schema.user)
      .set({
        githubLogin: profile.login,
        ...(profile.orgs !== null
          ? { githubOrgs: JSON.stringify(profile.orgs) }
          : {})
      })
      .where(eq(schema.user.id, account.userId));
  }

  return betterAuth({
    appName: "FOSSBilling",
    baseURL,
    basePath: "/",
    secret: env.BETTER_AUTH_SECRET,
    disabledPaths: ["/token"],
    database: drizzleAdapter(db, {
      provider: "sqlite",
      schema,
      camelCase: true
    }),
    trustedOrigins: getTrustedOrigins(env),
    user: {
      additionalFields: {
        // input: false only blocks these from POST /update-user (so a user
        // can't forge their own verified org membership) — it does NOT get
        // them populated from getUserInfo/OAuth profile data, since Better
        // Auth runs both through the same input-filtered parser. They're
        // actually written by the databaseHooks below instead.
        githubLogin: { type: "string", required: false, input: false },
        githubOrgs: { type: "string", required: false, input: false }
      }
    },
    // Keeps name/image in sync on a repeat sign-in or the explicit re-link
    // flow in views.ts. githubLogin/githubOrgs are handled separately by the
    // databaseHooks below — see the additionalFields comment above for why.
    account: {
      accountLinking: {
        updateUserInfoOnLink: true
      }
    },
    // getGithubUserInfo (github.ts) stashes the freshly-fetched
    // githubLogin/githubOrgs keyed by the GitHub account's numeric id, which
    // is always the account row's accountId — in every sign-in/link path,
    // creating or updating that account row is the one step common to all of
    // them. Picking the values back up here, and writing them with a direct
    // query, sidesteps the additionalFields input-filter issue noted above.
    databaseHooks: {
      account: {
        create: { after: persistGithubProfile },
        update: { after: persistGithubProfile }
      }
    },
    socialProviders: {
      github: {
        clientId: env.GITHUB_CLIENT_ID,
        clientSecret: env.GITHUB_CLIENT_SECRET,
        // Additive, not a replacement: better-auth's github provider always
        // requests its default read:user/user:email scopes regardless of
        // this list (see createAuthorizationURL in
        // @better-auth/core/social-providers/github.ts). This only adds
        // read:org on top, so getGithubUserInfo can see the user's own org
        // memberships (including private ones) to persist githubOrgs below.
        scope: ["read:org"],
        getUserInfo: getGithubUserInfo,
        overrideUserInfoOnSignIn: true
      }
    },
    plugins: [
      jwt({
        disableSettingJwtHeader: true,
        jwks: {
          jwksPath: "/.well-known/jwks.json"
        },
        jwt: {
          issuer: baseURL
        }
      }),
      oauthProvider({
        loginPage: "/sign-in",
        consentPage: "/consent",
        scopes: ["openid", "profile", "email", "offline_access"],
        advertisedMetadata: {
          scopes_supported: ["openid", "profile", "email", "offline_access"],
          claims_supported: [
            "sub",
            "iss",
            "aud",
            "exp",
            "iat",
            "sid",
            "scope",
            "azp",
            "name",
            "email",
            "email_verified",
            "picture"
          ]
        },
        grantTypes: [
          "authorization_code",
          "refresh_token",
          "client_credentials"
        ],
        allowDynamicClientRegistration: false,
        allowUnauthenticatedClientRegistration: false,
        clientPrivileges: ({ user }) =>
          Boolean(user?.emailVerified) && isAdminEmail(env, user?.email),
        accessTokenExpiresIn: 60 * 60,
        idTokenExpiresIn: 60 * 60,
        refreshTokenExpiresIn: 60 * 60 * 24 * 30,
        prefix: {
          clientSecret: "fba_cs_",
          opaqueAccessToken: "fba_at_",
          refreshToken: "fba_rt_"
        },
        customIdTokenClaims: ({ user }) => ({
          "https://fossbilling.org/claims/user_id": user.id,
          ...githubClaims(user)
        }),
        customAccessTokenClaims: ({ user }) => ({
          ...(user
            ? {
                "https://fossbilling.org/claims/user_id": user.id,
                ...githubClaims(user)
              }
            : {})
        }),
        customUserInfoClaims: ({ user }) => ({
          "https://fossbilling.org/claims/user_id": user.id,
          ...githubClaims(user)
        })
      })
    ]
  });
}

export type Auth = ReturnType<typeof createAuth>;
