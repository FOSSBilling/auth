import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { registerRouterTestHooks } from "./_hooks.ts";
import type { Env } from "../src/types.ts";

const { publicKey, privateKey } = await generateKeyPair("RS256");
const jwk = { ...(await exportJWK(publicKey)), kid: "test-key", alg: "RS256" };
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input) => {
  assert.equal(
    String(input),
    "https://token.actions.githubusercontent.com/.well-known/jwks"
  );
  return Response.json({ keys: [jwk] });
};
after(() => {
  globalThis.fetch = originalFetch;
});
const hooks = registerRouterTestHooks(`
  export function getAuth() { return {}; }
  export function isTrustedCallbackUrl() { return false; }
`);
const { default: app } = await import("../src/index.ts");
hooks.deregister();
const db = new DatabaseSync(":memory:");
db.exec(
  "CREATE TABLE oauthClient (clientId TEXT PRIMARY KEY, redirectUris TEXT, updatedAt INTEGER)"
);
const staging =
  "https://staging-extensions.fossbilling.workers.dev/auth/callback";
const old = "https://old-extensions.fossbilling.workers.dev/auth/callback";
const current =
  "https://current--extensions.fossbilling.workers.dev/auth/callback";
const env = {
  EXTENSIONS_PREVIEW_CLIENT_ID: "previews",
  AUTH_DB: {
    prepare(sql: string) {
      return {
        bind(...values: Array<string | number>) {
          return {
            async first() {
              return db.prepare(sql).get(...values);
            }
          };
        }
      };
    }
  }
} as unknown as Env;
beforeEach(() => {
  db.exec("DELETE FROM oauthClient");
  const insert = db.prepare("INSERT INTO oauthClient VALUES (?, ?, 0)");
  insert.run("previews", JSON.stringify([old]));
  insert.run(
    "development",
    JSON.stringify(["http://localhost:4321/auth/callback"])
  );
  insert.run(
    "production",
    JSON.stringify(["https://extensions.fossbilling.org/auth/callback"])
  );
});
async function token(overrides = {}) {
  return new SignJWT({
    repository_id: "557829655",
    workflow_ref:
      "FOSSBilling/extensions/.github/workflows/preview-auth.yml@refs/heads/main",
    ...overrides
  })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer("https://token.actions.githubusercontent.com")
    .setAudience(
      "https://auth.fossbilling.net/integrations/extensions-preview-callbacks"
    )
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
}
async function request(body: unknown, bearer?: string, bindings = env) {
  return app.fetch(
    new Request(
      "https://auth.fossbilling.net/integrations/extensions-preview-callbacks",
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          ...(bearer ? { Authorization: `Bearer ${bearer}` } : {})
        },
        body: JSON.stringify(body)
      }
    ),
    bindings
  );
}
function callbacks(clientId = "previews"): string[] {
  const row = db
    .prepare("SELECT redirectUris FROM oauthClient WHERE clientId = ?")
    .get(clientId)!;
  return JSON.parse(row.redirectUris as string);
}

test("trusted workflow replaces Preview callbacks without changing other clients", async () => {
  const response = await request([current, current, staging], await token());
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(callbacks().sort(), [current, staging].sort());
  assert.deepEqual(callbacks("development"), [
    "http://localhost:4321/auth/callback"
  ]);
  assert.deepEqual(callbacks("production"), [
    "https://extensions.fossbilling.org/auth/callback"
  ]);
  assert.equal((await request([], await token())).status, 204);
  assert.deepEqual(callbacks(), []);
});
test("missing or invalid credentials and untrusted workflows cannot write", async () => {
  for (const bearer of [
    undefined,
    "invalid",
    await token({ repository_id: "other" }),
    await token({
      workflow_ref:
        "FOSSBilling/extensions/.github/workflows/preview-auth.yml@refs/heads/feature"
    })
  ]) {
    assert.ok([401, 403].includes((await request([current], bearer)).status));
    assert.deepEqual(callbacks(), [old]);
  }
});
test("valid tokens cannot register callbacks outside the Preview namespace", async () => {
  for (const uri of [
    "https://evil.example/auth/callback",
    "https://test-extensions.fossbilling.workers.dev.evil.example/auth/callback",
    current + "?redirect=evil",
    "http://test-extensions.fossbilling.workers.dev/auth/callback"
  ]) {
    assert.equal((await request([uri], await token())).status, 400);
    assert.deepEqual(callbacks(), [old]);
  }
});
test("a missing target client fails closed", async () => {
  assert.equal(
    (
      await request([], await token(), {
        ...env,
        EXTENSIONS_PREVIEW_CLIENT_ID: undefined
      })
    ).status,
    503
  );
  assert.equal(
    (
      await request([], await token(), {
        ...env,
        EXTENSIONS_PREVIEW_CLIENT_ID: "missing"
      })
    ).status,
    404
  );
});
