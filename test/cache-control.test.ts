import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import type { Env } from "../src/types.ts";

let signedIn = true;
const session = {
  session: { id: "session", userId: "user", expiresAt: new Date() },
  user: { id: "user", name: "Test User", email: "test@example.com" }
};
const globals = globalThis as typeof globalThis & {
  cacheHeaderTestAuth: {
    api: { getSession: () => Promise<typeof session | null> };
    handler: () => Promise<Response>;
  };
};
globals.cacheHeaderTestAuth = {
  api: { getSession: async () => (signedIn ? session : null) },
  handler: async () =>
    Response.json(
      { issuer: "https://auth.example.com" },
      { headers: { "cache-control": "public, max-age=300" } }
    )
};

// Exercise the actual router without D1 or GitHub; only auth is substituted.
// Resolve the Worker's extensionless imports for Node's TypeScript runner.
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      context.parentURL?.endsWith("/src/index.ts") &&
      specifier === "./auth"
    ) {
      const source = `export function createAuth() { return globalThis.cacheHeaderTestAuth; }
        export function isTrustedCallbackUrl() { return false; }`;
      return {
        url: `data:text/javascript,${encodeURIComponent(source)}`,
        shortCircuit: true
      };
    }
    if (context.parentURL?.includes("/src/") && specifier.startsWith("./")) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  }
});
const { default: app } = await import("../src/index.ts");
hooks.deregister();
const env = {} as Env;
const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} };

test("account and OAuth HTML forbid storage, including aliases and HEAD", async () => {
  for (const path of [
    "/account",
    "/account/?callbackURL=https%3A%2F%2Fevil.example",
    "/consent?client_id=client&scope=openid",
    "/sign-in?client_id=client&sig=state",
    "/error?error=access_denied&error_description=private"
  ]) {
    for (const method of ["GET", "HEAD"]) {
      const response = await app.fetch(
        new Request(`https://auth.example.com${path}`, { method }),
        env,
        ctx
      );
      assert.equal(response.status, 200, path);
      assert.equal(
        response.headers.get("cache-control"),
        "no-store, max-age=0",
        path
      );
      assert.equal(response.headers.get("pragma"), "no-cache", path);
      assert.equal(response.headers.get("expires"), "0", path);
    }
  }
});

test("account content and the logged-out redirect remain intact", async () => {
  const response = await app.fetch(
    new Request("https://auth.example.com/account"),
    env,
    ctx
  );
  assert.match(await response.text(), /test@example\.com/);
  signedIn = false;
  try {
    const loggedOut = await app.fetch(
      new Request("https://auth.example.com/account"),
      env,
      ctx
    );
    assert.equal(loggedOut.status, 302);
    assert.equal(loggedOut.headers.get("location"), "/sign-in");
    assert.doesNotMatch(await loggedOut.text(), /test@example\.com/);
  } finally {
    signedIn = true;
  }
});

test("public JSON responses keep their existing cache policy", async () => {
  const response = await app.fetch(
    new Request("https://auth.example.com/.well-known/openid-configuration"),
    env,
    ctx
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "public, max-age=300");
  assert.equal(response.headers.get("pragma"), null);
  assert.equal(response.headers.get("expires"), null);
  assert.deepEqual(await response.json(), {
    issuer: "https://auth.example.com"
  });
});
