import assert from "node:assert/strict";
import { test } from "node:test";
import type { AppSession } from "../src/types.ts";
import {
  accountPage,
  consentPage,
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
  const html = page({ title: "Sign In", body: "<p>hi</p>" });
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
  assert.ok(html.includes("themeMode"), "includes the theme init script");
  assert.ok(html.includes("max-w-sm"), "constrains the card width");
  assert.ok(html.includes("bg-linear-to-b"), "renders the backdrop gradient");
  assert.ok(!html.includes("(function () {"), "omits page script when absent");
});

test("page escapes title and description", () => {
  const html = page({
    title: `A&B <"test">`,
    body: "",
    description: `Desc <"quoted">`
  });
  assert.ok(html.includes("<title>A&amp;B &lt;&quot;test&quot;&gt;"));
  assert.ok(html.includes('content="Desc &lt;&quot;quoted&quot;&gt;"'));
});

test("page includes the page script when provided", () => {
  const html = page({ title: "T", body: "", script: "window.x = 1;" });
  assert.ok(html.includes("<script>(function () {window.x = 1;})();</script>"));
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

test("consentPage escapes the client id and maps the github scope", () => {
  const html = consentPage("<evil>", "openid profile email github");
  assert.ok(html.includes("&lt;evil&gt;"));
  assert.ok(
    html.includes("Linked GitHub identity and organization memberships")
  );
  assert.ok(html.includes('id="accept-consent"'));
  assert.ok(html.includes('id="deny-consent"'));
  assert.ok(html.includes('data-variant="outline"'));
});

test("consentPage falls back to default scopes", () => {
  assert.ok(consentPage("c1", "").includes("openid, profile, email"));
});

test("accountPage shows the grant flow when orgs are stale", () => {
  const html = accountPage(fakeSession(), "/account", false);
  assert.ok(html.includes('class="card"'));
  assert.ok(html.includes("Grant GitHub Access"));
  assert.ok(html.includes('id="link-github-orgs-error"'));
  assert.ok(html.includes('<div class="grid gap-2">'));
});

test("accountPage keeps an even label rhythm without margin hacks", () => {
  const html = accountPage(fakeSession(), "/account", true);
  assert.ok(!html.includes("mt-2"), "spacing comes from grid gaps alone");
  assert.ok(
    html.includes('<p class="label text-sm font-medium">User ID</p>'),
    "labels use the label component, not muted text"
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
    html.includes('data-variant="secondary" data-tooltip='),
    "refresh stays subordinate to continue"
  );
  assert.ok(
    html.includes('data-tooltip="Picks up access granted after sign-in."'),
    "the staleness note lives on the refresh button"
  );
  assert.ok(!html.includes("looks current"), "no standalone helper paragraph");
});

test("accountPage shows neither button when fresh with no caller", () => {
  const html = accountPage(fakeSession(), "/account", true);
  assert.ok(!html.includes('id="link-github-orgs" type="button"'));
  assert.ok(html.includes('id="sign-out"'));
  assert.ok(
    html.includes(
      'id="sign-out" type="button" class="btn w-full" data-variant="outline"'
    ),
    "sign out keeps a button affordance without going primary"
  );
});

test("accountPage signs out with a JSON body", () => {
  // better-auth answers content-type-less POSTs with 415, leaving the
  // session alive so /sign-in bounces straight back to /account.
  const html = accountPage(fakeSession(), "/account", true);
  assert.ok(html.includes("fetch('/sign-out', {"));
  assert.ok(html.includes("'content-type': 'application/json'"));
  assert.ok(html.includes('body: "{}"'));
});

test("accountPage renders the avatar with fallback initials", () => {
  const withImage = accountPage(
    fakeSession({ name: "Ada Lovelace", image: "https://example.com/a.png" }),
    "/account",
    true
  );
  assert.ok(withImage.includes('class="avatar me-3 self-center"'));
  assert.ok(
    withImage.includes('<header class="grid-cols-[auto_1fr]">'),
    "lays the avatar beside the name"
  );
  assert.ok(
    withImage.includes('<h2 class="self-center text-xl!">'),
    "centers and enlarges the name"
  );
  assert.ok(withImage.includes('src="https://example.com/a.png"'));
  assert.ok(withImage.includes("<span>AD</span>"));

  const emailFallback = accountPage(
    fakeSession({ name: "", email: "ada@example.com" }),
    "/account",
    true
  );
  assert.ok(emailFallback.includes("ada@example.com"));

  const noImage = accountPage(fakeSession(), "/account", true);
  assert.ok(!noImage.includes('class="avatar"'));
  assert.ok(
    !noImage.includes("grid-cols-"),
    "stacks the heading normally with no avatar"
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
