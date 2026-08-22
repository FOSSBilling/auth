-- Custom SQL migration file, put your code below! --

-- Apply this only after 0004 has added the new nullable columns, and
-- before the migration that makes `account.issuer` NOT NULL and adds the
-- compound unique index -- that migration will fail loudly on any row
-- this backfill missed.

-- GitHub is the only provider configured (see socialProviders in
-- src/auth.ts) and it's a plain OAuth2 provider, not OIDC, so its accounts
-- get the synthetic `local:oauth:<providerId>` issuer namespace. Scoped to
-- providerId = 'github' rather than backfilling every row unconditionally,
-- so an unexpected providerId surfaces as a NOT NULL failure in the next
-- migration instead of being silently mis-tagged.
UPDATE `account`
SET `issuer` = 'local:oauth:github'
WHERE `issuer` IS NULL
  AND `providerId` = 'github';

-- Map the old `type` values to the new `applicationType`, defaulting to
-- "web" the same way better-auth treats a client with no recorded type.
UPDATE `oauthClient`
SET `applicationType` = CASE WHEN `type` = 'native' THEN 'native' ELSE 'web' END
WHERE `applicationType` IS NULL;

-- A client that was public under the old model must keep working as a
-- public client (no client secret required) under the new
-- tokenEndpointAuthMethod-based model.
UPDATE `oauthClient`
SET `tokenEndpointAuthMethod` = 'none'
WHERE `public` = 1
  AND (`tokenEndpointAuthMethod` IS NULL OR `tokenEndpointAuthMethod` = '');

-- No equivalent column existed before; start every existing client with
-- no client_credentials scopes granted, matching the plugin's own default.
UPDATE `oauthClient`
SET `clientCredentialsScopes` = '[]'
WHERE `clientCredentialsScopes` IS NULL;
