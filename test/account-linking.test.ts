import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { betterAuth } from "better-auth/minimal";
import { memoryAdapter } from "better-auth/adapters/memory";
import { handleOAuthUserInfo, linkOAuthAccount } from "better-auth/oauth2";
import type { BetterAuthOptions } from "better-auth";

// The runner cannot import auth.ts's extensionless Worker imports. Extract
// its literal account policy, then exercise the installed OAuth implementation
// with real in-memory persistence rather than duplicating its linking logic.
const source = readFileSync(new URL("../src/auth.ts", import.meta.url), "utf8");
function extractAccountLiteral(text: string): string {
  const linking = text.indexOf("accountLinking:");
  assert.ok(linking !== -1, "production account linking policy exists");
  const key = text.lastIndexOf("account:", linking);
  assert.ok(key !== -1, "production account policy exists");
  const start = text.indexOf("{", key);
  assert.ok(start !== -1, "production account policy is a literal object");
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  throw new Error("production account policy is a literal object");
}
const account = runInNewContext(
  `(${extractAccountLiteral(source)})`
) as NonNullable<BetterAuthOptions["account"]>;
const accountLinking = account.accountLinking;
assert.ok(accountLinking, "production account linking policy is a literal object");

async function fixture() {
  const db: Record<string, Record<string, unknown>[]> = {
    user: [],
    account: [],
    session: [],
    verification: []
  };
  const auth = betterAuth({
    baseURL: "https://auth.example.test",
    secret: "test-only-secret-at-least-thirty-two-characters",
    database: memoryAdapter(db),
    account: { accountLinking },
    logger: { disabled: true }
  });
  const context = await auth.$context;
  const endpoint = {
    context,
    headers: new Headers(),
    request: new Request("https://auth.example.test/callback/github")
  } as Parameters<typeof handleOAuthUserInfo>[0];
  const user = await context.internalAdapter.createUser(
    {
      name: "Original owner",
      email: "admin@example.test",
      emailVerified: true
    },
    { method: "oauth", oauth: { providerId: "github" } }
  );
  await context.internalAdapter.createAccount({
    userId: user.id,
    providerId: "github",
    accountId: "100"
  });
  return { db, context, endpoint, user };
}

function identity(email = "admin@example.test", accountId = "200") {
  return {
    userInfo: {
      id: accountId,
      name: "GitHub profile",
      email,
      emailVerified: true
    },
    account: {
      providerId: "github",
      accountId,
      accessToken: "test-provider-token"
    },
    overrideUserInfo: true
  };
}

test("production policy requires authenticated linking and local verification", () => {
  assert.equal(accountLinking.disableImplicitLinking, true);
  assert.equal(accountLinking.requireLocalEmailVerified, true);
  assert.equal(accountLinking.updateUserInfoOnLink, true);
});

for (const email of ["admin@example.test", "ADMIN@EXAMPLE.TEST"]) {
  test(`unknown GitHub identity cannot claim verified local email ${email}`, async () => {
    const { db, endpoint } = await fixture();
    const before = structuredClone(db);
    const result = await handleOAuthUserInfo(endpoint, identity(email));
    assert.equal(result.error, "account not linked");
    assert.equal(result.data, null);
    assert.deepEqual(db, before, "no account, session or profile mutation");
  });
}

test("trusted provider status cannot restore implicit email linking", async () => {
  const { db, endpoint } = await fixture();
  const result = await handleOAuthUserInfo(endpoint, {
    ...identity(),
    isTrustedProvider: true
  });
  assert.equal(result.error, "account not linked");
  assert.equal(db.account.length, 1);
  assert.equal(db.session.length, 0);
});

test("existing GitHub identity can sign in and refresh its changed email", async () => {
  const { db, endpoint, user } = await fixture();
  const result = await handleOAuthUserInfo(
    endpoint,
    identity("new-address@example.test", "100")
  );
  assert.equal(result.error, null);
  assert.equal(result.data?.session.userId, user.id);
  assert.equal(result.data?.user.email, "new-address@example.test");
  assert.equal(db.account.length, 1);
});

test("a genuinely new GitHub identity can register", async () => {
  const { db, endpoint, user } = await fixture();
  const result = await handleOAuthUserInfo(
    endpoint,
    identity("new-user@example.test")
  );
  assert.equal(result.error, null);
  assert.equal(result.isRegister, true);
  assert.notEqual(result.data?.user.id, user.id);
  assert.equal(db.account.length, 2);
  assert.equal(db.session.length, 1);
});

test("authenticated explicit linking still binds to its owner and syncs profile", async () => {
  const { db, context, endpoint, user } = await fixture();
  const incoming = identity();
  const result = await linkOAuthAccount(endpoint, {
    link: { userId: user.id, email: user.email },
    userInfo: incoming.userInfo,
    account: incoming.account,
    profile: {}
  });
  assert.equal(result.linked, true);
  const linked = await context.internalAdapter.findAccountByKey(
    incoming.account
  );
  assert.equal(linked?.userId, user.id);
  assert.equal(
    (await context.internalAdapter.findUserById(user.id))?.name,
    "GitHub profile"
  );
  assert.equal(db.session.length, 0, "linking does not issue a new session");
});

test("explicit linking cannot steal a GitHub binding owned by another user", async () => {
  const { db, endpoint } = await fixture();
  const before = structuredClone(db);
  const incoming = identity("admin@example.test", "100");
  const result = await linkOAuthAccount(endpoint, {
    link: { userId: "another-user", email: "admin@example.test" },
    userInfo: incoming.userInfo,
    account: incoming.account,
    profile: {}
  });
  assert.equal(result.linked, false);
  assert.deepEqual(db, before);
});
