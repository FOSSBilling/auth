import { betterAuth } from "better-auth/minimal";
import { jwt } from "better-auth/plugins";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { oauthProvider } from "@better-auth/oauth-provider";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./db/schema";
import { getGithubUserInfo } from "./github";
import type { Env } from "./types";

const PRODUCTION_URL = "https://auth.fossbilling.net";

export function getBaseUrl(env: Env): string {
  return env.BETTER_AUTH_URL ?? PRODUCTION_URL;
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
  const githubOrgs = user.githubOrgs as string | null | undefined;
  if (!githubLogin) return {};
  return {
    "https://fossbilling.org/claims/github_login": githubLogin,
    "https://fossbilling.org/claims/github_orgs": githubOrgs
      ? (JSON.parse(githubOrgs) as string[])
      : []
  };
}

export function createAuth(env: Env) {
  const baseURL = getBaseUrl(env);
  const db = drizzle(env.AUTH_DB, { schema });

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
    trustedOrigins: [
      baseURL,
      "https://extensions.fossbilling.org",
      ...(baseURL !== PRODUCTION_URL
        ? ["http://localhost:4321", "http://localhost:8787"]
        : [])
    ],
    user: {
      additionalFields: {
        // Populated from getGithubUserInfo's return value — see the column
        // comment in db/schema.ts.
        githubLogin: { type: "string", required: false, input: false },
        githubOrgs: { type: "string", required: false, input: false }
      }
    },
    // Without these, re-running getGithubUserInfo on an already-linked
    // account (a regular repeat sign-in, or the explicit re-link flow in
    // views.ts) refreshes the account's tokens/scope but not
    // githubLogin/githubOrgs on the user row — org membership can change
    // over time, so both paths need to actually pick that up.
    account: {
      accountLinking: {
        updateUserInfoOnLink: true
      }
    },
    socialProviders: {
      github: {
        clientId: env.GITHUB_CLIENT_ID,
        clientSecret: env.GITHUB_CLIENT_SECRET,
        // read:org lets getGithubUserInfo see the user's own org
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
