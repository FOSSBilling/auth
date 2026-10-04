import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

test("login evidence migration preserves legacy users without renewing handles", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(
      "CREATE TABLE user (id text PRIMARY KEY, githubLogin text, githubOrgs text, githubOrgsVerifiedAt text)"
    );
    db.exec(
      "INSERT INTO user VALUES ('local-id', 'former-owner', '[]', '2020-01-01T00:00:00Z')"
    );
    db.exec(
      readFileSync(
        new URL(
          "../migrations/0009_github_login_evidence.sql",
          import.meta.url
        ),
        "utf8"
      )
    );
    const user = db.prepare("SELECT * FROM user").get();
    assert.equal(user?.githubLogin, "former-owner");
    assert.equal(user?.githubId, null);
    assert.equal(user?.githubLoginVerifiedAt, null);
    assert.equal(user?.githubOrgsVerifiedAt, "2020-01-01T00:00:00Z");
  } finally {
    db.close();
  }
});
