import type { AppSession } from "./types";

type PageOptions = {
  title: string;
  body: string;
  script?: string;
};

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

export function page({ title, body, script }: PageOptions): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)} | FOSSBilling Auth</title>
    <style>
      :root {
        color-scheme: light dark;
        --bg: #f7f8fa;
        --surface: #ffffff;
        --text: #1f2937;
        --muted: #5f6b7a;
        --border: #d7dde5;
        --accent: #2563eb;
        --accent-text: #ffffff;
        --danger: #b42318;
      }
      @media (prefers-color-scheme: dark) {
        :root {
          --bg: #111318;
          --surface: #181b22;
          --text: #eef2f6;
          --muted: #a5afbd;
          --border: #303846;
          --accent: #5b8def;
          --accent-text: #08111f;
        }
      }
      * { box-sizing: border-box; }
      body {
        min-height: 100vh;
        margin: 0;
        display: grid;
        place-items: center;
        background: var(--bg);
        color: var(--text);
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        line-height: 1.5;
      }
      main {
        width: min(100% - 32px, 440px);
        padding: 28px;
        border: 1px solid var(--border);
        border-radius: 8px;
        background: var(--surface);
      }
      h1 { margin: 0 0 8px; font-size: 1.35rem; line-height: 1.2; }
      p { margin: 0 0 18px; color: var(--muted); }
      dl { margin: 18px 0; }
      dt { color: var(--muted); font-size: 0.875rem; }
      dd { margin: 0 0 12px; overflow-wrap: anywhere; }
      button, .button {
        width: 100%;
        min-height: 44px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        border: 1px solid transparent;
        border-radius: 6px;
        background: var(--accent);
        color: var(--accent-text);
        cursor: pointer;
        font: inherit;
        font-weight: 600;
        text-decoration: none;
      }
      button + button, button + .button, .button + button, .button + .button {
        margin-top: 10px;
      }
      button.secondary {
        background: transparent;
        color: var(--text);
        border-color: var(--border);
      }
      .error { color: var(--danger); }
      .avatar {
        width: 56px;
        height: 56px;
        border-radius: 50%;
        object-fit: cover;
        border: 1px solid var(--border);
        margin-bottom: 16px;
      }
    </style>
  </head>
  <body>
    <main>${body}</main>
    ${script ? `<script>(function () {${script}})();</script>` : ""}
  </body>
</html>`;
}

export function signInPage(
  error?: string | null,
  callbackURL = "/account"
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
    title: "Sign in",
    body: `
      <h1>Sign in to FOSSBilling</h1>
      <p>Use your GitHub account to continue.</p>
      ${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
      <button id="github-sign-in" type="button">Continue with GitHub</button>
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
    `
  });
}

export function consentPage(clientId: string, scope: string): string {
  return page({
    title: "Authorize application",
    body: `
      <h1>Authorize application</h1>
      <p>An application (<code>${escapeHtml(clientId)}</code>) is requesting access to your FOSSBilling account.</p>
      <dl>
        <dt>Requested scopes</dt>
        <dd>${escapeHtml(scope || "openid profile email")}</dd>
      </dl>
      <button id="accept-consent" type="button">Authorize</button>
      <button class="secondary" id="deny-consent" type="button">Deny</button>
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
    `
  });
}

export function accountPage(
  session: AppSession,
  callbackURL = "/account"
): string {
  const image = session.user.image
    ? `<img class="avatar" src="${escapeHtml(session.user.image)}" alt="" />`
    : "";

  return page({
    title: "Account",
    body: `
      ${image}
      <h1>${escapeHtml(session.user.name || session.user.email)}</h1>
      <p>This is your central FOSSBilling account.</p>
      <dl>
        <dt>User ID</dt>
        <dd>${escapeHtml(session.user.id)}</dd>
        <dt>Email</dt>
        <dd>${escapeHtml(session.user.email)}</dd>
      </dl>
      ${
        session.user.githubLogin
          ? ""
          : `<p>Grant access to your GitHub organizations so extension developer
             profile claims can be verified automatically.</p>
             <button id="link-github-orgs" type="button">Grant GitHub org access</button>
             <p class="error" id="link-github-orgs-error" hidden></p>`
      }
      <button id="sign-out" type="button">Sign out</button>
    `,
    script: `
      document.getElementById('link-github-orgs')?.addEventListener('click', async (e) => {
        const button = e.currentTarget;
        const errorEl = document.getElementById('link-github-orgs-error');
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
            errorEl.textContent = data?.message || 'Unable to start GitHub linking. Try again.';
            errorEl.hidden = false;
          }
        } catch {
          if (errorEl) {
            errorEl.textContent = 'Unable to start GitHub linking. Try again.';
            errorEl.hidden = false;
          }
        }
        button.disabled = false;
      });
      document.getElementById('sign-out')?.addEventListener('click', async () => {
        await fetch('/sign-out', { method: 'POST' });
        window.location.href = '/sign-in';
      });
    `
  });
}
