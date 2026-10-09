import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

const migration = readFileSync(
  new URL("../migrations/0017_curved_grim_reaper.sql", import.meta.url),
  "utf8"
);

function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`
    CREATE TABLE oauthRefreshToken (
      id TEXT PRIMARY KEY,
      token TEXT NOT NULL,
      clientId TEXT NOT NULL,
      userId TEXT NOT NULL,
      authorizationCodeId TEXT
    );
    CREATE TABLE oauthAccessToken (
      id TEXT PRIMARY KEY,
      refreshId TEXT REFERENCES oauthRefreshToken(id) ON DELETE CASCADE
    );
  `);
  db.exec(migration);
  return db;
}

function insertRefresh(
  db: DatabaseSync,
  id: string,
  authorizationCodeId: string | null,
  clientId = "client-a",
  userId = "user-a"
) {
  db.prepare(
    "INSERT INTO oauthRefreshToken (id, token, clientId, userId, authorizationCodeId) VALUES (?, ?, ?, ?, ?)"
  ).run(id, id, clientId, userId, authorizationCodeId);
}

function refreshIds(db: DatabaseSync) {
  return db
    .prepare("SELECT id FROM oauthRefreshToken ORDER BY id")
    .all()
    .map((row) => row.id);
}

test("family delete fences a descendant inserted after the delete", () => {
  const db = fixture();
  try {
    insertRefresh(db, "r0", "code-a");
    insertRefresh(db, "r1", "code-a");
    db.prepare(
      "DELETE FROM oauthRefreshToken WHERE clientId = ? AND userId = ?"
    ).run("client-a", "user-a");
    assert.deepEqual(refreshIds(db), []);
    assert.throws(
      () => insertRefresh(db, "r2", "code-a"),
      /lineage invalidated/
    );
    assert.deepEqual(refreshIds(db), []);

    // A new authorization starts a new lineage for the same client and user.
    insertRefresh(db, "fresh", "code-b");
    insertRefresh(db, "other-client", "code-a", "client-b");
    insertRefresh(db, "other-user", "code-a", "client-a", "user-b");
    assert.deepEqual(refreshIds(db), ["fresh", "other-client", "other-user"]);
  } finally {
    db.close();
  }
});

test("a descendant inserted before family delete is removed with its access token", () => {
  const db = fixture();
  try {
    insertRefresh(db, "r0", "code-a");
    insertRefresh(db, "r1", "code-a");
    insertRefresh(db, "r2", "code-a");
    db.prepare(
      "INSERT INTO oauthAccessToken (id, refreshId) VALUES (?, ?)"
    ).run("access-r2", "r2");
    db.prepare(
      "DELETE FROM oauthRefreshToken WHERE clientId = ? AND userId = ?"
    ).run("client-a", "user-a");
    assert.deepEqual(refreshIds(db), []);
    assert.equal(
      db.prepare("SELECT count(*) AS n FROM oauthAccessToken").get()?.n,
      0
    );
    assert.throws(
      () => insertRefresh(db, "r3", "code-a"),
      /lineage invalidated/
    );
  } finally {
    db.close();
  }
});

test("legacy NULL code lineages are fenced without blocking new code IDs", () => {
  const db = fixture();
  try {
    insertRefresh(db, "legacy", null);
    db.prepare("DELETE FROM oauthRefreshToken WHERE id = ?").run("legacy");
    assert.throws(
      () => insertRefresh(db, "late-legacy", null),
      /lineage invalidated/
    );
    insertRefresh(db, "fresh", "code-new");
    assert.deepEqual(refreshIds(db), ["fresh"]);
  } finally {
    db.close();
  }
});
