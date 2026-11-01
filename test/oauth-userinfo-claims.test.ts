import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { betterAuth } from "better-auth/minimal";
import { memoryAdapter } from "better-auth/adapters/memory";
import { jwt } from "better-auth/plugins";
import { oauthProvider } from "@better-auth/oauth-provider";
import type { Env } from "../src/types.ts";
import { registerRouterTestHooks } from "./_hooks.ts";

const forwarded: Request[] = [];
const globals = globalThis as typeof globalThis & {
  oauthClaimsTestAuth: {
    handler: (request: Request) => Promise<Response>;
    clearGithubProfileStaging: () => void;
  };
};
globals.oauthClaimsTestAuth = {
  clearGithubProfileStaging: () => {},
  handler: async (request) => {
    forwarded.push(request);
    if (new URL(request.url).pathname === "/oauth2/userinfo") {
      if (request.method === "POST") await request.text();
      return Response.json({
        sub: "user-1",
        email: "person@example.test",
        email_verified: true,
        name: "Person",
        picture: "https://example.test/avatar.png"
      });
    }
    return Response.json({ ok: true });
  }
};

const hooks = registerRouterTestHooks(
  `export function getAuth() { return globalThis.oauthClaimsTestAuth; }
   export function isTrustedCallbackUrl() { return false; }`
);
const { default: app } = await import("../src/index.ts");
const { OAUTH_SCOPES, PROVIDER_SCOPES, EXTENSIONS_M2M_SCOPES } =
  await import("../src/oauth-userinfo-claims.ts");
hooks.deregister();
let clientScopes: string[] | null = ["openid", "email"];
let tokenScopes: string[] = ["openid"];
let storedTokenLookup: unknown;
const env = {
  AUTH_DB: {
    prepare(statement: string) {
      return {
        bind(value: unknown) {
          if (statement.includes("FROM oauthAccessToken"))
            storedTokenLookup = value;
          return {
            async first() {
              if (statement.includes("FROM oauthClient"))
                return {
                  scopes:
                    clientScopes === null ? null : JSON.stringify(clientScopes)
                };
              return { scopes: JSON.stringify(tokenScopes) };
            }
          };
        }
      };
    }
  }
} as unknown as Env;
const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} };

test("provider scope list adds only the M2M extensions scopes", () => {
  assert.deepEqual(EXTENSIONS_M2M_SCOPES, [
    "extensions:push",
    "extensions:publish"
  ]);
  assert.deepEqual(PROVIDER_SCOPES, [
    ...OAUTH_SCOPES,
    ...EXTENSIONS_M2M_SCOPES
  ]);
  assert.ok(
    !OAUTH_SCOPES.some((scope) => scope.startsWith("extensions:")),
    "user-facing scope ceiling keeps no M2M scopes"
  );
});

test("authorize blocks hidden UserInfo claims in GET and form POST", async () => {
  const claims = JSON.stringify({ userinfo: { email: null } });
  for (const request of [
    new Request(
      `https://auth.example.test/oauth2/authorize?scope=openid&claims=${encodeURIComponent(claims)}`
    ),
    new Request("https://auth.example.test/oauth2/authorize", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        scope: "openid",
        claims: JSON.stringify({ userinfo: { name: null } })
      })
    }),
    new Request(
      `https://auth.example.test/oauth2/authorize?claims=${encodeURIComponent(claims)}&claims=%7B%7D`
    )
  ]) {
    const response = await app.fetch(request, env, ctx);
    assert.equal(response.status, 200);
    const providerRequest = forwarded.at(-1);
    assert.ok(providerRequest);
    const params =
      providerRequest.method === "POST"
        ? new URLSearchParams(await providerRequest.clone().text())
        : new URL(providerRequest.url).searchParams;
    assert.deepEqual(params.getAll("claims"), ["null"]);
  }
});

test("authorize preserves ordinary scopes and ID-token-only claim requests", async () => {
  const permittedClaims = JSON.stringify({ userinfo: { email: null } });
  for (const query of [
    "scope=openid%20email",
    new URLSearchParams({
      scope: "openid email",
      claims: permittedClaims
    }).toString(),
    new URLSearchParams({
      scope: "openid",
      claims: JSON.stringify({ id_token: { auth_time: { essential: true } } })
    }).toString()
  ]) {
    const response = await app.fetch(
      new Request(`https://auth.example.test/oauth2/authorize?${query}`),
      env,
      ctx
    );
    assert.equal(response.status, 200);
    if (query.includes("userinfo"))
      assert.equal(
        new URL(forwarded.at(-1)?.url ?? "").searchParams.get("claims"),
        permittedClaims
      );
  }
  const body = new URLSearchParams({
    scope: "openid",
    claims: JSON.stringify({ id_token: { auth_time: { essential: true } } })
  });
  const response = await app.fetch(
    new Request(
      `https://auth.example.test/oauth2/authorize?claims=${encodeURIComponent(JSON.stringify({ userinfo: { email: null } }))}`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body
      }
    ),
    env,
    ctx
  );
  assert.equal(response.status, 200);
  assert.equal(await forwarded.at(-1)?.text(), body.toString());

  const defaultScopeResponse = await app.fetch(
    new Request(
      `https://auth.example.test/oauth2/authorize?${new URLSearchParams({
        client_id: "client-with-email",
        claims: JSON.stringify({ userinfo: { email: null } })
      })}`
    ),
    env,
    ctx
  );
  assert.equal(defaultScopeResponse.status, 200);
  assert.notEqual(
    new URL(forwarded.at(-1)?.url ?? "").searchParams.get("claims"),
    "null"
  );
});

test("consent accepts only claims covered by accepted visible scopes", async () => {
  const oauth_query = new URLSearchParams({
    scope: "openid email",
    claims: JSON.stringify({ userinfo: { email: null, name: null } })
  }).toString();
  const response = await app.fetch(
    new Request("https://auth.example.test/oauth2/consent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accept: true, oauth_query })
    }),
    env,
    ctx
  );
  assert.equal(response.status, 200);
  const body = await forwarded.at(-1)?.json();
  assert.deepEqual(body, {
    accept: true,
    oauth_query,
    claims: { userinfo: { email: null } }
  });

  await app.fetch(
    new Request("https://auth.example.test/oauth2/consent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accept: true, scope: "openid", oauth_query })
    }),
    env,
    ctx
  );
  const narrowedBody = (await forwarded.at(-1)?.json()) as {
    claims: unknown;
  };
  assert.deepEqual(narrowedBody.claims, { userinfo: {} });
});

test("UserInfo strips old opaque-token claims outside stored scopes", async () => {
  tokenScopes = ["openid"];
  const request = new Request("https://auth.example.test/oauth2/userinfo", {
    headers: { authorization: "Bearer fba_at_old-token" }
  });
  const response = await app.fetch(request, env, ctx);
  assert.equal(response.status, 200);
  assert.equal(
    storedTokenLookup,
    createHash("sha256").update("old-token").digest("base64url")
  );
  assert.deepEqual(await response.json(), { sub: "user-1" });

  tokenScopes = ["openid", "email"];
  const allowedResponse = await app.fetch(request, env, ctx);
  assert.equal(allowedResponse.status, 200);
  assert.deepEqual(await allowedResponse.json(), {
    sub: "user-1",
    email: "person@example.test",
    email_verified: true
  });

  tokenScopes = ["openid"];
  const postResponse = await app.fetch(
    new Request("https://auth.example.test/oauth2/userinfo", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ access_token: "fba_at_old-token" })
    }),
    env,
    ctx
  );
  assert.equal(postResponse.status, 200);
  assert.deepEqual(await postResponse.json(), { sub: "user-1" });
});

test("provider rejects the guarded claim value with a registered-client OAuth error", async () => {
  const auth = betterAuth({
    baseURL: "https://auth.example.test",
    basePath: "/",
    secret: "test-only-secret-at-least-thirty-two-characters",
    database: memoryAdapter({ oauthClient: [] }),
    plugins: [
      jwt({ disableSettingJwtHeader: true }),
      oauthProvider({
        loginPage: "/sign-in",
        consentPage: "/consent",
        scopes: ["openid", "profile", "email"]
      })
    ],
    logger: { disabled: true }
  });
  const context = await auth.$context;
  await context.adapter.create({
    model: "oauthClient",
    data: {
      clientId: "openid-only",
      redirectUris: ["https://client.example.test/callback"],
      scopes: ["openid"],
      grantTypes: ["authorization_code"]
    }
  });
  const response = await auth.handler(
    new Request(
      `https://auth.example.test/oauth2/authorize?${new URLSearchParams({
        response_type: "code",
        client_id: "openid-only",
        redirect_uri: "https://client.example.test/callback",
        scope: "openid",
        state: "client-state",
        claims: "null"
      })}`
    )
  );
  assert.equal(response.status, 302);
  const redirect = new URL(response.headers.get("location") ?? "");
  assert.equal(redirect.origin, "https://client.example.test");
  assert.equal(redirect.searchParams.get("error"), "invalid_request");
  assert.equal(redirect.searchParams.get("state"), "client-state");
  assert.equal(redirect.searchParams.get("code"), null);

  await context.adapter.create({
    model: "oauthClient",
    data: {
      clientId: "email-client",
      redirectUris: ["https://client.example.test/callback"],
      scopes: ["openid", "email"],
      grantTypes: ["authorization_code"]
    }
  });
  const allowed = await auth.handler(
    new Request(
      `https://auth.example.test/oauth2/authorize?${new URLSearchParams({
        response_type: "code",
        client_id: "email-client",
        redirect_uri: "https://client.example.test/callback",
        scope: "openid email",
        code_challenge: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        code_challenge_method: "S256",
        claims: JSON.stringify({ userinfo: { email: null } })
      })}`
    )
  );
  assert.equal(allowed.status, 302);
  assert.match(allowed.headers.get("location") ?? "", /\/sign-in/);
});
