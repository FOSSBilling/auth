import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_GITHUB_ORGS_MAX_AGE_SECONDS,
  GITHUB_SCOPE,
  githubClaims,
  getGithubOrgsMaxAgeMs,
  hasFreshGithubOrgs
} from "../src/github-claims.ts";

const LOGIN_CLAIM = "https://fossbilling.org/claims/github_login";
const ID_CLAIM = "https://fossbilling.org/claims/github_id";
const LOGIN_EXPIRY_CLAIM =
  "https://fossbilling.org/claims/github_login_expires_at";
const LOGIN_VERIFIED_AT = "2026-07-31T12:00:00.000Z";
const LOGIN_EXPIRY = "2026-08-01T12:00:00.000Z";
const ORGS_CLAIM = "https://fossbilling.org/claims/github_orgs";
const EXPIRY_CLAIM = "https://fossbilling.org/claims/github_orgs_expires_at";
const NOW = Date.parse("2026-08-01T00:00:00.000Z");
const NO_SCOPES = ["openid", "profile", "email"];
const GITHUB_SCOPES = [...NO_SCOPES, GITHUB_SCOPE];

test("omits organization claims when membership state is unknown", () => {
  assert.deepEqual(
    githubClaims(
      {
        githubLogin: "octocat",
        githubLoginVerifiedAt: LOGIN_VERIFIED_AT,
        githubOrgs: null,
        githubOrgsVerifiedAt: null
      },
      24 * 60 * 60 * 1000,
      GITHUB_SCOPES,
      NOW
    ),
    { [LOGIN_CLAIM]: "octocat", [LOGIN_EXPIRY_CLAIM]: LOGIN_EXPIRY }
  );
});

test("emits fresh non-empty organization claims with an absolute expiry", () => {
  const claims = githubClaims(
    {
      githubLogin: "octocat",
      githubLoginVerifiedAt: LOGIN_VERIFIED_AT,
      githubOrgs: JSON.stringify(["fossbilling"]),
      githubOrgsVerifiedAt: "2026-07-31T12:00:00.000Z"
    },
    24 * 60 * 60 * 1000,
    GITHUB_SCOPES,
    NOW
  );

  assert.deepEqual(claims, {
    [LOGIN_CLAIM]: "octocat",
    [LOGIN_EXPIRY_CLAIM]: LOGIN_EXPIRY,
    [ORGS_CLAIM]: ["fossbilling"],
    [EXPIRY_CLAIM]: "2026-08-01T12:00:00.000Z"
  });
});

test("preserves a fresh confirmed empty organization list", () => {
  const user = {
    githubLogin: "octocat",
    githubLoginVerifiedAt: LOGIN_VERIFIED_AT,
    githubOrgs: "[]",
    githubOrgsVerifiedAt: "2026-07-31T12:00:00.000Z"
  };
  assert.equal(hasFreshGithubOrgs(user, 24 * 60 * 60 * 1000, NOW), true);
  assert.deepEqual(
    githubClaims(user, 24 * 60 * 60 * 1000, GITHUB_SCOPES, NOW),
    {
      [LOGIN_CLAIM]: "octocat",
      [LOGIN_EXPIRY_CLAIM]: LOGIN_EXPIRY,
      [ORGS_CLAIM]: [],
      [EXPIRY_CLAIM]: "2026-08-01T12:00:00.000Z"
    }
  );
});

test("omits expired organization claims", () => {
  const user = {
    githubLogin: "octocat",
    githubLoginVerifiedAt: LOGIN_VERIFIED_AT,
    githubOrgs: JSON.stringify(["former-org"]),
    githubOrgsVerifiedAt: "2026-07-30T00:00:00.000Z"
  };
  assert.equal(hasFreshGithubOrgs(user, 24 * 60 * 60 * 1000, NOW), false);
  assert.deepEqual(
    githubClaims(user, 24 * 60 * 60 * 1000, GITHUB_SCOPES, NOW),
    {
      [LOGIN_CLAIM]: "octocat",
      [LOGIN_EXPIRY_CLAIM]: LOGIN_EXPIRY
    }
  );
});

test("fails closed for malformed stored organization data", () => {
  assert.deepEqual(
    githubClaims(
      {
        githubLogin: "octocat",
        githubLoginVerifiedAt: LOGIN_VERIFIED_AT,
        githubOrgs: '{"not":"an array"}',
        githubOrgsVerifiedAt: "2026-07-31T12:00:00.000Z"
      },
      24 * 60 * 60 * 1000,
      GITHUB_SCOPES,
      NOW
    ),
    { [LOGIN_CLAIM]: "octocat", [LOGIN_EXPIRY_CLAIM]: LOGIN_EXPIRY }
  );
});

test("omits private GitHub claims without the github scope", () => {
  assert.deepEqual(
    githubClaims(
      {
        githubLogin: "octocat",
        githubLoginVerifiedAt: LOGIN_VERIFIED_AT,
        githubOrgs: JSON.stringify(["fossbilling"]),
        githubOrgsVerifiedAt: "2026-07-31T12:00:00.000Z"
      },
      24 * 60 * 60 * 1000,
      NO_SCOPES,
      NOW
    ),
    {}
  );
});

test("uses a bounded default for missing or invalid configuration", () => {
  assert.equal(
    getGithubOrgsMaxAgeMs(undefined),
    DEFAULT_GITHUB_ORGS_MAX_AGE_SECONDS * 1000
  );
  assert.equal(
    getGithubOrgsMaxAgeMs("not-a-duration"),
    DEFAULT_GITHUB_ORGS_MAX_AGE_SECONDS * 1000
  );
  assert.equal(
    getGithubOrgsMaxAgeMs("0"),
    DEFAULT_GITHUB_ORGS_MAX_AGE_SECONDS * 1000
  );
});

for (const verifiedAt of [
  undefined,
  null,
  "bad-date",
  "2026-08-02T00:00:00Z",
  "2026-07-30T00:00:00Z",
  "2026-07-31T00:00:00Z"
]) {
  test(`stale or invalid login evidence is omitted: ${verifiedAt}`, () => {
    const claims = githubClaims(
      {
        githubId: "123",
        githubLogin: "former-owner",
        githubLoginVerifiedAt: verifiedAt
      },
      86400000,
      GITHUB_SCOPES,
      NOW
    );
    assert.deepEqual(claims, { [ID_CLAIM]: "123" });
  });
}

test("fresh orgs do not renew stale login, and immutable identity survives a rename", () => {
  const user = {
    githubId: "123",
    githubLogin: "former-owner",
    githubOrgs: '["fossbilling"]',
    githubOrgsVerifiedAt: LOGIN_VERIFIED_AT
  };
  const claims = githubClaims(user, 86400000, GITHUB_SCOPES, NOW);
  assert.deepEqual(claims, {
    [ID_CLAIM]: "123",
    [ORGS_CLAIM]: ["fossbilling"],
    [EXPIRY_CLAIM]: LOGIN_EXPIRY
  });
  assert.deepEqual(
    githubClaims(
      {
        ...user,
        githubLogin: "new-owner",
        githubLoginVerifiedAt: LOGIN_VERIFIED_AT
      },
      86400000,
      GITHUB_SCOPES,
      NOW
    ),
    {
      ...claims,
      [LOGIN_CLAIM]: "new-owner",
      [LOGIN_EXPIRY_CLAIM]: LOGIN_EXPIRY
    }
  );
  assert.deepEqual(
    githubClaims(
      { ...user, githubLoginVerifiedAt: LOGIN_VERIFIED_AT },
      86400000,
      NO_SCOPES,
      NOW
    ),
    {}
  );
});

for (const githubId of [null, 123, "", "0", "-1", "1e3", "123suffix"]) {
  test(`malformed provider ID is not reinterpreted: ${githubId}`, () => {
    assert.deepEqual(
      githubClaims({ githubId }, 86400000, GITHUB_SCOPES, NOW),
      {}
    );
  });
}
