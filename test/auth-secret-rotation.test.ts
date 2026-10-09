import assert from "node:assert/strict";
import { test } from "node:test";
import { betterAuth } from "better-auth/minimal";
import { memoryAdapter } from "better-auth/adapters/memory";
import { jwt } from "better-auth/plugins";
import { getAuthSecretOptions } from "../src/auth-secrets.ts";

const oldSecret = "test-only-original-secret-at-least-32-characters";
const newSecret = "test-only-replacement-secret-at-least-32-characters";

test("versioned rotation keeps old keys available and mints a new signing key", async () => {
  const db: Record<string, Record<string, unknown>[]> = { jwks: [] };
  const create = (old: string | undefined, keyring?: string) =>
    betterAuth({
      baseURL: "https://auth.example.test",
      database: memoryAdapter(db),
      ...getAuthSecretOptions({
        BETTER_AUTH_SECRET: old,
        BETTER_AUTH_SECRETS: keyring
      }),
      plugins: [jwt({ disableSettingJwtHeader: true })],
      logger: { disabled: true }
    });

  const initial = create(oldSecret);
  const first = await initial.api.signJWT({
    body: { payload: { sub: "user" } }
  });
  assert.equal(db.jwks.length, 1);
  const oldKid = db.jwks[0].id;

  const wrong = create(newSecret);
  await assert.rejects(() =>
    wrong.api.signJWT({ body: { payload: { sub: "user" } } })
  );

  const staged = create(oldSecret, `1:${newSecret},0:${oldSecret}`);
  await staged.api.signJWT({ body: { payload: { sub: "user" } } });
  assert.equal(db.jwks.length, 1, "legacy signing key remains usable");

  db.jwks[0].expiresAt = new Date(Date.now() - 1000);
  const second = await staged.api.signJWT({
    body: { payload: { sub: "user" } }
  });
  assert.equal(db.jwks.length, 2);
  assert.notEqual(db.jwks[1].id, oldKid);
  assert.match(db.jwks[1].privateKey as string, /\$ba\$1\$/);

  const publicKeys = await staged.api.getJwks();
  assert.deepEqual(
    new Set(publicKeys.keys.map((key) => key.kid)),
    new Set([oldKid, db.jwks[1].id])
  );
  const retired = create(undefined, `1:${newSecret}`);
  await retired.api.signJWT({ body: { payload: { sub: "user" } } });
  assert.equal(db.jwks.length, 2);
  assert.equal(
    (await retired.api.verifyJWT({ body: { token: first.token } })).payload
      ?.sub,
    "user",
    "previously issued tokens remain verifiable with the old public key"
  );
  assert.equal(
    (await retired.api.verifyJWT({ body: { token: second.token } })).payload
      ?.sub,
    "user"
  );
  assert.notEqual(first.token, second.token);
});

test("secret configuration rejects missing, malformed, and duplicate versions", () => {
  assert.deepEqual(getAuthSecretOptions({ BETTER_AUTH_SECRET: oldSecret }), {
    secret: oldSecret
  });
  assert.throws(() => getAuthSecretOptions({}));
  for (const keyring of ["one:secret", "1:", "1:one,1:two", "1:one,"]) {
    assert.throws(() => getAuthSecretOptions({ BETTER_AUTH_SECRETS: keyring }));
  }
});
