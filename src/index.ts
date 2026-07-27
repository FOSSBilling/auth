import { Hono, type Context } from "hono";
import { createAuth, type Auth } from "./auth";
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
  return c.html(signInPage(error));
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
  const session = await getSession(c.get("auth"), c.req.raw);
  if (!session) {
    return c.redirect("/sign-in");
  }

  return c.html(accountPage(session));
});

app.on(authMethods, "/sign-in/social", handleAuth);
app.on(authMethods, "/callback/:provider", handleAuth);
app.on(authMethods, "/sign-out", handleAuth);
app.on(authMethods, "/get-session", handleAuth);
app.on(authMethods, "/list-sessions", handleAuth);
app.on(authMethods, "/oauth2/*", handleAuth);
app.on(authMethods, "/.well-known/*", handleAuth);

app.notFound((c) => c.text("Not found", 404));

export default app;
