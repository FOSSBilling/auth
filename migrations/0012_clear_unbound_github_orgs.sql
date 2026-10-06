-- Existing snapshots do not identify their source GitHub account and may
-- already be mixed with a replacement identity. Require a fresh lookup.
UPDATE `user`
SET `githubOrgs` = NULL, `githubOrgsVerifiedAt` = NULL;
