import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { betterAuth } from "better-auth/minimal";
import { memoryAdapter } from "better-auth/adapters/memory";
import { jwt } from "better-auth/plugins";
import { makeSignature } from "better-auth/crypto";
import { oauthProvider } from "@better-auth/oauth-provider";
import { canManageOAuthClients } from "../src/client-privileges.ts";

const now = Date.now();
const changedProfile = {
  id: "provisioned-id",
  email: "new@example.test",
  emailVerified: false
};
const user = {
  id: "provisioned-id",
  email: "admin@example.test",
  emailVerified: true
};
const env = { ADMIN_USER_IDS: " other-id, provisioned-id " };
const session = {
  userId: user.id,
  createdAt: new Date(now),
  expiresAt: new Date(now + 86400000)
};

test("immutable role survives profile changes without transferring with email", () => {
  assert.equal(canManageOAuthClients(env, user, session, now), true);
  assert.equal(canManageOAuthClients(env, changedProfile, session, now), true);
  const newHolder = { ...user, id: "reassigned-address-holder" };
  assert.equal(
    canManageOAuthClients(
      env,
      newHolder,
      { ...session, userId: newHolder.id },
      now
    ),
    false
  );
  assert.equal(
    canManageOAuthClients(
      { ADMIN_USER_IDS: "PROVISIONED-ID" },
      user,
      session,
      now
    ),
    false
  );
  assert.equal(canManageOAuthClients({}, user, session, now), false);
  assert.equal(
    canManageOAuthClients({ ADMIN_USER_IDS: " , " }, user, session, now),
    false
  );
  assert.equal(
    canManageOAuthClients({ ADMIN_USER_IDS: "other-id" }, user, session, now),
    false
  );
});

test("privilege age is absolute and fails closed for invalid session state", () => {
  assert.equal(canManageOAuthClients(env, user, session, now + 899999), true);
  assert.equal(canManageOAuthClients(env, user, session, now + 900000), false);
  assert.equal(
    canManageOAuthClients(
      env,
      user,
      { ...session, expiresAt: new Date(now + 604800000) },
      now + 900000
    ),
    false
  );
  assert.equal(canManageOAuthClients(env, undefined, session, now), false);
  assert.equal(canManageOAuthClients(env, user, undefined, now), false);
  assert.equal(
    canManageOAuthClients(env, user, { ...session, userId: "other-id" }, now),
    false
  );
  for (const createdAt of [new Date(NaN), new Date(now + 1)]) {
    assert.equal(
      canManageOAuthClients(env, user, { ...session, createdAt }, now),
      false
    );
  }
  for (const expiresAt of [new Date(NaN), new Date(now)]) {
    assert.equal(
      canManageOAuthClients(env, user, { ...session, expiresAt }, now),
      false
    );
  }
});

// Keep the endpoint fixture tied to the production hook, despite Node's inability
// to resolve the Worker's extensionless imports in auth.ts.
const source = readFileSync(new URL("../src/auth.ts", import.meta.url), "utf8");
assert.match(
  source,
  /clientPrivileges: \(\{ user, session \}\) =>\s*canManageOAuthClients\(env, user, session\)/
);

async function fixture() {
  const secret = "test-only-secret-at-least-thirty-two-characters";
  const db: Record<string, Record<string, unknown>[]> = {
    user: [],
    account: [],
    session: [],
    verification: [],
    jwks: [],
    oauthClient: [],
    oauthConsent: [],
    oauthAccessToken: [],
    oauthRefreshToken: []
  };
  const policy = { ADMIN_USER_IDS: "" };
  const auth = betterAuth({
    baseURL: "https://auth.example.test",
    secret,
    database: memoryAdapter(db),
    logger: { disabled: true },
    plugins: [
      jwt(),
      oauthProvider({
        loginPage: "/sign-in",
        consentPage: "/consent",
        allowDynamicClientRegistration: false,
        allowUnauthenticatedClientRegistration: false,
        clientPrivileges: ({ user, session }) =>
          canManageOAuthClients(policy, user, session)
      })
    ]
  });
  const context = await auth.$context;
  const owner = await context.internalAdapter.createUser(
    {
      name: "Owner",
      email: user.email,
      emailVerified: true
    },
    { method: "oauth", oauth: { providerId: "github" } }
  );
  const signedIn = await context.internalAdapter.createSession(owner.id);
  assert.ok(signedIn);
  const cookie =
    context.authCookies.sessionToken.name +
    "=" +
    encodeURIComponent(
      signedIn.token + "." + (await makeSignature(signedIn.token, secret))
    );
  const headers = new Headers({ cookie });
  return { auth, db, policy, owner, signedIn, headers };
}

test("real managed-client endpoints deny stale/email-only users and honor role removal", async () => {
  const { auth, db, policy, owner, signedIn, headers } = await fixture();
  const create = () =>
    auth.api.createOAuthClient({
      headers,
      body: {
        client_name: "First party",
        redirect_uris: ["https://client.example.test/callback"]
      }
    });
  await assert.rejects(create, { status: "UNAUTHORIZED" });
  assert.equal(db.oauthClient.length, 0);
  policy.ADMIN_USER_IDS = owner.id;
  const client = await create();
  assert.ok(client.client_id);
  assert.equal(db.oauthClient.length, 1);
  assert.ok(
    await auth.api.getSession({ headers }),
    "ordinary session remains usable"
  );
  // Model sliding renewal: extend expiry/update time, keep original sign-in.
  const row = db.session.find((r) => r.id === signedIn.id)!;
  row.createdAt = new Date(Date.now() - 900001);
  row.updatedAt = new Date();
  row.expiresAt = new Date(Date.now() + 604800000);
  await assert.rejects(create, { status: "UNAUTHORIZED" });
  assert.ok(
    await auth.api.getSession({ headers }),
    "stale privilege does not disable ordinary account use"
  );
  row.createdAt = new Date();
  policy.ADMIN_USER_IDS = "";
  await assert.rejects(create, { status: "UNAUTHORIZED" });
  await assert.rejects(
    () =>
      auth.api.getOAuthClient({
        headers,
        query: { client_id: client.client_id }
      }),
    { status: "UNAUTHORIZED" }
  );
  await assert.rejects(() => auth.api.getOAuthClients({ headers }), {
    status: "UNAUTHORIZED"
  });
  await assert.rejects(
    () =>
      auth.api.updateOAuthClient({
        headers,
        body: {
          client_id: client.client_id,
          update: { client_name: "Changed" }
        }
      }),
    { status: "UNAUTHORIZED" }
  );
  await assert.rejects(
    () =>
      auth.api.rotateClientSecret({
        headers,
        body: { client_id: client.client_id }
      }),
    { status: "UNAUTHORIZED" }
  );
  await assert.rejects(
    () =>
      auth.api.deleteOAuthClient({
        headers,
        body: { client_id: client.client_id }
      }),
    { status: "UNAUTHORIZED" }
  );
  assert.equal(
    db.oauthClient.length,
    1,
    "denied requests do not persist clients"
  );
});
