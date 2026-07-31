-- Custom SQL migration file, put your code below! --

-- Per-client scopes never inherit later additions to the global scope list
-- (see PR #16) -- backfill `github` onto clients registered before it existed.
UPDATE `oauthClient`
SET `scopes` = json_insert(`scopes`, '$[#]', 'github')
WHERE `scopes` IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM json_each(`oauthClient`.`scopes`) WHERE json_each.value = 'github'
  );
