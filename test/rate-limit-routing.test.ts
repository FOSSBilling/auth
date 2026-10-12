import assert from "node:assert/strict";
import { test } from "node:test";
import type { Env } from "../src/types.ts";
import { registerRouterTestHooks } from "./_hooks.ts";

let handled = 0;
const globals = globalThis as typeof globalThis & {
  rateLimitRoutingAuth: {
    handler: () => Promise<Response>;
    clearGithubProfileStaging: () => void;
  };
};
globals.rateLimitRoutingAuth = {
  handler: async () => {
    handled++;
    return new Response("handled");
  },
  clearGithubProfileStaging: () => {}
};

const hooks = registerRouterTestHooks(
  `export function getAuth() { return globalThis.rateLimitRoutingAuth; }
   export function isTrustedCallbackUrl() { return false; }`
);
const { default: app } = await import("../src/index.ts");
hooks.deregister();
const env = {} as Env;
const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} };

test("unknown auth paths cannot create a new rate-limit bucket", async () => {
  for (const path of [
    "/oauth2/unknown-1",
    "/oauth2/unknown-2",
    "/.well-known/unknown",
    "/callback/unknown"
  ]) {
    const response = await app.fetch(
      new Request(`https://auth.example.test${path}`),
      env,
      ctx
    );
    assert.equal(response.status, 404, path);
  }
  assert.equal(handled, 0);
});

test("supported auth paths still reach Better Auth", async () => {
  for (const path of [
    "/sign-in/social",
    "/callback/github",
    "/oauth2/authorize",
    "/oauth2/token",
    "/.well-known/openid-configuration",
    "/.well-known/jwks.json"
  ]) {
    const response = await app.fetch(
      new Request(`https://auth.example.test${path}`),
      env,
      ctx
    );
    assert.equal(response.status, 200, path);
  }
  assert.equal(handled, 6);
});

test("scheduled retention deletes only expired limiter rows", async () => {
  const queries: { sql: string; value: number }[] = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(value: number) {
          return {
            run: async () => {
              queries.push({ sql, value });
              return { meta: { changes: 0 }, success: true };
            }
          };
        }
      };
    }
  };
  const before = Date.now();
  await app.scheduled({} as ScheduledEvent, { AUTH_DB: db } as unknown as Env);
  const limiter = queries.find(
    (entry) => entry.sql === "DELETE FROM rateLimit WHERE lastRequest < ?"
  );
  assert.ok(limiter, "expected a rateLimit retention delete");
  assert.ok(limiter.value >= before - 10 * 60 * 1000);
  assert.ok(limiter.value <= Date.now() - 10 * 60 * 1000);
});
