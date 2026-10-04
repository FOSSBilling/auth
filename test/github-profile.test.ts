import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { consumeGithubProfile, getGithubUserInfo } from "../src/github.ts";
import { githubClaims } from "../src/github-claims.ts";

test("successful profile refresh renews renamed login even when org fetch fails", async () => {
  mock.method(globalThis, "fetch", async (url: string) => {
    if (url.endsWith("/user")) {
      return Response.json({
        id: 123,
        login: "new-handle",
        email: "user@example.test"
      });
    }
    if (url.endsWith("/emails")) {
      return Response.json([{ email: "user@example.test", verified: true }]);
    }
    return new Response(null, { status: 503 });
  });
  try {
    const before = Date.now();
    const result = await getGithubUserInfo({ accessToken: "test-token" });
    assert.equal(result?.data.id, 123);
    const profile = consumeGithubProfile("123");
    assert.ok(profile);
    assert.equal(profile.login, "new-handle");
    assert.equal(profile.orgs, null);
    assert.ok(Date.parse(profile.loginVerifiedAt) >= before);
    const claims = githubClaims(
      {
        githubId: "123",
        githubLogin: profile.login,
        githubLoginVerifiedAt: profile.loginVerifiedAt
      },
      86400000,
      ["github"]
    );
    assert.equal(claims["https://fossbilling.org/claims/github_id"], "123");
    assert.equal(
      claims["https://fossbilling.org/claims/github_login"],
      "new-handle"
    );
    assert.equal(
      claims["https://fossbilling.org/claims/github_login_expires_at"],
      new Date(Date.parse(profile.loginVerifiedAt) + 86400000).toISOString()
    );
    assert.equal(consumeGithubProfile("123"), undefined);
  } finally {
    mock.restoreAll();
  }
});

test("failed GitHub profile fetch creates no fresh login evidence", async () => {
  mock.method(
    globalThis,
    "fetch",
    async () => new Response(null, { status: 503 })
  );
  try {
    assert.equal(await getGithubUserInfo({ accessToken: "test-token" }), null);
    assert.equal(consumeGithubProfile("123"), undefined);
  } finally {
    mock.restoreAll();
  }
});
