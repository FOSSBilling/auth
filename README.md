# FOSSBilling Auth

Central authentication service for FOSSBilling-operated applications.

This service owns identity and OAuth/OIDC issuance; consuming applications own their own authorization rules and product-specific permissions.

## Local Setup

Install dependencies:

```bash
npm install
```

Create local secrets:

```bash
cp .dev.vars.example .dev.vars
openssl rand -base64 32
```

Replace the `BETTER_AUTH_SECRET` placeholder in `.dev.vars` with the generated
value before starting the Worker. The placeholder is deliberately rejected.

Set the GitHub OAuth callback URL to:

```text
http://localhost:8787/callback/github
```

Apply migrations to the local D1 database (miniflare creates it from the
`AUTH_DB` binding in `wrangler.jsonc` — no `wrangler d1 create` needed):

```bash
npm run db:migrate:local
```

The Drizzle schema in `src/db/schema.ts` is the source of truth for database
structure. Generate SQL migrations from it before applying them:

```bash
npm run db:generate -- --name my_change
npm run db:check
```

Before applying migration `0015_strong_forge` to an existing D1
database, check for provider identities already linked to more than one user:

```sql
SELECT providerId, accountId, COUNT(*) AS bindings
FROM account
GROUP BY providerId, accountId
HAVING COUNT(*) > 1;
```

If this returns rows, investigate each binding and its dependent sessions and
tokens, then reconcile the users before applying the migration. The unique
index deliberately fails while duplicates remain; it does not choose an
account owner or delete identity data automatically.

Start the Worker:

```bash
npm run dev
```

`npm run dev` rebuilds the BasecoatUI stylesheet first (`predev` →
`build`). The pages in `src/views.ts` link the compiled CSS at
`/styles.css`, which is built from `src/styles.css`
(`@import "tailwindcss"; @import "basecoat-css";`) into `public/styles.css`
and served as a Worker Static Asset (see `assets` in `wrangler.jsonc`). Run
`npm run build` manually after editing `src/styles.css` if the dev
server isn't running. Always deploy with `npm run deploy` (not bare
`wrangler deploy`) so the `predeploy` hook rebuilds the stylesheet.

## Production Setup

> **Note:** `wrangler.jsonc` intentionally has no `routes` entry. A `routes` block with
> `custom_domain: true` breaks `wrangler dev` locally (Origin/Host resolution gets
> corrupted, causing spurious `Invalid origin` errors — see
> [workers-sdk#14683](https://github.com/cloudflare/workers-sdk/issues/14683)). The
> `auth.fossbilling.net` custom domain is instead attached to this Worker directly in
> the Cloudflare dashboard, so `wrangler deploy` (which has no `routes` to sync) won't
> touch or remove it.

1. Create a Cloudflare D1 database.
2. Replace `database_id` in `wrangler.jsonc`.
3. Set Worker secrets:

```bash
# Generate a fresh value and paste it when Wrangler prompts. Do not commit it.
openssl rand -base64 32
npx wrangler secret put BETTER_AUTH_SECRET
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler secret put ADMIN_USER_IDS
```

`ADMIN_USER_IDS` is a comma-separated, case-sensitive list of immutable local user IDs
allowed to manage OAuth clients (create/read/update/delete/list/rotate and configure
client-credentials scopes). Provision each ID deliberately after confirming the
intended person's GitHub identity; the local user ID is shown on `/account`.
Email addresses and email verification do not grant this role. `ADMIN_EMAILS` is
no longer used: migrate existing administrators explicitly before deploying this
change. An absent or empty `ADMIN_USER_IDS` denies all client administration.

Client administration also requires a session created less than 15 minutes ago.
Sliding session renewal does not extend this window. Sign out and sign in again
with GitHub to regain the window; ordinary account and OAuth usage is unaffected.
To offboard an administrator, remove their local user ID from `ADMIN_USER_IDS` and
activate the updated Worker configuration. All subsequent client-management
requests are denied, including requests with existing sessions. Also revoke their
sessions and review/deprovision their owned clients and credentials as appropriate;
removing this role does not invalidate previously issued OAuth tokens or clients.

Set `BETTER_AUTH_SECRET` separately for every deployed environment, including
preview environments. The Worker rejects missing, example, short, and low-diversity
values before constructing Better Auth; `NODE_ENV` is also set to `production` in
`wrangler.jsonc`. After deployment, request `/sign-in` in each environment and
confirm it serves normally. A missing or invalid secret makes the request fail
instead of allowing Better Auth to use its published fallback key.

Collection is limited to four pages (up to
300 memberships), 256 KiB per response, 8 KiB for the serialized organization
list, and five seconds. Exceeding any limit leaves organization evidence
unknown: sign-in can continue, while the previous snapshot and its original
verification time remain unchanged. An oversized stored snapshot is omitted
from GitHub claims and treated as needing refresh; lists are never truncated.

`GITHUB_ORGS_MAX_AGE_SECONDS` controls how long a successful GitHub organization
membership lookup may be used in the custom `github_orgs` claim. It defaults to 86400
(24 hours) when absent or invalid. The issuer also emits the absolute RFC3339
`https://fossbilling.org/claims/github_orgs_expires_at` claim whenever `github_orgs` is
present; consumers must reject missing or expired organization evidence. A transient
GitHub failure preserves the last successful list and its original expiry only for
the same immutable GitHub account. Switching accounts without a successful lookup
clears organization evidence. Migration `0011` clears existing snapshots whose
source account cannot be established; a successful GitHub sign-in restores them.

`github_id` is the immutable GitHub provider account ID (a decimal string) and is
the external identity key. `github_login` is display metadata, never an
authorization key. It is omitted until GitHub authentication verifies it, and
expires after `GITHUB_ORGS_MAX_AGE_SECONDS`, independently of organization
lookup success. Consumers must enforce `github_login_expires_at` even if the
containing token is still valid; reauthenticate with GitHub to refresh it.
Migration 0009 leaves existing identity evidence null rather than treating
legacy handles as freshly verified. Apply it before deploying this code.

OAuth clients must request the dedicated `github` scope to receive the linked GitHub
claims (`github_id`, `github_login`, `github_login_expires_at`, `github_orgs`, and
`github_orgs_expires_at`). Without that scope,
those claims are omitted; the central `user_id` claim remains available independently.
A client's allowed scopes are fixed to whatever list it was created with, so clients
registered before the `github` scope existed need it backfilled onto their stored
`scopes` — see `migrations/0003_backfill_github_scope.sql` — or they'll get
`invalid_scope` when they start requesting it.

4. Apply remote migrations:

```bash
npm run db:migrate:remote
```

5. Deploy:

```bash
npm run deploy
```

The production GitHub OAuth callback URL should be:

```text
https://auth.fossbilling.net/callback/github
```

## GitHub credential storage and secret rotation

GitHub access and refresh tokens are encrypted by Better Auth using
`BETTER_AUTH_SECRET` before being stored in D1. Keep that secret separate from
database exports. GitHub does not issue OIDC ID tokens in this flow; Better Auth's
option does not encrypt the `idToken` column.

For the first encrypted deployment, pause sign-in/link callbacks and other
account writes during the rollout. Revoke existing GitHub OAuth grants (users can
revoke this application under GitHub Settings → Applications) and handle any
retained exports containing old tokens as sensitive credentials. Migration
`0010_clear_unencrypted_github_tokens.sql` clears GitHub token and expiry columns,
including dormant accounts, while preserving users, sessions and stable GitHub
account bindings. Apply it before deploying the encryption-enabled Worker, then
resume traffic. Clearing D1 values alone does not revoke tokens held in old
exports. Users must sign in again or use “Refresh GitHub access” on the account
page to obtain fresh credentials; they retain the same local user ID.

`BETTER_AUTH_SECRET` also encrypts persisted JWT signing keys in `jwks`. Never
replace it on its own: an existing key would still be selected for signing but
could not be decrypted. Rotate the secret and signing key together:

1. Pause OAuth issuance and account writes. Save the current
   `BETTER_AUTH_SECRET` securely as the legacy secret, and prepare a fresh random
   secret. Do not remove the legacy secret yet.
2. Revoke old GitHub grants and run the UPDATE from migration 0010 against the
   active D1 database. The migration runner will not rerun an already-applied
   migration. Check for resources pinned to a signing key:

   ```sql
   SELECT id, signingKeyId FROM oauthResource WHERE signingKeyId IS NOT NULL;
   ```

   If this returns rows, reassign their signing keys as part of a separate
   planned resource-key rotation before proceeding. Expiring a pinned key makes
   issuance for that resource fail.

3. Keep `BETTER_AUTH_SECRET` set to the legacy value and configure the Worker
   secret `BETTER_AUTH_SECRETS` as `1:<new-secret>,0:<legacy-secret>` (use the
   next unused version on later rotations). Deploy and confirm JWT issuance
   succeeds. The first version encrypts new data; the legacy secret still
   decrypts existing unversioned JWKS ciphertext.
4. With issuance still paused, expire current signing keys in D1:

   ```sql
   UPDATE jwks
   SET expiresAt = (unixepoch('now') * 1000) - 1000
   WHERE expiresAt IS NULL OR expiresAt > unixepoch('now') * 1000;
   ```

   Request a new signed token and confirm it uses a new `kid`. Check that
   `/.well-known/jwks.json` contains both the old and new public keys before
   resuming traffic. Expired keys remain published for the JWT plugin's default
   30-day grace period, so existing tokens can still be verified. This service
   issues access and ID tokens for at most one hour.

5. After the new key is signing and all legacy encrypted credentials and
   short-lived replay data have expired or been cleared, remove the old
   `BETTER_AUTH_SECRET` binding and its old version from `BETTER_AUTH_SECRETS`.
   Keep the current version in `BETTER_AUTH_SECRETS`. Confirm issuance and JWKS
   again. Users should sign in again because old secret-protected cookies no
   longer verify. Fresh sign-in or re-link writes GitHub tokens under the new
   secret.

Keep old public keys in D1 through the token-validity and JWKS cache window;
remove expired rows only after that window. Never remove an old secret while
live signing keys or other encrypted rows still require it.

## OAuth Provider Shape

Canonical issuer:

```text
https://auth.fossbilling.net
```

Important endpoints:

```text
GET  /.well-known/openid-configuration
GET  /.well-known/oauth-authorization-server
GET  /.well-known/jwks.json
GET  /oauth2/authorize
POST /oauth2/token
GET  /oauth2/userinfo
POST /oauth2/introspect
POST /oauth2/revoke
```

Dynamic client registration is intentionally disabled. First-party OAuth clients should be created deliberately through an internal/admin process rather than self-service public registration — enforced by `ADMIN_USER_IDS` (see [Production Setup](#production-setup)), since otherwise any GitHub-authenticated user could call the authenticated client-management endpoints.

## Boundary

Keep this service focused on identity:

- login and logout
- linked providers
- sessions
- OAuth/OIDC clients and tokens
- account security

Do not put extension ownership, package review, marketplace moderation, or product-specific roles in this repository. Those belong in the consuming applications and should reference the central auth user ID.
