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
const ORGS_CLAIM = "https://fossbilling.org/claims/github_orgs";
const EXPIRY_CLAIM =
  "https://fossbilling.org/claims/github_orgs_expires_at";
const NOW = Date.parse("2026-08-01T00:00:00.000Z");
const NO_SCOPES = ["openid", "profile", "email"];
const GITHUB_SCOPES = [...NO_SCOPES, GITHUB_SCOPE];

test("omits organization claims when membership state is unknown", () => {
  assert.deepEqual(
    githubClaims(
      { githubLogin: "octocat", githubOrgs: null, githubOrgsVerifiedAt: null },
      24 * 60 * 60 * 1000,
      GITHUB_SCOPES,
      NOW
    ),
    { [LOGIN_CLAIM]: "octocat" }
  );
});

test("emits fresh non-empty organization claims with an absolute expiry", () => {
  const claims = githubClaims(
    {
      githubLogin: "octocat",
      githubOrgs: JSON.stringify(["fossbilling"]),
      githubOrgsVerifiedAt: "2026-07-31T12:00:00.000Z"
    },
    24 * 60 * 60 * 1000,
    GITHUB_SCOPES,
    NOW
  );

  assert.deepEqual(claims, {
    [LOGIN_CLAIM]: "octocat",
    [ORGS_CLAIM]: ["fossbilling"],
    [EXPIRY_CLAIM]: "2026-08-01T12:00:00.000Z"
  });
});

test("preserves a fresh confirmed empty organization list", () => {
  const user = {
    githubLogin: "octocat",
    githubOrgs: "[]",
    githubOrgsVerifiedAt: "2026-07-31T12:00:00.000Z"
  };
  assert.equal(hasFreshGithubOrgs(user, 24 * 60 * 60 * 1000, NOW), true);
  assert.deepEqual(githubClaims(user, 24 * 60 * 60 * 1000, GITHUB_SCOPES, NOW), {
    [LOGIN_CLAIM]: "octocat",
    [ORGS_CLAIM]: [],
    [EXPIRY_CLAIM]: "2026-08-01T12:00:00.000Z"
  });
});

test("omits expired organization claims", () => {
  const user = {
    githubLogin: "octocat",
    githubOrgs: JSON.stringify(["former-org"]),
    githubOrgsVerifiedAt: "2026-07-30T00:00:00.000Z"
  };
  assert.equal(hasFreshGithubOrgs(user, 24 * 60 * 60 * 1000, NOW), false);
  assert.deepEqual(githubClaims(user, 24 * 60 * 60 * 1000, GITHUB_SCOPES, NOW), {
    [LOGIN_CLAIM]: "octocat"
  });
});

test("fails closed for malformed stored organization data", () => {
  assert.deepEqual(
    githubClaims(
      {
        githubLogin: "octocat",
        githubOrgs: '{"not":"an array"}',
        githubOrgsVerifiedAt: "2026-07-31T12:00:00.000Z"
      },
      24 * 60 * 60 * 1000,
      GITHUB_SCOPES,
      NOW
    ),
    { [LOGIN_CLAIM]: "octocat" }
  );
});

test("omits private GitHub claims without the github scope", () => {
  assert.deepEqual(
    githubClaims(
      {
        githubLogin: "octocat",
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
