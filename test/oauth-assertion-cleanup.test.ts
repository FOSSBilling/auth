import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { deleteExpiredClientAssertions } from "../src/oauth-assertion-cleanup.ts";

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

    const db = {
      prepare(sql: string) {
        return {
          bind(now: number) {
            return {
              async run() {
                const { changes } = sqlite.prepare(sql).run(now);
                return { meta: { changes } };
              }
            };
          }
        };
      }
    } as unknown as Pick<D1Database, "prepare">;

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
