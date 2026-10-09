-- The update and session deletion run in one SQLite statement. The existing
-- ON DELETE SET NULL then preserves token rows for provider introspection and
-- revocation without leaving a live token during background logout work.
CREATE TRIGGER `session_revoke_access_tokens_before_delete`
BEFORE DELETE ON `session`
BEGIN
  UPDATE `oauthAccessToken`
  SET `revoked` = CAST(strftime('%s', 'now') AS INTEGER) * 1000
  WHERE `sessionId` = OLD.`id` AND `revoked` IS NULL;
END;
