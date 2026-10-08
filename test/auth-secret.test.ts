import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { requireBetterAuthSecret } from "../src/auth-secret.ts";

const source = readFileSync(new URL("../src/auth.ts", import.meta.url), "utf8");
const config = JSON.parse(
  readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8")
) as { vars: { NODE_ENV?: string } };

test("auth creation validates the Worker binding before Better Auth receives it", () => {
  assert.match(
    source,
    /const secret = requireBetterAuthSecret\(env\.BETTER_AUTH_SECRET\)/
  );
  assert.match(source, /secret,\s*disabledPaths:/);
  assert.equal(config.vars.NODE_ENV, "production");
});

test("missing, weak, and public secrets fail closed in every environment", () => {
  for (const value of [
    undefined,
    null,
    "",
    " ",
    "short-secret",
    "a".repeat(64),
    "secret".repeat(8),
    "0123456789abcdef0123456789abcdef",
    "better-auth-secret-12345678901234567890",
    "replace-with-openssl-rand-base64-32",
    "xR6kj3mGpD9fB2qZ0vhNcYaT5sL8uW1e "
  ]) {
    assert.throws(() => requireBetterAuthSecret(value));
  }
});

test("a configured random secret is preserved exactly for state validation", () => {
  const secret = "xR6kj3mGpD9fB2qZ0vhNcYaT5sL8uW1e";
  assert.equal(requireBetterAuthSecret(secret), secret);
});
