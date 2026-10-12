import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { betterAuth } from "better-auth/minimal";
import { memoryAdapter } from "better-auth/adapters/memory";
import {
  decryptOAuthToken,
  handleOAuthUserInfo,
  linkOAuthAccount
} from "better-auth/oauth2";
import type { BetterAuthOptions } from "better-auth";
import { extractAccountLiteral } from "./_hooks.ts";

// Exercise the production literal policy with the installed OAuth implementation.
// Importing auth.ts directly needs the Worker's extensionless module resolver.
const source = readFileSync(new URL("../src/auth.ts", import.meta.url), "utf8");
const account = runInNewContext(
  `(${extractAccountLiteral(source)})`
) as BetterAuthOptions["account"];
assert.equal(
  (account as { encryptOAuthTokens?: boolean })?.encryptOAuthTokens,
  true,
  "production account policy encrypts OAuth tokens"
);
const migration = readFileSync(
  new URL(
    "../migrations/0010_clear_unencrypted_github_tokens.sql",
    import.meta.url
  ),
  "utf8"
);
const SECRET = "test-only-original-secret-at-least-32-characters";
const NEXT_SECRET = "test-only-replacement-secret-at-least-32-characters";

async function fixture(secret = SECRET) {
  const db: Record<string, Record<string, unknown>[]> = {
    user: [],
    account: [],
    session: [],
    verification: []
  };
  const options: BetterAuthOptions = {
    baseURL: "https://auth.example.test",
    secret,
    database: memoryAdapter(db),
    account,
    socialProviders: {
      github: { clientId: "test-client", clientSecret: "test-secret" }
    },
    logger: { disabled: true }
  };
  const auth = betterAuth(options);
  const context = await auth.$context;
  const endpoint = {
    context,
    headers: new Headers(),
    request: new Request("https://auth.example.test/callback/github")
  } as Parameters<typeof handleOAuthUserInfo>[0];
  return { db, auth, context, endpoint };
}

function identity(
  accessToken = "gho_test_access",
  refreshToken = "ghr_test_refresh"
) {
  return {
    userInfo: {
      id: "100",
      name: "GitHub owner",
      email: "owner@example.test",
      emailVerified: true
    },
    account: {
      providerId: "github",
      accountId: "100",
      accessToken,
      refreshToken,
      scope: "read:user,user:email,read:org"
    }
  };
}

async function assertEncrypted(
  row: Record<string, unknown>,
  context: Awaited<ReturnType<typeof fixture>>["context"],
  accessToken: string,
  refreshToken: string
) {
  assert.notEqual(row.accessToken, accessToken);
  assert.notEqual(row.refreshToken, refreshToken);
  assert.match(row.accessToken as string, /^[0-9a-f]+$/);
  assert.match(row.refreshToken as string, /^[0-9a-f]+$/);
  assert.equal(
    await decryptOAuthToken(row.accessToken as string, context),
    accessToken
  );
  assert.equal(
    await decryptOAuthToken(row.refreshToken as string, context),
    refreshToken
  );
  const wrongKey = await fixture(NEXT_SECRET);
  await assert.rejects(async () =>
    decryptOAuthToken(row.accessToken as string, wrongKey.context)
  );
}

test("sign-up and repeat sign-in persist ciphertext and preserve identity", async () => {
  const { db, context, endpoint } = await fixture();
  const first = await handleOAuthUserInfo(endpoint, identity());
  assert.equal(first.error, null);
  assert.ok(first.data);
  await assertEncrypted(
    db.account[0],
    context,
    "gho_test_access",
    "ghr_test_refresh"
  );
  const second = await handleOAuthUserInfo(
    endpoint,
    identity("gho_rotated", "ghr_rotated")
  );
  assert.equal(second.error, null);
  assert.equal(second.data?.user.id, first.data.user.id);
  assert.equal(db.account.length, 1);
  await assertEncrypted(db.account[0], context, "gho_rotated", "ghr_rotated");
});

test("explicit link and re-link encrypt both token columns", async () => {
  const { db, context, endpoint } = await fixture();
  const user = await context.internalAdapter.createUser(
    {
      name: "Owner",
      email: "owner@example.test",
      emailVerified: true
    },
    { method: "oauth", oauth: { providerId: "github" } }
  );
  for (const suffix of ["first", "next"]) {
    const incoming = identity("gho_" + suffix, "ghr_" + suffix);
    const result = await linkOAuthAccount(endpoint, {
      link: { userId: user.id, email: user.email },
      userInfo: incoming.userInfo,
      account: incoming.account,
      profile: {}
    });
    assert.equal(result.linked, true);
    assert.equal(db.account[0].userId, user.id);
    assert.equal(db.account.length, 1);
    await assertEncrypted(
      db.account[0],
      context,
      incoming.account.accessToken,
      incoming.account.refreshToken
    );
  }
});

test("refresh decrypts the provider credential and encrypts replacement tokens", async () => {
  const { db, auth, context, endpoint } = await fixture();
  const first = await handleOAuthUserInfo(endpoint, identity());
  assert.ok(first.data);
  const provider = context.socialProviders.find((p) => p.id === "github");
  assert.ok(provider);
  for (const replaceRefreshToken of [true, false]) {
    provider.refreshAccessToken = async (token) => {
      assert.equal(token, replaceRefreshToken ? "ghr_test_refresh" : "ghr_new");
      return {
        accessToken: "gho_new",
        ...(replaceRefreshToken ? { refreshToken: "ghr_new" } : {}),
        accessTokenExpiresAt: new Date(Date.now() + 3600000)
      };
    };
    const result: { accessToken: string | undefined } = await auth.api.refreshToken({
      body: {
        accountId: db.account[0].id as string,
        userId: first.data.user.id
      }
    });
    assert.equal(result.accessToken, "gho_new");
    await assertEncrypted(db.account[0], context, "gho_new", "ghr_new");
  }
});

test("migration clears dormant/plaintext/ciphertext credentials and preserves bindings", async () => {
  const sql = new DatabaseSync(":memory:");
  try {
    sql.exec(`CREATE TABLE account (
      id TEXT PRIMARY KEY, userId TEXT, providerId TEXT, accountId TEXT,
      accessToken TEXT, refreshToken TEXT, idToken TEXT,
      accessTokenExpiresAt INTEGER, refreshTokenExpiresAt INTEGER, scope TEXT
    );
    INSERT INTO account VALUES
      ('one','owner','github','100','gho_plain','ghr_plain','old-id',1,2,'read:org'),
      ('two','dormant','github','200','abcdef','123456',NULL,1,2,'read:org'),
      ('other','owner','other','300','other-access','other-refresh',NULL,1,2,'other');`);
    const other = sql.prepare("SELECT * FROM account WHERE id = 'other'").get();
    sql.exec(migration);
    sql.exec(migration); // Same procedure is safe to use again for secret rotation.
    const rows = sql
      .prepare("SELECT * FROM account WHERE providerId = 'github' ORDER BY id")
      .all();
    assert.equal(rows.length, 2);
    for (const row of rows) {
      for (const field of [
        "accessToken",
        "refreshToken",
        "idToken",
        "accessTokenExpiresAt",
        "refreshTokenExpiresAt"
      ]) {
        assert.equal(row[field], null);
      }
      assert.equal(row.scope, "read:org");
    }
    assert.equal(rows[0].userId, "owner");
    assert.equal(rows[0].accountId, "100");
    assert.equal(rows[1].userId, "dormant");
    assert.deepEqual(
      sql.prepare("SELECT * FROM account WHERE id = 'other'").get(),
      other
    );

    // After clearing ciphertext for rotation, fresh sign-in uses the same binding
    // with the replacement secret and cannot leave old refresh credentials behind.
    const { db, context, endpoint } = await fixture(NEXT_SECRET);
    const user = await context.internalAdapter.createUser(
      {
        id: "owner",
        name: "Owner",
        email: "owner@example.test",
        emailVerified: true
      },
      { method: "oauth", oauth: { providerId: "github" } }
    );
    await context.internalAdapter.createAccount({
      userId: user.id,
      providerId: "github",
      accountId: "100",
      accessToken: rows[0].accessToken as null,
      refreshToken: rows[0].refreshToken as null
    });
    const result = await handleOAuthUserInfo(endpoint, identity());
    assert.equal(result.error, null);
    assert.equal(result.data?.user.id, "owner");
    assert.equal(db.account.length, 1);
    const stored = db.account[0];
    assert.equal(
      await decryptOAuthToken(stored.accessToken as string, context),
      "gho_test_access"
    );
    assert.equal(
      await decryptOAuthToken(stored.refreshToken as string, context),
      "ghr_test_refresh"
    );
    const old = await fixture(SECRET);
    await assert.rejects(async () =>
      decryptOAuthToken(stored.accessToken as string, old.context)
    );
  } finally {
    sql.close();
  }
});
