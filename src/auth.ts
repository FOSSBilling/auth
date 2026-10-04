import { betterAuth } from "better-auth/minimal";
import { jwt } from "better-auth/plugins";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { oauthProvider } from "@better-auth/oauth-provider";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./db/schema";
import { getGithubUserInfo, consumeGithubProfile } from "./github";
import {
  githubClaims,
  getGithubOrgsMaxAgeMs,
  GITHUB_SCOPE
} from "./github-claims";
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

// A structural subset of ExecutionContext, so this doesn't depend on
// whichever workers-types version generated worker-configuration.d.ts —
// Hono's own ExecutionContext (c.executionCtx in index.ts) satisfies it.
type BackgroundTaskContext = {
  waitUntil(promise: Promise<unknown>): void;
};

export function createAuth(env: Env, executionCtx?: BackgroundTaskContext) {
  const baseURL = getBaseUrl(env);
  const db = drizzle(env.AUTH_DB, { schema });
  const githubOrgsMaxAgeMs = getGithubOrgsMaxAgeMs(
    env.GITHUB_ORGS_MAX_AGE_SECONDS
  );

  async function persistGithubProfile(account: {
    accountId: string;
    userId: string;
  }) {
    const profile = consumeGithubProfile(account.accountId);
    if (!profile) return;
    // orgs is null when fetchActiveOrgLogins couldn't complete (rate limit,
    // transient GitHub error) — leave the existing githubOrgs value and its
    // verification time alone rather than overwriting confirmed data with
    // "couldn't tell" or extending its lifetime.
    await db
      .update(schema.user)
      .set({
        githubId: account.accountId,
        githubLogin: profile.login,
        githubLoginVerifiedAt: profile.loginVerifiedAt,
        ...(profile.orgs !== null
          ? {
              githubOrgs: JSON.stringify(profile.orgs),
              githubOrgsVerifiedAt: new Date().toISOString()
            }
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
    advanced: {
      // Sign-out revokes the session's tokens and can fire back-channel
      // logout calls to clients — waitUntil keeps those from being cut off
      // once the response is sent.
      backgroundTasks: executionCtx
        ? { handler: (promise) => executionCtx.waitUntil(promise) }
        : undefined
    },
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
        githubId: { type: "string", required: false, input: false },
        githubLoginVerifiedAt: {
          type: "string",
          required: false,
          input: false
        },
        githubLogin: { type: "string", required: false, input: false },
        githubOrgs: { type: "string", required: false, input: false },
        githubOrgsVerifiedAt: {
          type: "string",
          required: false,
          input: false
        }
      }
    },
    // Keeps name/image in sync on a repeat sign-in or the explicit re-link
    // flow in views.ts. githubLogin/githubOrgs are handled separately by the
    // databaseHooks below — see the additionalFields comment above for why.
    account: {
      // Keep unauthenticated OAuth starts from writing verification rows to D1.
      // Better Auth encrypts the state cookie and validates it on callback.
      storeStateStrategy: "cookie",
      accountLinking: {
        // Email addresses can be reassigned; only an authenticated user may
        // authorize linking a new GitHub identity to an existing account.
        disableImplicitLinking: true,
        requireLocalEmailVerified: true,
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
        scopes: ["openid", "profile", "email", "offline_access", GITHUB_SCOPE],
        advertisedMetadata: {
          scopes_supported: [
            "openid",
            "profile",
            "email",
            "offline_access",
            GITHUB_SCOPE
          ],
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
            "picture",
            "https://fossbilling.org/claims/user_id",
            "https://fossbilling.org/claims/github_id",
            "https://fossbilling.org/claims/github_login",
            "https://fossbilling.org/claims/github_login_expires_at",
            "https://fossbilling.org/claims/github_orgs",
            "https://fossbilling.org/claims/github_orgs_expires_at"
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
        customIdTokenClaims: ({ user, scopes }) => ({
          "https://fossbilling.org/claims/user_id": user.id,
          ...githubClaims(user, githubOrgsMaxAgeMs, scopes)
        }),
        customAccessTokenClaims: ({ user, scopes }) => ({
          ...(user
            ? {
                "https://fossbilling.org/claims/user_id": user.id,
                ...githubClaims(user, githubOrgsMaxAgeMs, scopes)
              }
            : {})
        }),
        customUserInfoClaims: ({ user, scopes }) => ({
          "https://fossbilling.org/claims/user_id": user.id,
          ...githubClaims(user, githubOrgsMaxAgeMs, scopes)
        })
      })
    ]
  });
}

export type Auth = ReturnType<typeof createAuth>;
