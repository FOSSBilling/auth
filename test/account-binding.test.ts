import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { handleOAuthUserInfo } from "better-auth/oauth2";
import { cleanupFailedAccountCreation } from "../src/account-binding.ts";

const migration = readFileSync(
  new URL("../migrations/0015_strong_forge.sql", import.meta.url),
  "utf8"
);

test("account migration rejects duplicate identities and leaves rows intact", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`CREATE TABLE account (
      id TEXT PRIMARY KEY, providerId TEXT NOT NULL, accountId TEXT NOT NULL
    );
    INSERT INTO account VALUES
      ('first', 'github', '100'), ('second', 'github', '100');`);
    assert.throws(() => db.exec(migration), /UNIQUE constraint failed/);
    assert.equal(db.prepare("SELECT count(*) AS n FROM account").get()?.n, 2);
    db.exec("DELETE FROM account WHERE id = 'second'");
    db.exec(migration);
    assert.throws(
      () => db.exec("INSERT INTO account VALUES ('again', 'github', '100')"),
      /UNIQUE constraint failed/
    );
    db.exec("INSERT INTO account VALUES ('other', 'another', '100')");
    assert.equal(db.prepare("SELECT count(*) AS n FROM account").get()?.n, 2);
  } finally {
    db.close();
  }
});

test("racing first sign-ins leave one owner and no orphan user", async () => {
  const rows: Record<string, Record<string, unknown>[]> = {
    user: [],
    account: [],
    session: [],
    verification: []
  };
  let arrivals = 0;
  const claimedBindings = new Set<string>();
  let release!: () => void;
  const bothLookedUp = new Promise<void>((resolve) => {
    release = resolve;
  });
  const auth = betterAuth({
    baseURL: "https://auth.example.test",
    secret: "test-only-secret-at-least-thirty-two-characters",
    database: (options: BetterAuthOptions) => {
      const adapter = memoryAdapter(rows)(options);
      const findMany = adapter.findMany.bind(adapter);
      adapter.findMany = async <T>(
        query: Parameters<typeof adapter.findMany>[0]
      ): Promise<T[]> => {
        const found = await findMany<T>(query);
        if (query.model === "account" && query.join?.user && arrivals < 2) {
          arrivals++;
          if (arrivals === 2) release();
          await bothLookedUp;
        }
        return found;
      };
      const create = adapter.create.bind(adapter);
      adapter.create = async (input) => {
        if (input.model !== "account") return create(input);
        const key = `${input.data.providerId}:${input.data.accountId}`;
        if (claimedBindings.has(key)) {
          throw new Error(
            "UNIQUE constraint failed: account.providerId, account.accountId"
          );
        }
        claimedBindings.add(key);
        try {
          return await create(input);
        } catch (error) {
          claimedBindings.delete(key);
          throw error;
        }
      };
      return cleanupFailedAccountCreation(adapter, async (userId) => {
        if (!rows.account.some((account) => account.userId === userId)) {
          rows.user = rows.user.filter((user) => user.id !== userId);
        }
      });
    },
    logger: { disabled: true }
  });
  const context = await auth.$context;
  const endpoint = {
    context,
    headers: new Headers(),
    request: new Request("https://auth.example.test/callback/github")
  } as Parameters<typeof handleOAuthUserInfo>[0];
  const identity = (email: string) => ({
    userInfo: { id: "100", name: "GitHub profile", email, emailVerified: true },
    account: { providerId: "github", accountId: "100" }
  });
  const results = await Promise.all([
    handleOAuthUserInfo(endpoint, identity("first@example.test")),
    handleOAuthUserInfo(endpoint, identity("second@example.test"))
  ]);
  assert.equal(results.filter((result) => result.error === null).length, 1);
  assert.equal(results.filter((result) => result.error !== null).length, 1);
  assert.equal(rows.user.length, 1);
  assert.equal(rows.account.length, 1);
  assert.equal(rows.session.length, 1);
  assert.equal(rows.account[0].userId, rows.user[0].id);

  const retry = await handleOAuthUserInfo(
    endpoint,
    identity("second@example.test")
  );
  assert.equal(retry.error, null);
  assert.equal(retry.data?.user.id, rows.user[0].id);
  assert.equal(rows.user.length, 1);
  assert.equal(rows.account.length, 1);
});
