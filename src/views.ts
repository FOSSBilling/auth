import type { AppSession } from "./types";
import { CircleAlert } from "lucide-static";

type PageOptions = {
  title: string;
  body: string;
  script?: string;
  description?: string;
  nonce: string;
};

const DEFAULT_DESCRIPTION = "Central FOSSBilling account authentication.";

// Server-controlled values (client ids, callback URLs) get embedded directly
// into inline <script> blocks below. JSON.stringify alone doesn't escape
// "<", so a value containing "</script>" could break out of the tag —
// escape it to a JS string literal that's also safe as script content.
function jsString(value: string): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// Applies the stored theme (matching extensions' localStorage key) before
// first paint so dark-mode users don't flash the light theme, then keeps
// following the OS while no explicit choice is stored. An explicit stored
// choice always wins. Listens for the same `basecoat:theme` event extensions
// dispatches, so a future toggle here would stay in sync without further
// changes. Every path also syncs the theme-color meta: a media-based pair
// would follow the OS, not the stored choice.
// The meta tag below must precede the script so it exists when this runs.
const THEME_SCRIPT = `var tc=function(d){var m=document.querySelector('meta[name="theme-color"]');if(m)m.content=d?'#0a0a0a':'#fafaf9';};try{var s=localStorage.getItem('themeMode');var d=s?s==='dark':matchMedia('(prefers-color-scheme: dark)').matches;document.documentElement.classList.toggle('dark',d);tc(d);}catch(e){}try{var mq=matchMedia('(prefers-color-scheme: dark)');var sync=function(e){try{if(!localStorage.getItem('themeMode')){document.documentElement.classList.toggle('dark',e.matches);tc(e.matches);}}catch(_){}};if(mq.addEventListener)mq.addEventListener('change',sync);}catch(e){}document.addEventListener('basecoat:theme',function(e){var m=e.detail&&e.detail.mode;var d=m==='dark'?true:m==='light'?false:!document.documentElement.classList.contains('dark');document.documentElement.classList.toggle('dark',d);tc(d);try{localStorage.setItem('themeMode',d?'dark':'light');}catch(e){}});`;

// Lucide ships no brand logos, so the GitHub mark stays hand-maintained.
const GITHUB_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.55 0-.27-.01-1.17-.02-2.12-3.2.7-3.88-1.36-3.88-1.36-.52-1.33-1.28-1.68-1.28-1.68-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.19 1.76 1.19 1.03 1.76 2.7 1.25 3.36.96.1-.75.4-1.25.72-1.54-2.55-.29-5.23-1.28-5.23-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11.1 11.1 0 0 1 5.8 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.41-2.69 5.38-5.25 5.67.41.35.77 1.05.77 2.12 0 1.53-.01 2.76-.01 3.14 0 .3.2.67.8.55A11.51 11.51 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z"/></svg>`;

// Decorative inside alerts that already carry an <h2>, so mark it hidden.
const ERROR_ICON = CircleAlert.replace("<svg", '<svg aria-hidden="true"');

export function page({
  title,
  body,
  script,
  description,
  nonce
}: PageOptions): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)} | FOSSBilling Auth</title>
    <meta name="description" content="${escapeHtml(description ?? DEFAULT_DESCRIPTION)}" />
    <!-- Synced with the active theme by the init script below: a
         media-based pair would follow the OS, not the stored choice.
         Hex approximations of the --background token (warm paper light /
         near-black dark). Keep in sync with src/styles.css. -->
    <meta name="theme-color" content="#fafaf9" />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <script nonce="${escapeHtml(nonce)}">${THEME_SCRIPT}</script>
    <link rel="stylesheet" href="/styles.css" />
  </head>
  <body class="min-h-screen grid place-items-center bg-background bg-linear-to-b from-background to-muted text-foreground p-4">
    <main class="w-full max-w-sm grid gap-6 justify-items-center">
      <div class="flex items-center">
        <img src="/logo-light.svg" alt="FOSSBilling" class="h-8 w-auto dark:hidden" />
        <img src="/logo-dark.svg" alt="" aria-hidden="true" class="h-8 w-auto hidden dark:block" />
        <span class="ml-3 pl-3 border-s dark:border-white/20 text-sm font-semibold uppercase tracking-wider">Account</span>
        <span class="ml-2 badge" data-variant="secondary">beta</span>
      </div>
      <div class="w-full">${body}</div>
      <p class="text-sm text-muted-foreground">&copy; 2026 &mdash; The FOSSBilling project.</p>
    </main>
    ${script ? `<script nonce="${escapeHtml(nonce)}">(function () {${script}})();</script>` : ""}
  </body>
</html>`;
}

export function signInPage(
  error?: string | null,
  callbackURL = "/account",
  nonce = ""
): string {
  // Preserved across the error-retry and no-op fallback redirects below too,
  // so a caller's callbackURL (e.g. extensions' reconnect flow, threaded
  // through here when /account bounces an expired session to /sign-in)
  // survives a failed or retried sign-in attempt.
  const errorRedirect =
    callbackURL === "/account"
      ? "/sign-in?error=github"
      : `/sign-in?error=github&callbackURL=${encodeURIComponent(callbackURL)}`;

  return page({
    title: "Sign In",
    body: `
      <div class="card">
        <header>
          <h2>Sign In to FOSSBilling</h2>
          <p>Use your GitHub account to continue.</p>
        </header>
        <section class="grid gap-4">
          ${error ? `<div class="alert" data-variant="destructive">${ERROR_ICON}<h2>Sign-In Failed</h2><section>${escapeHtml(error)}</section></div>` : ""}
          <button id="github-sign-in" type="button" class="btn w-full">${GITHUB_ICON}Continue with GitHub</button>
        </section>
      </div>
    `,
    script: `
      const button = document.getElementById('github-sign-in');
      if (!button) return;
      button.addEventListener('click', async () => {
        button.disabled = true;
        const oauthQuery = window.location.search.slice(1);
        const response = await fetch('/sign-in/social', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            provider: 'github',
            callbackURL: ${jsString(callbackURL)},
            errorCallbackURL: ${jsString(errorRedirect)},
            oauth_query: oauthQuery || undefined
          })
        });
        const data = await response.json().catch(() => null);
        if (data?.url) {
          window.location.href = data.url;
          return;
        }
        button.disabled = false;
        window.location.href = ${jsString(errorRedirect)};
      });
    `,
    nonce
  });
}

export function consentPage(
  clientId: string,
  scope: string,
  nonce = ""
): string {
  // Short chip labels per scope; the github grant's wider meaning survives
  // as a tooltip since badge text truncates past ~20rem.
  const scopeChip = (requestedScope: string): string => {
    switch (requestedScope) {
      case "openid":
        return `<span class="badge" data-variant="secondary">OpenID</span>`;
      case "github":
        // The tooltip lives on a wrapper: .badge sets overflow:hidden,
        // which would clip the tooltip's positioned ::before. The wrapper
        // is focusable so keyboard users get the tooltip via Basecoat's
        // :focus-visible rule, and the sr-only text announces the grant
        // to screen readers regardless of tooltip support.
        return `<span data-tooltip="${escapeHtml("Identity and organization memberships.")}" data-side="bottom" tabindex="0"><span class="badge" data-variant="secondary">GitHub<span class="sr-only">: identity and organization memberships</span></span></span>`;
      case "profile":
        return `<span class="badge" data-variant="secondary">Profile</span>`;
      case "email":
        return `<span class="badge" data-variant="secondary">Email</span>`;
      case "offline_access":
        return `<span class="badge" data-variant="secondary">Offline Access</span>`;
      default:
        return `<span class="badge" data-variant="secondary">${escapeHtml(requestedScope)}</span>`;
    }
  };
  const requestedScopes = (scope.trim() || "openid profile email")
    .split(/\s+/)
    .map(scopeChip)
    .join("");

  return page({
    title: "Authorize Application",
    body: `
      <div class="card">
        <header>
          <h2>Authorize Application</h2>
          <p>An application (<code class="bg-muted rounded px-1.5 py-0.5 text-sm font-mono">${escapeHtml(clientId)}</code>) is requesting access to your FOSSBilling account.</p>
        </header>
        <section class="grid gap-2">
          <p class="label text-sm font-medium">Requested Scopes</p>
          <div class="flex flex-wrap gap-1.5">${requestedScopes}</div>
        </section>
        <footer class="flex-col gap-2">
          <button id="accept-consent" type="button" class="btn w-full">Authorize</button>
          <button id="deny-consent" type="button" class="btn w-full" data-variant="outline">Deny</button>
        </footer>
      </div>
    `,
    script: `
      async function submitConsent(accept) {
        const response = await fetch('/oauth2/consent', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ accept, oauth_query: window.location.search.slice(1) })
        });
        const data = await response.json().catch(() => null);
        if (data?.url) {
          window.location.href = data.url;
          return;
        }
        window.location.href = accept ? '/account' : '/sign-in';
      }
      document.getElementById('accept-consent')?.addEventListener('click', () => submitConsent(true));
      document.getElementById('deny-consent')?.addEventListener('click', () => submitConsent(false));
    `,
    nonce
  });
}

// Landing page for authorization failures that must not redirect to the
// client (unknown client_id, invalid redirect_uri) — better-auth's
// oauthProvider sends `error` and `error_description` query params here.
export function errorPage(
  error?: string | null,
  description?: string | null,
  nonce = ""
): string {
  return page({
    title: "Authorization Error",
    body: `
      <div class="card">
        <header>
          <h2>Authorization Failed</h2>
          <p>The sign-in request could not be completed.</p>
        </header>
        <section class="grid gap-4">
          <div class="alert" data-variant="destructive">${ERROR_ICON}<h2>Authorization Error</h2><section>${escapeHtml(description || error || "Unknown error")}</section></div>
          <p class="text-sm text-muted-foreground">Error code: <code class="bg-muted rounded px-1.5 py-0.5 text-sm font-mono">${escapeHtml(error || "unknown_error")}</code></p>
        </section>
        <footer class="flex-col gap-2">
          <a href="/sign-in" class="btn w-full">Back to Sign In</a>
        </footer>
      </div>
    `,
    nonce
  });
}

export function accountPage(
  session: AppSession,
  callbackURL = "/account",
  githubOrgsFresh = false,
  nonce = ""
): string {
  const fallbackInitials = (session.user.name || session.user.email || "?")
    .trim()
    .slice(0, 2)
    .toUpperCase();
  // Side-by-side identity row. Everything stays a direct header child
  // because its h2/p typography selectors only match those. Spacing uses
  // margin (not gap), columns apply uncontested (no card-action here), and
  // the name needs text-xl! — the header's own rules outrank utilities.
  const avatarImage = session.user.image
    ? `<img src="${escapeHtml(session.user.image)}" alt="" />`
    : "";
  const avatar = `<span class="avatar me-3 self-center" data-size="lg">${avatarImage}<span>${escapeHtml(fallbackInitials)}</span></span>`;

  // Freshness alone must not hide the reconnect flow: a fresh-but-empty
  // snapshot (granted after the last sign-in, or an org the OAuth App
  // was never granted) still blocks org profile creation with
  // GITHUB_MISMATCH, and plain re-login never re-fetches. When a linking
  // caller is present, always offer an explicit refresh alongside the
  // continue path so a specific missing org can be granted on GitHub.
  // Wrapped in its own grid so the helper text, buttons and error stack at
  // the same 8px rhythm as the card footer, while the section keeps 16px
  // between its blocks.
  // Tooltip text is CSS-only and never announced, so each tooltip-bearing
  // button mirrors it in sr-only text for screen readers. Buttons are
  // natively focusable, which already exposes the tooltip to keyboard
  // users via Basecoat's :focus-visible rule.
  const orgsBlock = !githubOrgsFresh
    ? `<div class="grid gap-2">
         <button id="link-github-orgs" type="button" class="btn w-full" data-tooltip="${escapeHtml("Shares your GitHub organization memberships.")}" data-side="bottom">Grant GitHub Access<span class="sr-only">: shares your GitHub organization memberships</span></button>
         <div class="alert" data-variant="destructive" id="link-github-orgs-error" hidden>${ERROR_ICON}<h2>GitHub Linking Failed</h2><section></section></div>
       </div>`
    : callbackURL !== "/account"
      ? `<div class="grid gap-2">
           <a href="${escapeHtml(callbackURL)}" class="btn w-full">Continue</a>
           <button id="link-github-orgs" type="button" class="btn w-full" data-variant="secondary" data-tooltip="${escapeHtml("Picks up access granted after sign-in.")}" data-side="bottom">Refresh GitHub Access<span class="sr-only">: picks up access granted after sign-in</span></button>
           <div class="alert" data-variant="destructive" id="link-github-orgs-error" hidden>${ERROR_ICON}<h2>GitHub Linking Failed</h2><section></section></div>
         </div>`
      : "";

  return page({
    title: "Account",
    body: `
      <div class="card">
        <header class="grid-cols-[auto_1fr]">
          ${avatar}
          <h2 class="self-center text-xl!">${escapeHtml(session.user.name || session.user.email)}</h2>
        </header>
        <section class="grid gap-4">
          <div class="grid gap-2">
            <p class="label text-sm font-medium">User ID</p>
            <p class="text-sm break-all">${escapeHtml(session.user.id)}</p>
            <p class="label text-sm font-medium">Email</p>
            <p class="text-sm break-all">${escapeHtml(session.user.email)}</p>
          </div>
          ${orgsBlock}
        </section>
        <footer class="flex-col gap-2">
          <button id="sign-out" type="button" class="btn w-full" data-variant="outline">Sign Out</button>
        </footer>
      </div>
    `,
    script: `
      document.getElementById('link-github-orgs')?.addEventListener('click', async (e) => {
        const button = e.currentTarget;
        const errorEl = document.getElementById('link-github-orgs-error');
        const errorSection = errorEl?.querySelector('section');
        button.disabled = true;
        if (errorEl) errorEl.hidden = true;
        try {
          const response = await fetch('/link-social', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ provider: 'github', callbackURL: ${jsString(callbackURL)} })
          });
          const data = await response.json().catch(() => null);
          if (data?.url) {
            window.location.href = data.url;
            return;
          }
          if (errorEl) {
            if (errorSection) errorSection.textContent = data?.message || 'Unable to start GitHub linking. Try again.';
            errorEl.hidden = false;
          }
        } catch {
          if (errorEl) {
            if (errorSection) errorSection.textContent = 'Unable to start GitHub linking. Try again.';
            errorEl.hidden = false;
          }
        }
        button.disabled = false;
      });
      document.getElementById('sign-out')?.addEventListener('click', async () => {
        // better-auth rejects content-type-less POSTs with 415, which would
        // leave the session intact and bounce /sign-in straight back here.
        await fetch('/sign-out', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: "{}"
        });
        window.location.href = '/sign-in';
      });
    `,
    nonce
  });
}
