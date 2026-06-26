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
```

Set the GitHub OAuth callback URL to:

```text
http://localhost:8787/callback/github
```

Create the local D1 database and apply migrations:

```bash
npx wrangler d1 create fossbilling-auth
npm run db:migrate:local
```

The Drizzle schema in `src/db/schema.ts` is the source of truth for database
structure. Generate SQL migrations from it before applying them:

```bash
npm run db:generate -- --name my_change
npm run db:check
```

Start the Worker:

```bash
npm run dev
```

## Production Setup

1. Create a Cloudflare D1 database.
2. Replace `database_id` in `wrangler.jsonc`.
3. Set Worker secrets:

```bash
npx wrangler secret put BETTER_AUTH_SECRET
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
```

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

Dynamic client registration is intentionally disabled. First-party OAuth clients should be created deliberately through an internal/admin process rather than self-service public registration.

## Boundary

Keep this service focused on identity:

- login and logout
- linked providers
- sessions
- OAuth/OIDC clients and tokens
- account security

Do not put extension ownership, package review, marketplace moderation, or product-specific roles in this repository. Those belong in the consuming applications and should reference the central auth user ID.
