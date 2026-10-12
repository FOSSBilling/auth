import assert from "node:assert/strict";
import { test } from "node:test";
import type { Env } from "../src/types.ts";
import { registerRouterTestHooks } from "./_hooks.ts";

let signedIn = true;
let cleanupCalls = 0;
const session = {
  session: { id: "session", userId: "user", expiresAt: new Date() },
  user: { id: "user", name: "Test User", email: "test@example.com" }
};
const globals = globalThis as typeof globalThis & {
  responseHeadersTestAuth: {
    api: { getSession: () => Promise<typeof session | null> };
    handler: (request: Request) => Promise<Response>;
    clearGithubProfileStaging: () => void;
  };
};
globals.responseHeadersTestAuth = {
  api: { getSession: async () => (signedIn ? session : null) },
  clearGithubProfileStaging: () => {
    cleanupCalls++;
  },
  handler: async (request: Request) =>
    request.url.includes("/callback/github")
      ? new Response("link rejected", { status: 403 })
      : Response.json(
          new URL(request.url).pathname.startsWith("/list-sessions")
            ? [{ token: "database-token", ipAddress: "192.0.2.1" }]
            : { issuer: "https://auth.example.com" },
          { headers: { "cache-control": "public, max-age=300" } }
        )
};

// Exercise the actual router without D1 or GitHub; only auth is substituted.
const hooks = registerRouterTestHooks(
  `export function getAuth() { return globalThis.responseHeadersTestAuth; }
   export function isTrustedCallbackUrl() { return false; }`
);
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

test("HTML responses carry the full security header set", async () => {
  const response = await app.fetch(
    new Request("https://auth.example.com/sign-in"),
    env,
    ctx
  );
  const csp = response.headers.get("content-security-policy") ?? "";
  assert.match(
    csp,
    /^default-src 'none'; script-src 'self' 'nonce-[A-Za-z0-9+/=]+'/
  );
  // The Cloudflare Web Analytics beacon needs both: script-src to load it,
  // connect-src to send its pings.
  assert.ok(
    csp.includes("https://static.cloudflareinsights.com"),
    "beacon script can load alongside the nonce"
  );
  assert.ok(
    csp.includes("connect-src 'self' https://cloudflareinsights.com"),
    "beacon pings can be sent"
  );
  assert.ok(!csp.includes("'unsafe-inline'"), "no inline-script fallback");
  assert.ok(csp.includes("style-src 'self'"));
  assert.ok(csp.includes("frame-ancestors 'none'"));
  assert.ok(csp.includes("base-uri 'none'"));
  assert.ok(csp.includes("form-action 'self'"));
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.equal(
    response.headers.get("permissions-policy"),
    "accelerometer=(), camera=(), geolocation=(), gyroscope=(), microphone=(), payment=(), usb=()"
  );
});

test("the CSP nonce is the same one carried by the page's inline scripts", async () => {
  // The OAuth-prompt query renders the sign-in page even with a session,
  // which would otherwise redirect to /account.
  const response = await app.fetch(
    new Request("https://auth.example.com/sign-in?client_id=client&sig=state"),
    env,
    ctx
  );
  const nonce = /'nonce-([^']+)'/.exec(
    response.headers.get("content-security-policy") ?? ""
  )?.[1];
  assert.ok(nonce, "CSP carries a per-request nonce");
  const html = await response.text();
  const scriptNonces = [...html.matchAll(/<script nonce="([^"]+)"/g)].map(
    (match) => match[1]
  );
  assert.ok(
    scriptNonces.length >= 2,
    "theme init and page scripts are both present"
  );
  assert.ok(
    scriptNonces.every((value) => value === nonce),
    "every inline script shares the CSP nonce"
  );
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

test("rejected GitHub callbacks clear request profile staging", async () => {
  const before = cleanupCalls;
  const response = await app.fetch(
    new Request("https://auth.example.com/callback/github"),
    env,
    ctx
  );
  assert.equal(response.status, 403);
  assert.equal(cleanupCalls, before + 1);
});

test("auth passthrough is not method-restricted", async () => {
  // PATCH/DELETE on /oauth2/* (client management) must reach better-auth's
  // own 405/JSON handling, not Hono's 404 text. A 404 text body for an API
  // navigation is what browsers surface as a download prompt.
  for (const method of ["PATCH", "DELETE", "PUT", "OPTIONS"]) {
    const response = await app.fetch(
      new Request("https://auth.example.com/oauth2/token", { method }),
      env,
      ctx
    );
    assert.notEqual(response.status, 404, method);
  }
});

test("navigation redirects carry no JSON body headers", async () => {
  // Regression: better-auth emits these as 302 + JSON content-type with
  // an empty body, which browsers download instead of following.
  const original = globals.responseHeadersTestAuth.handler;
  globals.responseHeadersTestAuth.handler = async () =>
    new Response(null, {
      status: 302,
      headers: {
        location: "/account",
        "content-type": "application/json",
        "content-length": "0"
      }
    });
  try {
    const response = await app.fetch(
      new Request("https://auth.example.com/callback/github?code=c&state=s"),
      env,
      ctx
    );
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "/account");
    assert.equal(response.headers.get("content-type"), null);
    assert.equal(response.headers.get("content-length"), null);
    assert.equal(await response.text(), "");
  } finally {
    globals.responseHeadersTestAuth.handler = original;
  }
});

test("non-empty redirects keep their body headers", async () => {
  // Only empty redirects are stripped: a redirect carrying a payload
  // must keep the headers that identify and delimit it.
  const original = globals.responseHeadersTestAuth.handler;
  globals.responseHeadersTestAuth.handler = async () =>
    Response.json({ url: "https://example.com/target" }, {
      status: 302,
      headers: { location: "https://example.com/target" }
    });
  try {
    const response = await app.fetch(
      new Request("https://auth.example.com/oauth2/authorize"),
      env,
      ctx
    );
    assert.equal(response.status, 302);
    assert.equal(
      response.headers.get("location"),
      "https://example.com/target"
    );
    assert.match(
      response.headers.get("content-type") ?? "",
      /application\/json/
    );
    assert.deepEqual(await response.json(), {
      url: "https://example.com/target"
    });
  } finally {
    globals.responseHeadersTestAuth.handler = original;
  }
});

test("session inventory JSON forbids storage across route forms and methods", async () => {
  for (const [path, method] of [
    ["/list-sessions", "GET"],
    ["/list-sessions/", "GET"],
    ["/list-sessions?source=account", "GET"],
    ["/list-sessions", "HEAD"]
  ]) {
    const response = await app.fetch(
      new Request(`https://auth.example.com${path}`, { method }),
      env,
      ctx
    );
    assert.equal(response.status, 200, path);
    assert.equal(
      response.headers.get("cache-control"),
      "no-store, private, max-age=0",
      path
    );
    assert.equal(response.headers.get("pragma"), "no-cache", path);
    assert.equal(response.headers.get("expires"), "0", path);
    if (method === "HEAD") {
      assert.equal(await response.text(), "");
    } else {
      assert.deepEqual(await response.json(), [
        { token: "database-token", ipAddress: "192.0.2.1" }
      ]);
    }
  }
});
