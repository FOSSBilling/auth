-- Custom SQL migration file, put your code below! --

-- OAuth clients created before the `github` scope existed had their allowed
-- `scopes` list captured at creation time (see /oauth2/register and
-- /oauth2/create-client), so adding it to the server-wide scope list in
-- src/auth.ts doesn't retroactively make it valid for them --
-- @better-auth/oauth-provider validates a requested scope against
-- `client.scopes ?? opts.scopes`, so a non-null per-client list is used
-- exclusively and never merged with the global one. Backfill `github` onto
-- every already-registered client so it becomes requestable everywhere the
-- new global scope list intends it to be.
UPDATE `oauthClient`
SET `scopes` = json_insert(`scopes`, '$[#]', 'github')
WHERE `scopes` IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM json_each(`oauthClient`.`scopes`) WHERE json_each.value = 'github'
  );
