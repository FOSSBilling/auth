import { betterAuth } from "better-auth/minimal";
import { jwt } from "better-auth/plugins";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { oauthProvider } from "@better-auth/oauth-provider";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./db/schema";
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
    socialProviders: {
      github: {
        clientId: env.GITHUB_CLIENT_ID,
        clientSecret: env.GITHUB_CLIENT_SECRET
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
          "https://fossbilling.org/claims/user_id": user.id
        }),
        customAccessTokenClaims: ({ user }) => ({
          ...(user ? { "https://fossbilling.org/claims/user_id": user.id } : {})
        })
      })
    ]
  });
}

export type Auth = ReturnType<typeof createAuth>;
