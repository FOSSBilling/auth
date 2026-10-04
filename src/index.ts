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
const authMethods = ["GET", "POST"];

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

app.on(authMethods, "/sign-in/social", handleAuth);
app.on(authMethods, "/link-social", handleAuth);
app.on(authMethods, "/callback/:provider", handleAuth);
app.on(authMethods, "/sign-out", handleAuth);
app.on(authMethods, "/get-session", handleAuth);
app.on(authMethods, "/list-sessions", handleAuth);
app.on(authMethods, "/oauth2/*", handleAuth);
app.on(authMethods, "/.well-known/*", handleAuth);

app.notFound((c) => c.text("Not found", 404));

export default app;
