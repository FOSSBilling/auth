-- Remove legacy plaintext credentials before enabling OAuth token encryption.
-- Keep provider/account IDs: the same GitHub identity can sign in again.
UPDATE `account`
SET `accessToken` = NULL,
    `refreshToken` = NULL,
    `idToken` = NULL,
    `accessTokenExpiresAt` = NULL,
    `refreshTokenExpiresAt` = NULL
WHERE `providerId` = 'github';
