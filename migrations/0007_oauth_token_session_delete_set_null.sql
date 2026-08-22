-- D1 enforces foreign key constraints unconditionally: neither
-- `PRAGMA foreign_keys=OFF` nor `PRAGMA defer_foreign_keys=true` suppress
-- them here (confirmed empirically, despite
-- https://developers.cloudflare.com/d1/reference/migrations/#foreign-key-constraints
-- documenting the latter as the way to do this). Recreating
-- oauthRefreshToken below would therefore cascade-delete any
-- oauthAccessToken row still pointing at it through refreshId (ON DELETE
-- CASCADE), so that link is broken here first and restored once both
-- tables are back in place.
CREATE TABLE `__oauthAccessToken_refreshId_backup` (
	`id` text PRIMARY KEY NOT NULL,
	`refreshId` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `__oauthAccessToken_refreshId_backup` (`id`, `refreshId`) SELECT `id`, `refreshId` FROM `oauthAccessToken` WHERE `refreshId` IS NOT NULL;--> statement-breakpoint
CREATE TABLE `__new_oauthAccessToken` (
	`id` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`clientId` text NOT NULL,
	`sessionId` text,
	`userId` text,
	`referenceId` text,
	`authorizationCodeId` text,
	`resources` text,
	`requestedUserInfoClaims` text,
	`refreshId` text,
	`expiresAt` integer NOT NULL,
	`createdAt` integer NOT NULL,
	`revoked` integer,
	`confirmation` text,
	`scopes` text NOT NULL,
	FOREIGN KEY (`clientId`) REFERENCES `oauthClient`(`clientId`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`sessionId`) REFERENCES `session`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`refreshId`) REFERENCES `oauthRefreshToken`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_oauthAccessToken`("id", "token", "clientId", "sessionId", "userId", "referenceId", "authorizationCodeId", "resources", "requestedUserInfoClaims", "refreshId", "expiresAt", "createdAt", "revoked", "confirmation", "scopes") SELECT "id", "token", "clientId", "sessionId", "userId", "referenceId", "authorizationCodeId", "resources", "requestedUserInfoClaims", NULL, "expiresAt", "createdAt", "revoked", "confirmation", "scopes" FROM `oauthAccessToken`;--> statement-breakpoint
DROP TABLE `oauthAccessToken`;--> statement-breakpoint
ALTER TABLE `__new_oauthAccessToken` RENAME TO `oauthAccessToken`;--> statement-breakpoint
CREATE UNIQUE INDEX `oauthAccessToken_token_unique` ON `oauthAccessToken` (`token`);--> statement-breakpoint
CREATE INDEX `oauthAccessToken_clientId_idx` ON `oauthAccessToken` (`clientId`);--> statement-breakpoint
CREATE INDEX `oauthAccessToken_sessionId_idx` ON `oauthAccessToken` (`sessionId`);--> statement-breakpoint
CREATE INDEX `oauthAccessToken_userId_idx` ON `oauthAccessToken` (`userId`);--> statement-breakpoint
CREATE INDEX `oauthAccessToken_refreshId_idx` ON `oauthAccessToken` (`refreshId`);--> statement-breakpoint
CREATE INDEX `oauthAccessToken_authorizationCodeId_idx` ON `oauthAccessToken` (`authorizationCodeId`);--> statement-breakpoint
CREATE TABLE `__new_oauthRefreshToken` (
	`id` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`clientId` text NOT NULL,
	`sessionId` text,
	`userId` text NOT NULL,
	`referenceId` text,
	`authorizationCodeId` text,
	`resources` text,
	`requestedUserInfoClaims` text,
	`expiresAt` integer NOT NULL,
	`createdAt` integer NOT NULL,
	`revoked` integer,
	`rotatedAt` integer,
	`rotationReplayResponse` text,
	`rotationReplayExpiresAt` integer,
	`authTime` integer,
	`confirmation` text,
	`scopes` text NOT NULL,
	FOREIGN KEY (`clientId`) REFERENCES `oauthClient`(`clientId`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`sessionId`) REFERENCES `session`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_oauthRefreshToken`("id", "token", "clientId", "sessionId", "userId", "referenceId", "authorizationCodeId", "resources", "requestedUserInfoClaims", "expiresAt", "createdAt", "revoked", "rotatedAt", "rotationReplayResponse", "rotationReplayExpiresAt", "authTime", "confirmation", "scopes") SELECT "id", "token", "clientId", "sessionId", "userId", "referenceId", "authorizationCodeId", "resources", "requestedUserInfoClaims", "expiresAt", "createdAt", "revoked", "rotatedAt", "rotationReplayResponse", "rotationReplayExpiresAt", "authTime", "confirmation", "scopes" FROM `oauthRefreshToken`;--> statement-breakpoint
DROP TABLE `oauthRefreshToken`;--> statement-breakpoint
ALTER TABLE `__new_oauthRefreshToken` RENAME TO `oauthRefreshToken`;--> statement-breakpoint
CREATE UNIQUE INDEX `oauthRefreshToken_token_unique` ON `oauthRefreshToken` (`token`);--> statement-breakpoint
CREATE INDEX `oauthRefreshToken_clientId_idx` ON `oauthRefreshToken` (`clientId`);--> statement-breakpoint
CREATE INDEX `oauthRefreshToken_sessionId_idx` ON `oauthRefreshToken` (`sessionId`);--> statement-breakpoint
CREATE INDEX `oauthRefreshToken_userId_idx` ON `oauthRefreshToken` (`userId`);--> statement-breakpoint
CREATE INDEX `oauthRefreshToken_authorizationCodeId_idx` ON `oauthRefreshToken` (`authorizationCodeId`);--> statement-breakpoint
UPDATE `oauthAccessToken` SET `refreshId` = (SELECT `refreshId` FROM `__oauthAccessToken_refreshId_backup` WHERE `__oauthAccessToken_refreshId_backup`.`id` = `oauthAccessToken`.`id`) WHERE `id` IN (SELECT `id` FROM `__oauthAccessToken_refreshId_backup`);--> statement-breakpoint
DROP TABLE `__oauthAccessToken_refreshId_backup`;
