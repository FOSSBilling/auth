import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { betterAuth } from "better-auth/minimal";
import { memoryAdapter } from "better-auth/adapters/memory";
import { jwt } from "better-auth/plugins";
import { oauthProvider } from "@better-auth/oauth-provider";

// Match the production option because this runner cannot resolve auth.ts's
// extensionless Worker imports. Exercise the installed HTTP endpoints below.
const source = readFileSync(new URL("../src/auth.ts", import.meta.url), "utf8");
const strategy = source.match(
  /account:\s*\{[\s\S]*?storeStateStrategy:\s*"(cookie|database)"/
)?.[1] as "cookie" | "database" | undefined;
const baseURL = "https://auth.example.test";

async function fixture(
  db: Record<string, Record<string, unknown>[]> = {
    user: [],
    account: [],
    session: [],
    verification: []
  }
) {
  let writes = 0;
  let exchanges = 0;
  const auth = betterAuth({
    baseURL,
    basePath: "/",
    secret: "test-only-secret-at-least-thirty-two-characters",
    database: memoryAdapter(db),
    account: { storeStateStrategy: strategy },
    // Remove the isolate-local limiter so it cannot mask state-write amplification.
    rateLimit: { enabled: false },
    socialProviders: {
      github: { clientId: "test-client", clientSecret: "test-secret" }
    },
    plugins: [
      jwt({ disableSettingJwtHeader: true }),
      oauthProvider({
        loginPage: "/sign-in",
        consentPage: "/consent",
        allowDynamicClientRegistration: false
      })
    ],
    logger: { disabled: true }
  });
  const context = await auth.$context;
  const createVerification = context.internalAdapter.createVerificationValue;
  context.internalAdapter.createVerificationValue = async (...args) => {
    writes++;
    return createVerification(...args);
  };
  const provider = await context.socialProviders.find(
    (provider) => provider.id === "github"
  );
  assert.ok(provider);
  provider.validateAuthorizationCode = async () => {
    exchanges++;
    return { accessToken: "test-token", scopes: ["read:user", "user:email"] };
  };
  provider.getUserInfo = async () => ({
    user: {
      name: "GitHub user",
      email: "user@example.test",
      emailVerified: true
    },
    data: { id: 100 }
  });
  return { auth, db, writes: () => writes, exchanges: () => exchanges };
}

async function start(
  auth: Awaited<ReturnType<typeof fixture>>["auth"],
  index = 0
) {
  const response = await auth.handler(
    new Request(baseURL + "/sign-in/social", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: baseURL,
        "x-forwarded-for": `192.0.2.${index + 1}`
      },
      body: JSON.stringify({
        provider: "github",
        callbackURL: baseURL + "/account",
        disableRedirect: true
      })
    })
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as { url: string };
  const state = new URL(body.url).searchParams.get("state");
  assert.ok(state);
  const cookie = response.headers
    .getSetCookie()
    .find((value) => /better-auth\.(oauth_state|state)=/.test(value));
  assert.ok(cookie, "start sets browser-bound state");
  return { state, cookie: cookie.split(";")[0], setCookie: cookie };
}

async function callback(
  auth: Awaited<ReturnType<typeof fixture>>["auth"],
  state: string,
  cookie?: string
) {
  return auth.handler(
    new Request(
      baseURL +
        "/callback/github?code=test-code&state=" +
        encodeURIComponent(state),
      {
        headers: cookie ? { cookie } : {}
      }
    )
  );
}

test("distributed abandoned starts create no persistent state", async () => {
  const first = await fixture();
  for (let index = 0; index < 12; index++) {
    const instance = await fixture(first.db);
    const flow = await start(instance.auth, index);
    assert.match(flow.setCookie, /HttpOnly/i);
    assert.match(flow.setCookie, /Secure/i);
    assert.match(flow.setCookie, /SameSite=Lax/i);
    assert.equal(
      instance.writes(),
      0,
      "no insertion even across fresh auth instances and IPs"
    );
    assert.match(flow.setCookie, /Max-Age=600/i);
  }
  assert.deepEqual(first.db, {
    user: [],
    account: [],
    session: [],
    verification: []
  });
});

test("valid callback works on another auth instance and expires the state cookie", async () => {
  const first = await fixture();
  const flow = await start(first.auth);
  const second = await fixture(first.db);
  const response = await callback(second.auth, flow.state, flow.cookie);
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), baseURL + "/account");
  assert.equal(second.exchanges(), 1);
  assert.equal(first.db.user.length, 1);
  assert.equal(first.db.account.length, 1);
  assert.equal(first.db.session.length, 1);
  assert.equal(first.db.verification.length, 0);
  assert.ok(
    response.headers
      .getSetCookie()
      .some((value) => /oauth_state=.*Max-Age=0/i.test(value))
  );
  assert.ok(
    response.headers
      .getSetCookie()
      .some((value) => /session_token=/.test(value))
  );
});

for (const variant of [
  "missing",
  "mismatched",
  "tampered",
  "other-browser",
  "expired"
] as const) {
  test(`invalid state is rejected before provider exchange: ${variant}`, async () => {
    const instance = await fixture();
    const flow = await start(instance.auth);
    let state = flow.state;
    let cookie: string | undefined = flow.cookie;
    if (variant === "missing") cookie = undefined;
    if (variant === "mismatched") state = "attacker-state";
    if (variant === "tampered") cookie = flow.cookie.slice(0, -8) + "aaaaaaaa";
    if (variant === "other-browser")
      cookie = (await start(instance.auth, 1)).cookie;
    const realNow = Date.now;
    if (variant === "expired") Date.now = () => realNow() + 601_000;
    let response: Response;
    try {
      response = await callback(instance.auth, state, cookie);
    } finally {
      Date.now = realNow;
    }
    assert.equal(response.status, 302);
    assert.match(
      response.headers.get("location") ?? "",
      /\/error\?error=state_/
    );
    assert.equal(instance.exchanges(), 0);
    assert.equal(instance.db.user.length, 0);
    assert.equal(instance.db.account.length, 0);
    assert.equal(instance.db.session.length, 0);
    assert.equal(instance.writes(), 0);
  });
}

test("authenticated account refresh preserves linking state", async () => {
  const instance = await fixture();
  const flow = await start(instance.auth);
  const signedIn = await callback(instance.auth, flow.state, flow.cookie);
  const sessionCookie = signedIn.headers
    .getSetCookie()
    .find((value) => /session_token=/.test(value));
  assert.ok(sessionCookie);
  const response = await instance.auth.handler(
    new Request(baseURL + "/link-social", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: baseURL,
        cookie: sessionCookie.split(";")[0]
      },
      body: JSON.stringify({
        provider: "github",
        callbackURL: baseURL + "/account"
      })
    })
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as { url: string };
  const state = new URL(body.url).searchParams.get("state");
  const cookie = response.headers
    .getSetCookie()
    .find((value) => /oauth_state=/.test(value));
  assert.ok(state);
  assert.ok(cookie);
  const linked = await callback(instance.auth, state, cookie.split(";")[0]);
  assert.equal(linked.headers.get("location"), baseURL + "/account");
  assert.equal(instance.db.user.length, 1);
  assert.equal(instance.db.account.length, 1);
  assert.equal(instance.db.session.length, 1);
  assert.equal(instance.writes(), 0);
});
