import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { createGithubProfileStaging } from "../src/github.ts";
import { githubClaims } from "../src/github-claims.ts";

test("successful profile refresh renews renamed login even when org fetch fails", async () => {
  const { getGithubUserInfo, consumeGithubProfile } =
    createGithubProfileStaging();
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
  const { getGithubUserInfo, consumeGithubProfile } =
    createGithubProfileStaging();
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

test("rejected link staging is isolated from later auth requests", async () => {
  let githubId = 122;
  mock.method(globalThis, "fetch", async (url: string) => {
    if (url.endsWith("/user")) {
      return Response.json({
        id: ++githubId,
        login: "different-user",
        email: "different@example.test"
      });
    }
    if (url.endsWith("/emails")) {
      return Response.json([
        { email: "different@example.test", verified: true }
      ]);
    }
    return Response.json([]);
  });
  try {
    for (let id = 0; id < 3; id++) {
      const failedLinkRequest = createGithubProfileStaging();
      const result = await failedLinkRequest.getGithubUserInfo({
        accessToken: "test-token"
      });
      assert.equal(result?.user.email, "different@example.test");
      const accountId = String(result?.data.id);

      // A rejected link never runs account hooks. Handler completion clears
      // its evidence, and a later request cannot see the same GitHub id.
      const nextRequest = createGithubProfileStaging();
      assert.equal(nextRequest.consumeGithubProfile(accountId), undefined);
      failedLinkRequest.clearGithubProfileStaging();
      assert.equal(
        failedLinkRequest.consumeGithubProfile(accountId),
        undefined
      );
    }
  } finally {
    mock.restoreAll();
  }
});

test("membership pagination stops at the page limit without saving a partial list", async () => {
  const { getGithubUserInfo, consumeGithubProfile } =
    createGithubProfileStaging();
  let orgRequests = 0;
  mock.method(globalThis, "fetch", async (url: string) => {
    if (url.includes("/memberships/orgs")) {
      orgRequests++;
      return Response.json(
        Array.from({ length: 100 }, (_, i) => ({
          organization: { login: `org-${i}` }
        }))
      );
    }
    if (url.endsWith("/emails")) return Response.json([]);
    return Response.json({
      id: 456,
      login: "member",
      email: "user@example.test"
    });
  });
  try {
    assert.ok(await getGithubUserInfo({ accessToken: "test-token" }));
    assert.equal(orgRequests, 4);
    assert.equal(consumeGithubProfile("456")?.orgs, null);
  } finally {
    mock.restoreAll();
  }
});

test("complete membership pages retain lowercase organization evidence", async () => {
  const { getGithubUserInfo, consumeGithubProfile } =
    createGithubProfileStaging();
  let orgRequests = 0;
  mock.method(globalThis, "fetch", async (url: string) => {
    if (url.includes("/memberships/orgs")) {
      orgRequests++;
      return Response.json(
        orgRequests === 1
          ? Array.from({ length: 100 }, (_, i) => ({
              organization: { login: `ORG-${i}` }
            }))
          : [{ organization: { login: "Final-Org" } }]
      );
    }
    if (url.endsWith("/emails")) return Response.json([]);
    return Response.json({
      id: 789,
      login: "member",
      email: "user@example.test"
    });
  });
  try {
    assert.ok(await getGithubUserInfo({ accessToken: "test-token" }));
    assert.equal(orgRequests, 2);
    const orgs = consumeGithubProfile("789")?.orgs;
    assert.equal(orgs?.length, 101);
    assert.equal(orgs?.[0], "org-0");
    assert.equal(orgs?.at(-1), "final-org");
  } finally {
    mock.restoreAll();
  }
});

test("oversized membership response leaves organization evidence unknown", async () => {
  const { getGithubUserInfo, consumeGithubProfile } =
    createGithubProfileStaging();
  mock.method(globalThis, "fetch", async (url: string) => {
    if (url.includes("/memberships/orgs")) {
      return new Response(" ".repeat(256 * 1024 + 1));
    }
    if (url.endsWith("/emails")) return Response.json([]);
    return Response.json({
      id: 999,
      login: "member",
      email: "user@example.test"
    });
  });
  try {
    assert.ok(await getGithubUserInfo({ accessToken: "test-token" }));
    assert.equal(consumeGithubProfile("999")?.orgs, null);
  } finally {
    mock.restoreAll();
  }
});
