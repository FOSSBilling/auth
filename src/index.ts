import { Hono, type Context } from "hono";
import { createAuth, isTrustedCallbackUrl, type Auth } from "./auth";
import type { AppSession, Env } from "./types";
import { accountPage, consentPage, signInPage } from "./views";

type HonoEnv = {
  Bindings: Env;
  Variables: { auth: Auth };
};

const app = new Hono<HonoEnv>({ strict: false });
const authMethods = ["GET", "POST"];

app.use("*", async (c, next) => {
  c.set("auth", createAuth(c.env));
  await next();
  c.header("referrer-policy", "no-referrer");
  c.header("x-content-type-options", "nosniff");
  c.header("x-frame-options", "DENY");
  c.header(
    "content-security-policy",
    "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; img-src https: data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
  );
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
  return c.html(signInPage(error, callbackURL));
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
      c.req.query("scope") ?? ""
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

  return c.html(accountPage(session, callbackURL));
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
