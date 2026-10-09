import { Hono, type Context } from "hono";
import { createAuth, isTrustedCallbackUrl, type Auth } from "./auth";
import { getGithubOrgsMaxAgeMs, hasFreshGithubOrgs } from "./github-claims";
import {
  filterUserInfoResponse,
  hasUnscopedUserInfoClaims,
  permittedUserInfoClaims,
  OAUTH_SCOPES,
  OPAQUE_ACCESS_TOKEN_PREFIX
} from "./oauth-userinfo-claims";
import { deleteExpiredClientAssertions } from "./oauth-assertion-cleanup";
import type { AppSession, Env } from "./types";
import { accountPage, consentPage, errorPage, signInPage } from "./views";

type HonoEnv = {
  Bindings: Env;
  Variables: { auth: Auth; cspNonce: string };
};

const app = new Hono<HonoEnv>({ strict: false });

// The database limiter keys by path. Reject unknown wildcard suffixes before
// they can create a fresh limiter row for every attacker-chosen URL.
const oauthPaths = new Set([
  "/oauth2/authorize",
  "/oauth2/client/rotate-secret",
  "/oauth2/consent",
  "/oauth2/continue",
  "/oauth2/create-client",
  "/oauth2/delete-client",
  "/oauth2/delete-consent",
  "/oauth2/end-session",
  "/oauth2/end-session/confirm",
  "/oauth2/get-client",
  "/oauth2/get-clients",
  "/oauth2/get-consent",
  "/oauth2/get-consents",
  "/oauth2/introspect",
  "/oauth2/public-client",
  "/oauth2/public-client-prelogin",
  "/oauth2/register",
  "/oauth2/revoke",
  "/oauth2/token",
  "/oauth2/update-client",
  "/oauth2/update-consent",
  "/oauth2/userinfo"
]);
const wellKnownPaths = new Set([
  "/.well-known/jwks.json",
  "/.well-known/oauth-authorization-server",
  "/.well-known/openid-configuration"
]);

// CSP nonces must be unique per response.
function newNonce(): string {
  return btoa(
    String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16)))
  );
}

// No inline-script fallback is allowlisted: every inline <script> this
// worker renders carries the per-request nonce instead. The Web Analytics
// beacon is an external script from an allowlisted host, so it needs no nonce.
function contentSecurityPolicy(nonce: string): string {
  return `default-src 'none'; script-src 'self' 'nonce-${nonce}' https://static.cloudflareinsights.com; style-src 'self'; img-src 'self' https: data:; connect-src 'self' https://cloudflareinsights.com; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`;
}

app.use("*", async (c, next) => {
  c.set("auth", createAuth(c.env, c.executionCtx));
  const cspNonce = newNonce();
  c.set("cspNonce", cspNonce);
  await next();
  // Navigation redirects (e.g. GET /callback/github) come back from
  // better-auth as 302 with a JSON content-type and empty body, which
  // browsers save as a 0-byte file instead of following Location. When
  // the redirect carries no body, drop those headers and let Location
  // win. Non-empty redirects and 304s are left alone.
  {
    const status = c.res.status;
    const isRedirect =
      status === 301 ||
      status === 302 ||
      status === 303 ||
      status === 307 ||
      status === 308;
    const bodyIsEmpty =
      c.res.body === null || c.res.headers.get("content-length") === "0";
    if (isRedirect && c.res.headers.has("location") && bodyIsEmpty) {
      c.header("content-type", undefined);
      c.header("content-length", undefined);
    }
  }
  // Account and OAuth pages contain session or interaction state. Apply the
  // policy to HTML responses so static assets and public JSON keep theirs.
  if (
    c.res.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() ===
    "text/html"
  ) {
    c.header("cache-control", "no-store, max-age=0");
    c.header("pragma", "no-cache");
    c.header("expires", "0");
  }
  c.header("referrer-policy", "no-referrer");
  c.header("x-content-type-options", "nosniff");
  c.header("x-frame-options", "DENY");
  c.header("content-security-policy", contentSecurityPolicy(cspNonce));
  c.header(
    "permissions-policy",
    "accelerometer=(), camera=(), geolocation=(), gyroscope=(), microphone=(), payment=(), usb=()"
  );
});

async function getSession(
  auth: Auth,
  request: Request
): Promise<AppSession | null> {
  const session = await auth.api.getSession({
    headers: request.headers
  });

  return session as AppSession | null;
}

async function handleAuth(c: Context<HonoEnv>) {
  const auth = c.get("auth");
  try {
    return await auth.handler(c.req.raw);
  } finally {
    auth.clearGithubProfileStaging();
  }
}

function parseStoredScopes(value: unknown): string[] | null {
  try {
    const scopes = typeof value === "string" ? JSON.parse(value) : value;
    return Array.isArray(scopes) && scopes.every((s) => typeof s === "string")
      ? scopes
      : null;
  } catch {
    return null;
  }
}

async function authorizationScopes(
  c: Context<HonoEnv>,
  parameters: URLSearchParams
): Promise<string[]> {
  const requested = parameters.get("scope");
  if (requested !== null) return requested.split(" ").filter(Boolean);
  const clientId = parameters.get("client_id");
  if (!clientId) return [];
  const client = await c.env.AUTH_DB.prepare(
    "SELECT scopes FROM oauthClient WHERE clientId = ?"
  )
    .bind(clientId)
    .first<{ scopes: string | null }>();
  return client?.scopes === null
    ? OAUTH_SCOPES
    : (parseStoredScopes(client?.scopes) ?? []);
}

async function handleOAuthAuthorize(c: Context<HonoEnv>) {
  const request = c.req.raw;
  // The provider reads form fields for POST and URL parameters for GET.
  const parameters =
    request.method === "POST"
      ? request.headers
          .get("content-type")
          ?.toLowerCase()
          .startsWith("application/x-www-form-urlencoded")
        ? new URLSearchParams(await request.clone().text())
        : new URLSearchParams()
      : new URL(request.url).searchParams;
  const values = parameters.getAll("claims");
  const scopes = values.length ? await authorizationScopes(c, parameters) : [];
  if (values.some((value) => hasUnscopedUserInfoClaims(value, scopes))) {
    // Let the provider reject an invalid claims request so it validates the
    // client's redirect URI and sends the OAuth error back with the state.
    // This cannot issue a code: the provider rejects a non-object claims value.
    if (request.method === "POST") {
      const body = new URLSearchParams(await request.clone().text());
      body.set("claims", "null");
      const headers = new Headers(request.headers);
      headers.delete("content-length");
      return c.get("auth").handler(new Request(request, { headers, body }));
    }
    const url = new URL(request.url);
    url.searchParams.set("claims", "null");
    return c.get("auth").handler(new Request(url, request));
  }
  return handleAuth(c);
}

async function handleOAuthConsent(c: Context<HonoEnv>) {
  const request = c.req.raw;
  let body: unknown;
  try {
    body = await request.clone().json();
  } catch {
    return handleAuth(c);
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return handleAuth(c);
  }
  // The provider defaults omitted claims to every claim in the signed request.
  // Submit only claims backed by scopes the user actually accepted.
  const submitted = body as Record<string, unknown>;
  const query = new URLSearchParams(
    typeof submitted.oauth_query === "string" ? submitted.oauth_query : ""
  );
  const scopes =
    typeof submitted.scope === "string"
      ? submitted.scope.split(" ").filter(Boolean)
      : await authorizationScopes(c, query);
  const requestedClaims =
    submitted.claims === undefined ? query.get("claims") : submitted.claims;
  const userinfo = permittedUserInfoClaims(requestedClaims, scopes);
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  return c.get("auth").handler(
    new Request(request, {
      headers,
      body: JSON.stringify({ ...submitted, claims: { userinfo } })
    })
  );
}

async function handleOAuthUserInfo(c: Context<HonoEnv>) {
  const request = c.req.raw;
  const authorization = request.headers.get("authorization")?.trim() ?? "";
  const headerToken =
    /^(?:Bearer|DPoP)\s+(.+)$/i.exec(authorization)?.[1]?.trim() ||
    authorization ||
    null;
  const bodyToken =
    request.method === "POST" &&
    request.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("application/x-www-form-urlencoded")
      ? new URLSearchParams(await request.clone().text()).get("access_token")
      : null;
  const token = headerToken ?? bodyToken;
  const response = await handleAuth(c);
  if (!response.ok) return response;
  if (!token) return c.text("Unable to validate UserInfo token", 502);
  // JWT access tokens do not carry individually requested UserInfo claims.
  if (!token?.startsWith(OPAQUE_ACCESS_TOKEN_PREFIX)) return response;

  // The provider stores opaque tokens as unpadded base64url SHA-256 digests.
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token.slice(OPAQUE_ACCESS_TOKEN_PREFIX.length))
  );
  const storedToken = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const row = await c.env.AUTH_DB.prepare(
    "SELECT scopes FROM oauthAccessToken WHERE token = ?"
  )
    .bind(storedToken)
    .first<{ scopes: string }>();
  const scopes = parseStoredScopes(row?.scopes);
  if (
    !scopes ||
    !response.headers.get("content-type")?.includes("application/json")
  )
    return c.text("Unable to validate UserInfo scopes", 502);
  const claims: unknown = await response.json();
  if (claims === null || typeof claims !== "object" || Array.isArray(claims))
    return c.text("Unable to validate UserInfo claims", 502);
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(
    JSON.stringify(
      filterUserInfoResponse(claims as Record<string, unknown>, scopes)
    ),
    { status: response.status, statusText: response.statusText, headers }
  );
}

function trustedCallbackUrl(
  c: Context<HonoEnv>,
  requested: string | undefined
): string {
  return requested && isTrustedCallbackUrl(c.env, requested)
    ? requested
    : "/account";
}

app.get("/", async (c) => {
  const session = await getSession(c.get("auth"), c.req.raw);
  return c.redirect(session ? "/account" : "https://fossbilling.org");
});

app.get("/sign-in", async (c) => {
  const session = await getSession(c.get("auth"), c.req.raw);
  const query = new URL(c.req.url).searchParams;
  const isOAuthPrompt = query.has("client_id") || query.has("sig");

  if (session && !isOAuthPrompt) {
    return c.redirect("/account");
  }

  const error = c.req.query("error")
    ? "GitHub sign-in failed. Try again."
    : null;
  const callbackURL = trustedCallbackUrl(c, c.req.query("callbackURL"));
  return c.html(signInPage(error, callbackURL, c.get("cspNonce")));
});

app.get("/consent", async (c) => {
  const session = await getSession(c.get("auth"), c.req.raw);
  if (!session) {
    const query = new URL(c.req.url).search;
    return c.redirect(`/sign-in${query}`);
  }

  return c.html(
    consentPage(
      c.req.query("client_id") ?? "Unknown client",
      c.req.query("scope") ?? "",
      c.get("cspNonce")
    )
  );
});

app.get("/error", (c) => {
  return c.html(
    errorPage(
      c.req.query("error"),
      c.req.query("error_description"),
      c.get("cspNonce")
    )
  );
});

app.get("/account", async (c) => {
  // Lets a linking caller (e.g. extensions' "Reconnect GitHub") send the
  // user back through its own OIDC flow after linking completes, instead of
  // stranding them on this page — see accountPage's script for how it's used.
  // Read and validate before the session check below so it survives an
  // expired/missing auth session round-tripping through /sign-in too.
  const callbackURL = trustedCallbackUrl(c, c.req.query("callbackURL"));

  const session = await getSession(c.get("auth"), c.req.raw);
  if (!session) {
    const query =
      callbackURL === "/account"
        ? ""
        : `?callbackURL=${encodeURIComponent(callbackURL)}`;
    return c.redirect(`/sign-in${query}`);
  }

  const githubOrgsFresh = hasFreshGithubOrgs(
    session.user,
    getGithubOrgsMaxAgeMs(c.env.GITHUB_ORGS_MAX_AGE_SECONDS)
  );

  // A linking caller sends an explicit callbackURL to grant GitHub org access,
  // then land back there via its own OIDC round-trip. Do not bounce straight
  // back when the snapshot is fresh: fresh-but-incomplete (e.g. org granted
  // in GitHub after the last sign-in, never re-fetched) still blocks org
  // profile creation, and accountPage now offers both Continue and Refresh
  // for that case so the user is never stranded without a re-link path.
  return c.html(
    accountPage(session, callbackURL, githubOrgsFresh, c.get("cspNonce"))
  );
});

// better-auth owns method validation (405 JSON); match all methods here so
// e.g. PATCH/DELETE on /oauth2/* reach it instead of Hono's 404 text.
// Unknown wildcard suffixes are still rejected below before they can mint
// database limiter rows for attacker-chosen URLs.
app.all("/sign-in/social", handleAuth);
app.all("/link-social", handleAuth);
app.all("/callback/github", handleAuth);
app.all("/sign-out", handleAuth);
app.all("/get-session", handleAuth);
// Session inventory carries credential-adjacent metadata. Keep it out of
// shared caches regardless of the upstream cache policy.
app.use("/list-sessions", async (c, next) => {
  await next();
  c.header("cache-control", "no-store, private, max-age=0");
  c.header("pragma", "no-cache");
  c.header("expires", "0");
});
app.all("/list-sessions", handleAuth);
app.all("/oauth2/authorize", handleOAuthAuthorize);
app.post("/oauth2/consent", handleOAuthConsent);
app.all("/oauth2/userinfo", handleOAuthUserInfo);
app.all("/oauth2/*", (c) =>
  oauthPaths.has(c.req.path) ? handleAuth(c) : c.notFound()
);
app.all("/.well-known/*", (c) =>
  wellKnownPaths.has(c.req.path) ? handleAuth(c) : c.notFound()
);

app.notFound((c) => c.text("Not found", 404));

// Expiration invalidates abandoned codes but does not remove their D1 rows.
// Run independently of HTTP traffic and propagate failures to Cron monitoring.
export default Object.assign(app, {
  async scheduled(controller: ScheduledController, env: Env) {
    await env.AUTH_DB.prepare(
      'DELETE FROM "verification" WHERE "expiresAt" < ?'
    )
      .bind(controller.scheduledTime)
      .run();
    // Longer than every configured Better Auth window (currently <= 60s).
    await env.AUTH_DB.prepare("DELETE FROM rateLimit WHERE lastRequest < ?")
      .bind(Date.now() - 10 * 60 * 1000)
      .run();
    await deleteExpiredClientAssertions(env.AUTH_DB);
  }
});
