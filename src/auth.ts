import { betterAuth } from "better-auth/minimal";
import type { BetterAuthOptions } from "better-auth";
import { jwt } from "better-auth/plugins";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { oauthProvider } from "@better-auth/oauth-provider";
import { waitUntil } from "cloudflare:workers";
import { and, eq, notExists, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./db/schema";
import { createGithubProfileStaging } from "./github";
import { cleanupFailedAccountCreation } from "./account-binding";
import { getAuthSecretOptions } from "./auth-secret";
import {
  githubClaims,
  getGithubOrgsMaxAgeMs,
  GITHUB_SCOPE
} from "./github-claims";
import {
  OAUTH_SCOPES,
  OPAQUE_ACCESS_TOKEN_PREFIX
} from "./oauth-userinfo-claims";
import type { Env } from "./types";
import { canManageOAuthClients } from "./client-privileges";
import { requireBetterAuthSecret } from "./auth-secret";

const PRODUCTION_URL = "https://auth.fossbilling.net";

function getBaseUrl(env: Env): string {
  return env.BETTER_AUTH_URL ?? PRODUCTION_URL;
}

function getTrustedOrigins(env: Env): string[] {
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

export function createAuth(env: Env) {
  // A configured legacy secret is still strength-validated; it becomes
  // optional only once a versioned keyring carries rotation state.
  const secret = env.BETTER_AUTH_SECRET
    ? requireBetterAuthSecret(env.BETTER_AUTH_SECRET)
    : undefined;
  const { getGithubUserInfo, consumeGithubProfile, clearGithubProfileStaging } =
    createGithubProfileStaging();
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
    // A failed fetch may retain last-known-good organization evidence only
    // for the same immutable GitHub identity. Evaluate that binding inside
    // the update so concurrent callbacks cannot mix identities and evidence.
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
          : {
              githubOrgs: sql`CASE WHEN ${schema.user.githubId} = ${account.accountId} THEN ${schema.user.githubOrgs} ELSE NULL END`,
              githubOrgsVerifiedAt: sql`CASE WHEN ${schema.user.githubId} = ${account.accountId} THEN ${schema.user.githubOrgsVerifiedAt} ELSE NULL END`
            })
      })
      .where(eq(schema.user.id, account.userId));
  }

  const auth = betterAuth({
    appName: "FOSSBilling",
    baseURL,
    basePath: "/",
    ...getAuthSecretOptions({
      BETTER_AUTH_SECRET: secret,
      BETTER_AUTH_SECRETS: env.BETTER_AUTH_SECRETS
    }),
    disabledPaths: ["/token"],
    advanced: {
      // Cloudflare sets this header from the connecting client; forwarded-for
      // headers can be supplied by the caller and must not select the bucket.
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
      // Sign-out revokes the session's tokens and can fire back-channel
      // logout calls to clients — waitUntil keeps those from being cut off
      // once the response is sent. cloudflare:workers' waitUntil attaches
      // to whichever request invokes it, so the cached auth instance stays
      // request-agnostic.
      backgroundTasks: { handler: waitUntil }
    },
    database: (options: BetterAuthOptions) =>
      cleanupFailedAccountCreation(
        drizzleAdapter(db, {
          provider: "sqlite",
          schema,
          camelCase: true
        })(options),
        async (userId) => {
          await db
            .delete(schema.user)
            .where(
              and(
                eq(schema.user.id, userId),
                notExists(
                  db
                    .select({ id: schema.account.id })
                    .from(schema.account)
                    .where(eq(schema.account.userId, userId))
                ),
                notExists(
                  db
                    .select({ id: schema.session.id })
                    .from(schema.session)
                    .where(eq(schema.session.userId, userId))
                )
              )
            );
        }
      ),
    rateLimit: {
      enabled: true,
      storage: "database"
    },
    trustedOrigins: getTrustedOrigins(env),
    user: {
      additionalFields: {
        // input: false blocks POST /update-user forgery; values are written
        // by databaseHooks below, which bypass the input filter.
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
    // Keeps name/image in sync on repeat sign-in or re-link in views.ts.
    account: {
      encryptOAuthTokens: true,
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
    // getGithubUserInfo stashes login/orgs keyed by GitHub account id;
    // the account row is the step common to all sign-in/link paths, so pick
    // the values back up here with a direct query.
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
        scopes: OAUTH_SCOPES,
        advertisedMetadata: {
          scopes_supported: OAUTH_SCOPES,
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
        clientPrivileges: ({ user, session }) =>
          canManageOAuthClients(env, user, session),
        accessTokenExpiresIn: 60 * 60,
        idTokenExpiresIn: 60 * 60,
        refreshTokenExpiresIn: 60 * 60 * 24 * 30,
        prefix: {
          clientSecret: "fba_cs_",
          opaqueAccessToken: OPAQUE_ACCESS_TOKEN_PREFIX,
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

  return Object.assign(auth, { clearGithubProfileStaging });
}

export type Auth = ReturnType<typeof createAuth>;

// Constructing the instance validates options and builds the adapter and
// plugin pipeline — a few ms of CPU per construction (measured). Cache one
// instance per isolate instead of paying that on every request. Secrets and
// vars only change with a new deployment, but Cloudflare may reuse isolates
// across binding-only changes, and the Drizzle adapter closes over the
// AUTH_DB binding — so the binding's object identity invalidates the cache
// too, keeping the HTTP path and the scheduled handler (which reads
// env.AUTH_DB directly) on the same database.
let cachedAuth: { key: string; auth: Auth; db: D1Database } | null = null;

export function getAuth(env: Env): Auth {
  const key = JSON.stringify([
    env.BETTER_AUTH_URL,
    env.BETTER_AUTH_SECRET,
    env.BETTER_AUTH_SECRETS,
    env.GITHUB_CLIENT_ID,
    env.GITHUB_CLIENT_SECRET,
    env.GITHUB_ORGS_MAX_AGE_SECONDS,
    env.ADMIN_USER_IDS
  ]);
  if (!cachedAuth || cachedAuth.key !== key || cachedAuth.db !== env.AUTH_DB) {
    cachedAuth = { key, auth: createAuth(env), db: env.AUTH_DB };
  }
  return cachedAuth.auth;
}
