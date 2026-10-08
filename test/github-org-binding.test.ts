import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { mock, test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import * as schema from "../src/db/schema.ts";
import * as github from "../src/github.ts";
import * as claims from "../src/github-claims.ts";

// Load the production configuration and registered hooks with real SQLite
// persistence. Only the Worker adapter and plugin factories are substituted.
const compiled = ts.transpileModule(
  readFileSync(new URL("../src/auth.ts", import.meta.url), "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS } }
).outputText;
const oldTime = new Date(Date.now() - 60000).toISOString();

async function fixture(previousId: string | null = "100") {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`CREATE TABLE user (
    id text PRIMARY KEY, githubId text, githubLogin text,
    githubLoginVerifiedAt text, githubOrgs text, githubOrgsVerifiedAt text
  )`);
  sqlite
    .prepare("INSERT INTO user VALUES (?, ?, ?, ?, ?, ?)")
    .run("owner", previousId, "old-login", oldTime, '["old-org"]', oldTime);
  const db = drizzle(async (query, params, method) => {
    assert.equal(method, "run", "hook writes using a single SQL statement");
    sqlite.prepare(query).run(...params);
    return { rows: [] };
  });
  const modules: Record<string, unknown> = {
    "better-auth/minimal": { betterAuth: (options: unknown) => options },
    "better-auth/plugins": { jwt: () => ({}) },
    "better-auth/adapters/drizzle": { drizzleAdapter: () => ({}) },
    "@better-auth/oauth-provider": { oauthProvider: () => ({}) },
    "drizzle-orm": { eq, sql },
    "drizzle-orm/d1": { drizzle: () => db },
    "./db/schema": schema,
    "./github": github,
    "./github-claims": claims,
    "./oauth-userinfo-claims": {
      OAUTH_SCOPES: ["openid", "profile", "email"],
      OPAQUE_ACCESS_TOKEN_PREFIX: "fba_at_"
    },
    "./client-privileges": { canManageOAuthClients: () => false },
    "./auth-secret": { requireBetterAuthSecret: (value: unknown) => value },
    "./account-binding": {
      cleanupFailedAccountCreation: (adapter: unknown) => adapter
    }
  };
  const exports: Record<string, any> = {};
  runInNewContext(compiled, {
    exports,
    require: (name: string) => {
      assert.ok(name in modules, `expected production import ${name}`);
      return modules[name];
    },
    URL,
    Date
  });
  const auth = exports.createAuth({});
  const hooks = auth.databaseHooks.account;
  assert.equal(hooks.create.after, hooks.update.after);
  return {
    sqlite,
    hooks,
    getUserInfo: auth.socialProviders.github.getUserInfo as (token: {
      accessToken?: string;
    }) => Promise<unknown>,
    row: () => sqlite.prepare("SELECT * FROM user WHERE id = 'owner'").get()!
  };
}

async function fetchProfile(
  f: Awaited<ReturnType<typeof fixture>>,
  accountId: string,
  orgs: string[] | null
) {
  mock.method(globalThis, "fetch", async (url: string) => {
    if (url.endsWith("/user")) {
      return Response.json({
        id: Number(accountId),
        login: "new-login",
        email: "owner@example.test"
      });
    }
    if (url.endsWith("/emails")) {
      return Response.json([{ email: "owner@example.test", verified: true }]);
    }
    return orgs === null
      ? new Response(null, { status: 503 })
      : Response.json(orgs.map((login) => ({ organization: { login } })));
  });
  assert.ok(await f.getUserInfo({ accessToken: "test-token" }));
}

for (const previousId of ["100", null]) {
  for (const hook of ["create", "update"] as const) {
    test(`${hook}: failed lookup cannot carry org evidence from ${previousId} to 200`, async () => {
      const f = await fixture(previousId);
      try {
        await fetchProfile(f, "200", null);
        await f.hooks[hook].after({ accountId: "200", userId: "owner" });
        const row = f.row();
        assert.equal(row.githubId, "200");
        assert.equal(row.githubLogin, "new-login");
        assert.equal(row.githubOrgs, null);
        assert.equal(row.githubOrgsVerifiedAt, null);
        const issued = claims.githubClaims(row, 86400000, ["github"]);
        assert.equal(issued["https://fossbilling.org/claims/github_id"], "200");
        assert.equal(
          issued["https://fossbilling.org/claims/github_orgs"],
          undefined
        );
        assert.equal(
          issued["https://fossbilling.org/claims/github_orgs_expires_at"],
          undefined
        );
      } finally {
        mock.restoreAll();
        f.sqlite.close();
      }
    });
  }
}

test("same-account failure retains original snapshot and expiry while refreshing login", async () => {
  const f = await fixture();
  try {
    await fetchProfile(f, "100", null);
    await f.hooks.update.after({ accountId: "100", userId: "owner" });
    const row = f.row();
    assert.equal(row.githubLogin, "new-login");
    assert.equal(row.githubOrgs, '["old-org"]');
    assert.equal(row.githubOrgsVerifiedAt, oldTime);
    const issued = claims.githubClaims(row, 86400000, ["github"]);
    assert.deepEqual(issued["https://fossbilling.org/claims/github_orgs"], [
      "old-org"
    ]);
    assert.equal(
      issued["https://fossbilling.org/claims/github_orgs_expires_at"],
      new Date(Date.parse(oldTime) + 86400000).toISOString()
    );
  } finally {
    mock.restoreAll();
    f.sqlite.close();
  }
});

for (const orgs of [[], ["new-org"]]) {
  test(`successful replacement stores its own snapshot: ${JSON.stringify(orgs)}`, async () => {
    const f = await fixture();
    try {
      await fetchProfile(f, "200", orgs);
      await f.hooks.create.after({ accountId: "200", userId: "owner" });
      assert.equal(f.row().githubOrgs, JSON.stringify(orgs));
      assert.ok(
        Date.parse(f.row().githubOrgsVerifiedAt as string) > Date.parse(oldTime)
      );
      assert.deepEqual(
        claims.githubClaims(f.row(), 86400000, ["github"])[
          "https://fossbilling.org/claims/github_orgs"
        ],
        orgs
      );
      const before = f.row();
      await f.hooks.update.after({ accountId: "200", userId: "owner" });
      assert.deepEqual(
        f.row(),
        before,
        "missing pending evidence does not mutate user"
      );
      await fetchProfile(f, "100", null);
      await f.hooks.update.after({ accountId: "100", userId: "owner" });
      assert.equal(
        f.row().githubOrgs,
        null,
        "switching back cannot inherit the replacement snapshot"
      );
      assert.equal(f.row().githubOrgsVerifiedAt, null);
    } finally {
      mock.restoreAll();
      f.sqlite.close();
    }
  });
}

test("migration invalidates unbound evidence without changing identity or login", async () => {
  const f = await fixture();
  try {
    const before = f.row();
    const migration = readFileSync(
      new URL(
        "../migrations/0012_clear_unbound_github_orgs.sql",
        import.meta.url
      ),
      "utf8"
    );
    f.sqlite.exec(migration);
    f.sqlite.exec(migration);
    assert.deepEqual(
      { ...f.row() },
      {
        ...before,
        githubOrgs: null,
        githubOrgsVerifiedAt: null
      }
    );
    assert.equal(claims.hasFreshGithubOrgs(f.row(), 86400000), false);
  } finally {
    f.sqlite.close();
  }
});
