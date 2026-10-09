CREATE TABLE `oauthRefreshLineageTombstone` (
	`clientId` text NOT NULL,
	`userId` text NOT NULL,
	`authorizationCodeId` text NOT NULL,
	`invalidatedAt` integer NOT NULL,
	PRIMARY KEY(`clientId`, `userId`, `authorizationCodeId`)
);
--> statement-breakpoint
-- Every refresh row in a deleted family records its original code lineage.
-- SQLite serializes this delete with concurrent inserts on the same D1 database.
CREATE TRIGGER `oauthRefreshToken_fence_deleted_lineage`
BEFORE DELETE ON `oauthRefreshToken`
BEGIN
  INSERT OR IGNORE INTO `oauthRefreshLineageTombstone`
    (`clientId`, `userId`, `authorizationCodeId`, `invalidatedAt`)
  VALUES
    (OLD.`clientId`, OLD.`userId`, COALESCE(OLD.`authorizationCodeId`, ''), unixepoch('now') * 1000);
END;
--> statement-breakpoint
-- A late rotation carries the same authorizationCodeId as its deleted parent.
-- Empty string represents pre-1.7 refresh rows whose code ID is NULL.
CREATE TRIGGER `oauthRefreshToken_reject_deleted_lineage`
BEFORE INSERT ON `oauthRefreshToken`
WHEN EXISTS (
  SELECT 1 FROM `oauthRefreshLineageTombstone`
  WHERE `clientId` = NEW.`clientId`
    AND `userId` = NEW.`userId`
    AND `authorizationCodeId` = COALESCE(NEW.`authorizationCodeId`, '')
)
BEGIN
  SELECT RAISE(ABORT, 'refresh token lineage invalidated');
END;
