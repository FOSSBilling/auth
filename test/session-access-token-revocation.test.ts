import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

const migration = readFileSync(
  new URL(
    "../migrations/0016_revoke_session_access_tokens.sql",
    import.meta.url
  ),
  "utf8"
);

test("session deletion revokes access tokens before their session binding is cleared", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE session (id text PRIMARY KEY);
      CREATE TABLE oauthAccessToken (
        id text PRIMARY KEY,
        sessionId text REFERENCES session(id) ON DELETE SET NULL,
        userId text,
        revoked integer
      );
      CREATE TABLE oauthRefreshToken (
        id text PRIMARY KEY,
        sessionId text REFERENCES session(id) ON DELETE SET NULL,
        scopes text NOT NULL
      );
      INSERT INTO session VALUES ('one'), ('two');
      INSERT INTO oauthAccessToken VALUES
        ('one-bound', 'one', 'user', NULL),
        ('two-bound', 'two', 'user', NULL),
        ('offline-derived', NULL, 'user', NULL),
        ('client-credentials', NULL, NULL, NULL);
      INSERT INTO oauthRefreshToken VALUES ('offline-refresh', 'one', 'offline_access');
    `);

    db.exec(migration);
    for (const id of ["offline-derived", "client-credentials", "one-bound"]) {
      assert.equal(
        db.prepare("SELECT revoked FROM oauthAccessToken WHERE id = ?").get(id)
          ?.revoked,
        null,
        `${id} remains active at migration cutover`
      );
    }

    // No provider background revocation runs here. One delete must make both
    // bound tokens inactive while preserving rows for introspection.
    db.exec("DELETE FROM session WHERE id IN ('one', 'two')");
    for (const id of ["one-bound", "two-bound"]) {
      const token = db
        .prepare("SELECT sessionId, revoked FROM oauthAccessToken WHERE id = ?")
        .get(id);
      assert.equal(token?.sessionId, null);
      assert.equal(typeof token?.revoked, "number");
    }
    const refresh = db
      .prepare(
        "SELECT sessionId, scopes FROM oauthRefreshToken WHERE id = 'offline-refresh'"
      )
      .get();
    assert.equal(refresh?.sessionId, null);
    assert.equal(refresh?.scopes, "offline_access");

    // New sessionless tokens from a surviving offline refresh remain usable.
    db.exec(
      "INSERT INTO oauthAccessToken VALUES ('new-offline', NULL, 'user', NULL)"
    );
    assert.equal(
      db
        .prepare(
          "SELECT revoked FROM oauthAccessToken WHERE id = 'new-offline'"
        )
        .get()?.revoked,
      null
    );
  } finally {
    db.close();
  }
});
