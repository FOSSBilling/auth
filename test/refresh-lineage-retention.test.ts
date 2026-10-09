import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  deleteExpiredRefreshLineageTombstones,
  REFRESH_LINEAGE_TOMBSTONE_RETENTION_MS
} from "../src/refresh-lineage-cleanup.ts";

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

    const db = {
      prepare(sql: string) {
        return {
          bind(bound: number) {
            return {
              async run() {
                const { changes } = sqlite.prepare(sql).run(bound);
                return { meta: { changes } };
              }
            };
          }
        };
      }
    } as unknown as Pick<D1Database, "prepare">;

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
