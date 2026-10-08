import { Hono, type Context } from "hono";
import { createAuth, isTrustedCallbackUrl, type Auth } from "./auth";
import { getGithubOrgsMaxAgeMs, hasFreshGithubOrgs } from "./github-claims";
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
  return c.get("auth").handler(c.req.raw);
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

// better-auth owns method validation (405 JSON) for these endpoints —
// restricting methods here would turn e.g. PATCH/DELETE on /oauth2/*
// client-management routes into Hono 404 text instead, so match all methods
// but still reject unknown wildcard suffixes before they can create a fresh
// database limiter row for every attacker-chosen URL.
app.all("/sign-in/social", handleAuth);
app.all("/link-social", handleAuth);
app.all("/callback/github", handleAuth);
app.all("/sign-out", handleAuth);
app.all("/get-session", handleAuth);
app.all("/list-sessions", handleAuth);
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
  }
});
