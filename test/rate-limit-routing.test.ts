import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import type { Env } from "../src/types.ts";

let handled = 0;
const globals = globalThis as typeof globalThis & {
  rateLimitRoutingAuth: { handler: () => Promise<Response> };
};
globals.rateLimitRoutingAuth = {
  handler: async () => {
    handled++;
    return new Response("handled");
  }
};

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      context.parentURL?.endsWith("/src/index.ts") &&
      specifier === "./auth"
    ) {
      const source = `export function createAuth() { return globalThis.rateLimitRoutingAuth; }
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
  let query = "";
  let cutoff = 0;
  const db = {
    prepare(sql: string) {
      query = sql;
      return {
        bind(value: number) {
          cutoff = value;
          return { run: async () => ({ success: true }) };
        }
      };
    }
  };
  const before = Date.now();
  await app.scheduled({} as ScheduledEvent, { AUTH_DB: db } as unknown as Env);
  assert.equal(query, "DELETE FROM rateLimit WHERE lastRequest < ?");
  assert.ok(cutoff >= before - 10 * 60 * 1000);
  assert.ok(cutoff <= Date.now() - 10 * 60 * 1000);
});
