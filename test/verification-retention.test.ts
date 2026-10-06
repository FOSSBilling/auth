import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { betterAuth } from "better-auth/minimal";
import { memoryAdapter } from "better-auth/adapters/memory";
import type { Env } from "../src/types.ts";

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      context.parentURL?.endsWith("/src/index.ts") &&
      specifier === "./auth"
    ) {
      return {
        url: `data:text/javascript,${encodeURIComponent(`
          export function createAuth() { return { handler: async () => new Response("auth") }; }
          export function isTrustedCallbackUrl() { return false; }
        `)}`,
        shortCircuit: true
      };
    }
    if (context.parentURL?.includes("/src/") && specifier.startsWith("./")) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  }
});
const { default: worker } = await import("../src/index.ts");
hooks.deregister();

const migration = readFileSync(
  new URL("../migrations/0011_verification_expiry_index.sql", import.meta.url),
  "utf8"
);
const now = 1800000000000;
const controller = {
  scheduledTime: now,
  cron: "* * * * *"
} as ScheduledController;

function fixture() {
  const sql = new DatabaseSync(":memory:");
  sql.exec(`CREATE TABLE verification (
    id TEXT PRIMARY KEY, identifier TEXT NOT NULL, value TEXT NOT NULL,
    expiresAt INTEGER NOT NULL, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL
  )`);
  sql.exec(migration);
  // Run the production D1 statement against SQLite, using the same millisecond
  // timestamps as the application's Drizzle schema. No cleanup SQL is mocked.
  const env = Object.assign({} as Env, {
    BETTER_AUTH_SECRET: "test-only-secret",
    GITHUB_CLIENT_ID: "test-client",
    GITHUB_CLIENT_SECRET: "test-secret",
    AUTH_DB: {
      prepare(query: string) {
        return {
          bind(cutoff: number) {
            return {
              async run() {
                return sql.prepare(query).run(cutoff);
              }
            };
          }
        };
      }
    }
  });
  const insert = (
    id: string,
    expiresAt: number,
    value = '{"type":"authorization_code"}'
  ) =>
    sql
      .prepare("INSERT INTO verification VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, id, value, expiresAt, now - 600000, now - 600000);
  return { sql, env, insert };
}

test("cron reclaims abandoned codes without traffic, preserving all live state", async () => {
  const { sql, env, insert } = fixture();
  try {
    for (let i = 0; i < 2000; i++) insert(`abandoned-${i}`, now - 1);
    insert("expired-other", now - 1, "non-JSON transient state");
    insert("boundary", now);
    insert("live", now + 600000);
    insert("live-other", now + 300000, "other transient state");
    assert.equal(
      sql.prepare("SELECT count(*) AS n FROM verification").get()?.n,
      2004
    );
    await worker.scheduled(controller, env);
    assert.deepEqual(
      sql
        .prepare("SELECT id FROM verification ORDER BY id")
        .all()
        .map((r) => r.id),
      ["boundary", "live", "live-other"]
    );
    await worker.scheduled(controller, env); // Repeated/concurrent schedules are safe.
    assert.equal(
      sql.prepare("SELECT count(*) AS n FROM verification").get()?.n,
      3
    );
    for (let i = 0; i < 100; i++) insert(`next-${i}`, now + 600000);
    await worker.scheduled({ ...controller, scheduledTime: now + 600001 }, env);
    assert.equal(
      sql.prepare("SELECT count(*) AS n FROM verification").get()?.n,
      0
    );
    const plan = sql
      .prepare(
        "EXPLAIN QUERY PLAN DELETE FROM verification WHERE expiresAt < ?"
      )
      .all(now);
    assert.match(JSON.stringify(plan), /verification_expiresAt_idx/);
  } finally {
    sql.close();
  }
});

test("retained live codes remain consumable exactly once; cleaned codes cannot be consumed", async () => {
  const { sql, env, insert } = fixture();
  const rows: Record<string, Record<string, unknown>[]> = {
    user: [],
    session: [],
    account: [],
    verification: []
  };
  const auth = betterAuth({
    baseURL: "https://auth.example.test",
    secret: "test-only-secret-at-least-thirty-two-characters",
    database: memoryAdapter(rows),
    logger: { disabled: true }
  });
  const { internalAdapter } = await auth.$context;
  try {
    const cutoff = Date.now();
    insert("expired", cutoff - 1);
    insert("live", cutoff + 600000);
    await worker.scheduled({ ...controller, scheduledTime: cutoff }, env);
    rows.verification = sql
      .prepare("SELECT * FROM verification")
      .all()
      .map((r) => ({
        ...r,
        expiresAt: new Date(r.expiresAt as number),
        createdAt: new Date(r.createdAt as number),
        updatedAt: new Date(r.updatedAt as number)
      }));
    assert.equal(
      await internalAdapter.consumeVerificationValue("expired"),
      null
    );
    assert.equal(
      (await internalAdapter.consumeVerificationValue("live"))?.identifier,
      "live"
    );
    assert.equal(await internalAdapter.consumeVerificationValue("live"), null);
  } finally {
    sql.close();
  }
});

test("cleanup failures reject the scheduled event and HTTP routing remains available", async () => {
  const env = Object.assign({} as Env, {
    BETTER_AUTH_SECRET: "test-only-secret",
    GITHUB_CLIENT_ID: "test-client",
    GITHUB_CLIENT_SECRET: "test-secret",
    AUTH_DB: {
      prepare() {
        throw new Error("D1 unavailable");
      }
    }
  });
  await assert.rejects(worker.scheduled(controller, env), /D1 unavailable/);
  const response = await worker.fetch(
    new Request("https://auth.example.test/oauth2/authorize"),
    env,
    { waitUntil() {}, passThroughOnException() {}, props: {} }
  );
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "auth");
  const config = JSON.parse(
    readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8")
  );
  assert.deepEqual(config.triggers.crons, ["* * * * *"]);
});
