CREATE TABLE `oauthClientAssertion` (
	`id` text PRIMARY KEY NOT NULL,
	`expiresAt` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `oauthClientResource` (
	`id` text PRIMARY KEY NOT NULL,
	`clientId` text NOT NULL,
	`resourceId` text NOT NULL,
	`metadata` text,
	`createdAt` integer,
	FOREIGN KEY (`clientId`) REFERENCES `oauthClient`(`clientId`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`resourceId`) REFERENCES `oauthResource`(`identifier`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `oauthClientResource_clientId_idx` ON `oauthClientResource` (`clientId`);--> statement-breakpoint
CREATE INDEX `oauthClientResource_resourceId_idx` ON `oauthClientResource` (`resourceId`);--> statement-breakpoint
CREATE UNIQUE INDEX `oauthClientResource_clientId_resourceId_uidx` ON `oauthClientResource` (`clientId`,`resourceId`);--> statement-breakpoint
CREATE TABLE `oauthResource` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`name` text NOT NULL,
	`accessTokenTtl` integer,
	`refreshTokenTtl` integer,
	`signingAlgorithm` text,
	`signingKeyId` text,
	`allowedScopes` text,
	`customClaims` text,
	`dpopBoundAccessTokensRequired` integer,
	`disabled` integer,
	`createdAt` integer,
	`updatedAt` integer,
	`policyVersion` integer,
	`metadata` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauthResource_identifier_unique` ON `oauthResource` (`identifier`);--> statement-breakpoint
ALTER TABLE `account` ADD `issuer` text;--> statement-breakpoint
ALTER TABLE `jwks` ADD `alg` text;--> statement-breakpoint
ALTER TABLE `jwks` ADD `crv` text;--> statement-breakpoint
ALTER TABLE `oauthAccessToken` ADD `authorizationCodeId` text;--> statement-breakpoint
ALTER TABLE `oauthAccessToken` ADD `resources` text;--> statement-breakpoint
ALTER TABLE `oauthAccessToken` ADD `requestedUserInfoClaims` text;--> statement-breakpoint
ALTER TABLE `oauthAccessToken` ADD `revoked` integer;--> statement-breakpoint
ALTER TABLE `oauthAccessToken` ADD `confirmation` text;--> statement-breakpoint
CREATE INDEX `oauthAccessToken_authorizationCodeId_idx` ON `oauthAccessToken` (`authorizationCodeId`);--> statement-breakpoint
ALTER TABLE `oauthClient` ADD `clientDiscoveryId` text;--> statement-breakpoint
ALTER TABLE `oauthClient` ADD `clientCredentialsScopes` text;--> statement-breakpoint
ALTER TABLE `oauthClient` ADD `backchannelLogoutUri` text;--> statement-breakpoint
ALTER TABLE `oauthClient` ADD `backchannelLogoutSessionRequired` integer;--> statement-breakpoint
ALTER TABLE `oauthClient` ADD `applicationType` text;--> statement-breakpoint
ALTER TABLE `oauthClient` ADD `jwks` text;--> statement-breakpoint
ALTER TABLE `oauthClient` ADD `jwksUri` text;--> statement-breakpoint
ALTER TABLE `oauthClient` ADD `dpopBoundAccessTokens` integer;--> statement-breakpoint
ALTER TABLE `oauthConsent` ADD `resources` text;--> statement-breakpoint
ALTER TABLE `oauthConsent` ADD `requestedUserInfoClaims` text;--> statement-breakpoint
ALTER TABLE `oauthRefreshToken` ADD `authorizationCodeId` text;--> statement-breakpoint
ALTER TABLE `oauthRefreshToken` ADD `resources` text;--> statement-breakpoint
ALTER TABLE `oauthRefreshToken` ADD `requestedUserInfoClaims` text;--> statement-breakpoint
ALTER TABLE `oauthRefreshToken` ADD `rotatedAt` integer;--> statement-breakpoint
ALTER TABLE `oauthRefreshToken` ADD `rotationReplayResponse` text;--> statement-breakpoint
ALTER TABLE `oauthRefreshToken` ADD `rotationReplayExpiresAt` integer;--> statement-breakpoint
ALTER TABLE `oauthRefreshToken` ADD `confirmation` text;--> statement-breakpoint
CREATE INDEX `oauthRefreshToken_authorizationCodeId_idx` ON `oauthRefreshToken` (`authorizationCodeId`);