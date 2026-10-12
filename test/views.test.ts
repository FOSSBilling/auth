import assert from "node:assert/strict";
import { test } from "node:test";
import type { AppSession } from "../src/types.ts";
import {
  accountPage,
  consentPage,
  errorPage,
  escapeHtml,
  page,
  signInPage
} from "../src/views.ts";

function fakeSession(user: Partial<AppSession["user"]> = {}): AppSession {
  return {
    session: {
      id: "sess_123",
      userId: "u_123",
      expiresAt: new Date("2026-09-29T00:00:00.000Z")
    },
    user: {
      id: "u_123",
      name: "Test User",
      email: "test@example.com",
      emailVerified: true,
      image: null,
      githubLogin: null,
      githubOrgs: null,
      githubOrgsVerifiedAt: null,
      ...user
    }
  };
}

test("escapeHtml escapes markup and quotes", () => {
  assert.equal(
    escapeHtml(`<script>alert("x'")</script>&`),
    "&lt;script&gt;alert(&quot;x&#039;&quot;)&lt;/script&gt;&amp;"
  );
  assert.equal(escapeHtml(null), "");
  assert.equal(escapeHtml(undefined), "");
});

test("page shell links the stylesheet, favicon and meta", () => {
  const html = page({
    title: "Sign In",
    body: "<p>hi</p>",
    nonce: "c3BpZHVrZW5vbmNl"
  });
  assert.match(html, /^<!doctype html>/);
  assert.ok(html.includes("<title>Sign In | FOSSBilling Auth</title>"));
  assert.ok(
    html.includes('<link rel="stylesheet" href="/styles.css" />'),
    "links the static stylesheet instead of inlining CSS"
  );
  assert.ok(!html.includes(".btn{"), "does not inline compiled CSS");
  assert.ok(
    html.includes(
      '<link rel="icon" type="image/svg+xml" href="/favicon.svg" />'
    )
  );
  assert.ok(html.includes('name="description"'));
  assert.ok(html.includes('name="theme-color"'));
  assert.equal(
    html.match(/<meta name="theme-color"/g)?.length,
    1,
    "uses one theme-color tag synced by the init script, not an OS media pair"
  );
  assert.ok(html.includes("themeMode"), "includes the theme init script");
  assert.ok(
    html.includes("prefers-color-scheme: dark"),
    "follows the OS color scheme"
  );
  assert.ok(!html.includes("(function () {"), "omits page script when absent");
});

test("page shell renders the brand lockup and footer", () => {
  const html = page({
    title: "Sign In",
    body: "<p>hi</p>",
    nonce: "c3BpZHVrZW5vbmNl"
  });
  assert.ok(
    html.includes('<img src="/logo-light.svg" alt="FOSSBilling"'),
    "renders the light wordmark with an accessible name"
  );
  assert.ok(
    html.includes(
      '<img src="/logo-dark.svg" alt="" aria-hidden="true"'
    ),
    "renders the dark wordmark, hidden from assistive tech"
  );
  assert.ok(
    html.includes("The FOSSBilling project."),
    "renders the footer line"
  );
});

test("page escapes title and description", () => {
  const html = page({
    title: `A&B <"test">`,
    body: "",
    description: `Desc <"quoted">`,
    nonce: "c3BpZHVrZW5vbmNl"
  });
  assert.ok(html.includes("<title>A&amp;B &lt;&quot;test&quot;&gt;"));
  assert.ok(html.includes('content="Desc &lt;&quot;quoted&quot;&gt;"'));
});

test("page includes the page script when provided", () => {
  const html = page({
    title: "T",
    body: "",
    script: "window.x = 1;",
    nonce: "c3BpZHVrZW5vbmNl"
  });
  assert.ok(
    html.includes(
      '<script nonce="c3BpZHVrZW5vbmNl">(function () {window.x = 1;})();</script>'
    )
  );
});

test("inline scripts carry the CSP nonce", () => {
  const html = page({
    title: "T",
    body: "",
    script: "window.x = 1;",
    nonce: "c3BpZHVrZW5vbmNl"
  });
  assert.ok(
    html.includes('<script nonce="c3BpZHVrZW5vbmNl">'),
    "theme init script is nonced"
  );
  assert.equal(
    html.match(/<script nonce="c3BpZHVrZW5vbmNl">/g)?.length,
    2,
    "both inline scripts are nonced"
  );
  assert.ok(!html.includes("<script>"), "no un-nonced inline scripts");
});

test("signInPage renders the GitHub button without an error", () => {
  const html = signInPage(null);
  assert.ok(html.includes('class="card"'));
  assert.ok(html.includes('id="github-sign-in"'));
  assert.ok(html.includes("Continue with GitHub"));
  assert.ok(!html.includes('data-variant="destructive"'));
});

test("signInPage renders a destructive alert for errors", () => {
  const html = signInPage("GitHub sign-in failed. Try again.");
  assert.ok(html.includes('class="alert" data-variant="destructive"'));
  assert.ok(html.includes("GitHub sign-in failed. Try again."));
  assert.ok(html.includes("lucide-circle-alert"), "uses the Lucide icon");
  assert.ok(html.includes('<svg aria-hidden="true"'));
});

test("signInPage escapes error text", () => {
  const html = signInPage("<script>alert(1)</script>");
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
});

test("signInPage threads callbackURL through the script safely", () => {
  const html = signInPage(
    null,
    "https://extensions.fossbilling.org/auth/callback"
  );
  assert.ok(
    html.includes('"https://extensions.fossbilling.org/auth/callback"')
  );
  const injected = signInPage(
    null,
    "https://x.example.com/</script><script>alert(1)</script>"
  );
  assert.ok(
    injected.includes("\\u003c/script>"),
    "escapes < in embedded script strings"
  );
  assert.ok(!injected.includes("alert(1)</script>"));
});

test("signInPage avoids the 200+Location download trap", () => {
  const html = signInPage(null, "/account");
  assert.ok(
    html.includes("disableRedirect: true"),
    "suppresses the non-standard Location header on the JSON body"
  );
});

test("signInPage sends only signed OAuth params", () => {
  const html = signInPage(null, "/account");
  assert.ok(
    html.includes("signedOAuthQuery"),
    "filters location.search to sig/ba_param like buildSignedOAuthQuery"
  );
  assert.ok(
    !html.includes("oauth_query: oauthQuery || undefined"),
    "never sends the raw query with unsigned params such as error"
  );
  assert.ok(
    html.includes("getAll('ba_param')"),
    "keeps exactly the server-signed parameter names"
  );
});

test("consentPage follows either redirect field", () => {
  const html = consentPage("c1", "openid");
  assert.ok(
    html.includes("data?.url || data?.redirect_uri"),
    "handles both the fetch JSON shape and the OpenAPI redirect_uri shape"
  );
});

test("page builders thread the nonce onto their inline scripts", () => {
  const nonce = "c3BpZHVrZW5vbmNl";
  for (const html of [
    signInPage(null, "/account", nonce),
    consentPage("c1", "openid", nonce),
    accountPage(fakeSession(), "/account", false, nonce)
  ]) {
    assert.ok(html.includes('<script nonce="c3BpZHVrZW5vbmNl">'));
  }
});

test("errorPage renders the OAuth error code and description", () => {
  const html = errorPage(
    "invalid_client",
    "client_id is required",
    "c3BpZHVrZW5vbmNl"
  );
  assert.ok(html.includes("<title>Authorization Error |"));
  assert.ok(html.includes('data-variant="destructive"'));
  assert.ok(html.includes("client_id is required"));
  assert.ok(html.includes(">invalid_client</code>"));
  assert.ok(html.includes('href="/sign-in"'), "offers a way back");
  assert.ok(html.includes('<script nonce="c3BpZHVrZW5vbmNl">'));
});

test("errorPage falls back when the params are missing", () => {
  const html = errorPage(null, null, "c3BpZHVrZW5vbmNl");
  assert.ok(html.includes("Unknown error"));
  assert.ok(html.includes(">unknown_error</code>"));
});

test("errorPage escapes attacker-controlled query params", () => {
  const html = errorPage(
    "<script>alert(1)</script>",
    `<img src=x onerror=alert(1)>`,
    "c3BpZHVrZW5vbmNl"
  );
  assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;"));
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;</code>"));
  assert.ok(!html.includes("<script>alert(1)</script>"));
});

test("consentPage escapes the client id and maps scopes to chips", () => {
  const html = consentPage("<evil>", "openid profile email github");
  assert.ok(html.includes("&lt;evil&gt;"));
  assert.ok(
    html.includes('<span class="badge" data-variant="secondary">OpenID</span>')
  );
  assert.ok(
    html.includes('<span class="badge" data-variant="secondary">Profile</span>')
  );
  assert.ok(html.includes(">GitHub<span"));
  assert.ok(
    html.includes('data-tooltip="Identity and organization memberships."')
  );
  assert.ok(
    html.includes('tabindex="0"'),
    "tooltip wrapper is keyboard-focusable"
  );
  assert.ok(
    html.includes('<span class="sr-only">: identity and organization memberships</span>'),
    "grant is announced to screen readers, not only via tooltip"
  );
  assert.ok(
    !html.includes('class="badge" data-variant="secondary" data-tooltip'),
    "tooltip sits on a wrapper: badge overflow would clip it"
  );
  assert.ok(!html.includes("openid, profile, email"));
  assert.ok(html.includes('id="accept-consent"'));
  assert.ok(html.includes('id="deny-consent"'));
});

test("consentPage falls back to default scopes", () => {
  const html = consentPage("c1", "");
  assert.ok(html.includes(">OpenID</span>"));
  assert.ok(html.includes(">Email</span>"));
});

test("consentPage escapes unknown scopes", () => {
  const html = consentPage("c1", "openid <evil>");
  assert.ok(html.includes("&lt;evil&gt;"));
});

test("accountPage shows the grant flow when orgs are stale", () => {
  const html = accountPage(fakeSession(), "/account", false);
  assert.ok(html.includes('class="card"'));
  assert.ok(
    html.includes(
      'Grant GitHub Access<span class="sr-only">: shares your GitHub organization memberships</span>'
    ),
    "grant disclosure is announced, not only tooltiped"
  );
  assert.ok(html.includes('id="link-github-orgs-error"'));
  assert.ok(html.includes('<div class="grid gap-2">'));
  assert.ok(
    html.includes(
      'data-tooltip="Shares your GitHub organization memberships."'
    ),
    "the grant justification lives on the button"
  );
});

test("accountPage shows continue and refresh for a fresh linking caller", () => {
  const html = accountPage(
    fakeSession(),
    "https://extensions.fossbilling.org/reconnect",
    true
  );
  assert.ok(
    html.includes(
      '<a href="https://extensions.fossbilling.org/reconnect" class="btn w-full">Continue</a>'
    ),
    "continue is the primary action"
  );
  assert.ok(html.includes("Refresh GitHub Access"));
  assert.ok(
    html.includes(
      'Refresh GitHub Access<span class="sr-only">: picks up access granted after sign-in</span>'
    ),
    "refresh helper is announced, not only tooltiped"
  );
  assert.ok(
    html.includes('data-variant="secondary" data-tooltip='),
    "refresh stays subordinate to continue"
  );
  assert.ok(
    html.includes('data-tooltip="Picks up access granted after sign-in."'),
    "the staleness note lives on the refresh button"
  );
});

test("accountPage shows neither button when fresh with no caller", () => {
  const html = accountPage(fakeSession(), "/account", true);
  assert.ok(!html.includes('id="link-github-orgs" type="button"'));
  assert.ok(html.includes('id="sign-out"'));
});

test("accountPage signs out with a JSON body", () => {
  // better-auth answers content-type-less POSTs with 415, leaving the
  // session alive so /sign-in bounces straight back to /account.
  const html = accountPage(fakeSession(), "/account", true);
  assert.ok(html.includes("fetch('/sign-out', {"));
  assert.ok(html.includes("'content-type': 'application/json'"));
  assert.ok(html.includes('body: "{}"'));
});

test("accountPage link-social avoids the 200+Location download trap", () => {
  const html = accountPage(
    fakeSession(),
    "https://extensions.fossbilling.org/reconnect",
    false
  );
  assert.ok(html.includes("fetch('/link-social'"));
  assert.ok(
    html.includes("disableRedirect: true"),
    "suppresses the non-standard Location header on the JSON body"
  );
});

test("accountPage renders the avatar with fallback initials", () => {
  const withImage = accountPage(
    fakeSession({ name: "Ada Lovelace", image: "https://example.com/a.png" }),
    "/account",
    true
  );
  assert.ok(withImage.includes('class="avatar me-3 self-center"'));
  assert.ok(withImage.includes('src="https://example.com/a.png"'));
  assert.ok(withImage.includes("<span>AD</span>"));

  const emailFallback = accountPage(
    fakeSession({ name: "", email: "ada@example.com" }),
    "/account",
    true
  );
  assert.ok(emailFallback.includes("ada@example.com"));

  const noImage = accountPage(
    fakeSession({ name: "Ada Lovelace", image: null }),
    "/account",
    true
  );
  assert.ok(
    noImage.includes(
      '<span class="avatar me-3 self-center" data-size="lg"><span>AD</span></span>'
    ),
    "falls back to initials with no image"
  );
  assert.ok(
    !noImage.match(/<img(?![^>]*logo-)/),
    "renders no avatar image without a user image"
  );
});

test("accountPage escapes user-controlled fields", () => {
  const html = accountPage(
    fakeSession({
      name: `<img src=x onerror=alert(1)>`,
      email: "a&b@example.com",
      id: `u_"quoted"`
    }),
    "/account",
    true
  );
  assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;"));
  assert.ok(html.includes("a&amp;b@example.com"));
  assert.ok(html.includes("u_&quot;quoted&quot;"));
});
