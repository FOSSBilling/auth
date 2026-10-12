import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  deleteExpiredClientAssertions,
  deleteExpiredRefreshLineageTombstones,
  REFRESH_LINEAGE_TOMBSTONE_RETENTION_MS
} from "../src/cleanup.ts";

function stubDb(sqlite: DatabaseSync) {
  return {
    prepare(statement: string) {
      return {
        bind(now: number) {
          return {
            async run() {
              const { changes } = sqlite.prepare(statement).run(now);
              return { meta: { changes } };
            }
          };
        }
      };
    }
  } as unknown as Pick<D1Database, "prepare">;
}

test("scheduled cleanup removes only expired assertion replay guards across batches", async () => {
  const sqlite = new DatabaseSync(":memory:");
  try {
    sqlite.exec(
      "CREATE TABLE oauthClientAssertion (id TEXT PRIMARY KEY, expiresAt INTEGER NOT NULL)"
    );
    const insert = sqlite.prepare(
      "INSERT INTO oauthClientAssertion (id, expiresAt) VALUES (?, ?)"
    );
    for (let i = 0; i < 750; i++) insert.run(`expired-${i}`, 999);
    insert.run("at-boundary", 1000);
    insert.run("live", 1001);

    const db = stubDb(sqlite);

    assert.equal(await deleteExpiredClientAssertions(db, 1000), 751);
    assert.deepEqual(
      sqlite
        .prepare("SELECT id FROM oauthClientAssertion")
        .all()
        .map((row) => row.id),
      ["live"]
    );
    assert.equal(await deleteExpiredClientAssertions(db, 1000), 0);
  } finally {
    sqlite.close();
  }
});

test("scheduled cleanup removes only tombstones older than the refresh-token window across batches", async () => {
  const sqlite = new DatabaseSync(":memory:");
  try {
    sqlite.exec(`CREATE TABLE oauthRefreshLineageTombstone (
      clientId TEXT NOT NULL, userId TEXT NOT NULL,
      authorizationCodeId TEXT NOT NULL, invalidatedAt INTEGER NOT NULL,
      PRIMARY KEY (clientId, userId, authorizationCodeId)
    )`);
    const now = 1_800_000_000_000;
    const cutoff = now - REFRESH_LINEAGE_TOMBSTONE_RETENTION_MS;
    const insert = sqlite.prepare(
      "INSERT INTO oauthRefreshLineageTombstone (clientId, userId, authorizationCodeId, invalidatedAt) VALUES (?, ?, ?, ?)"
    );
    for (let i = 0; i < 750; i++)
      insert.run("client-a", "user-a", `expired-${i}`, cutoff - 1);
    insert.run("client-a", "user-a", "at-boundary", cutoff);
    insert.run("client-a", "user-a", "live", cutoff + 1);

    const db = stubDb(sqlite);

    assert.equal(await deleteExpiredRefreshLineageTombstones(db, now), 751);
    assert.deepEqual(
      sqlite
        .prepare("SELECT authorizationCodeId FROM oauthRefreshLineageTombstone")
        .all()
        .map((row) => row.authorizationCodeId),
      ["live"]
    );
    assert.equal(await deleteExpiredRefreshLineageTombstones(db, now), 0);
  } finally {
    sqlite.close();
  }
});
