// Hosted OAuth flow.
//
//   GET  /                     → HTML home page: list authorized clients +
//                                  form to authorize a new client by slug.
//   GET  /oauth/start?client=  → redirect to Intuit's authorize URL.
//   GET  /oauth/callback       → exchange code, save tokens under that slug.
//
// State handling: an in-memory map of {state → slug}. Server restart wipes
// pending flows, which is fine — just click the link again.

import type { IncomingMessage, ServerResponse } from "node:http";
import crypto from "node:crypto";
import OAuthClient from "intuit-oauth";
import { getOAuthClient } from "./qbo.js";
import { assertSlug, listClients, saveTokens, tokensPersistenceStatus } from "./tokens.js";

const pending = new Map<string, { slug: string; createdAt: number }>();
const PENDING_TTL_MS = 15 * 60 * 1000;

function gcPending() {
  const now = Date.now();
  for (const [k, v] of pending) if (now - v.createdAt > PENDING_TTL_MS) pending.delete(k);
}

function html(body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>QuickBooks MCP — by 8x</title>
<style>
body{font-family:ui-sans-serif,system-ui,sans-serif;max-width:720px;margin:40px auto;padding:0 20px;color:#1a1a1a}
h1{margin-bottom:4px}
code,input{font-family:ui-monospace,monospace;background:#f4f4f5;padding:2px 6px;border-radius:4px}
table{width:100%;border-collapse:collapse;margin:16px 0}
td,th{text-align:left;padding:8px;border-bottom:1px solid #e5e5e5}
form{margin-top:24px;padding:16px;background:#f9f9fb;border-radius:8px}
input[type=text]{border:1px solid #d4d4d8;padding:8px;border-radius:4px;width:220px}
button{background:#0f172a;color:white;border:0;padding:9px 14px;border-radius:4px;cursor:pointer;font-weight:600}
button:hover{background:#1e293b}
.muted{color:#71717a;font-size:14px}
a.btn{display:inline-block;background:#2563eb;color:white;text-decoration:none;padding:6px 12px;border-radius:4px;font-size:13px}
.warn{background:#fef2f2;border:1px solid #fecaca;color:#991b1b;padding:12px 16px;border-radius:8px;margin:16px 0}
.warn strong{display:block;margin-bottom:4px}
.brand{background:#f0f9ff;border:1px solid #bae6fd;padding:12px 16px;border-radius:8px;margin-top:24px}
.brand a{color:#0369a1;font-weight:600}
</style></head><body>${body}</body></html>`;
}

function renderHome(): string {
  const clients = listClients();
  const rows =
    clients.length === 0
      ? `<tr><td colspan="5" class="muted">No clients authorized yet. Use the form below to add one.</td></tr>`
      : clients
          .map(
            (c) => `<tr>
  <td><code>${c.slug}</code></td>
  <td>${c.companyName || "<span class='muted'>—</span>"}</td>
  <td><span class="muted">${c.realmId}</span></td>
  <td><span class="muted">${c.authorizedAt ? new Date(c.authorizedAt).toISOString().slice(0, 10) : "—"}</span></td>
  <td><a class="btn" href="/oauth/start?client=${encodeURIComponent(c.slug)}">Re-auth</a></td>
</tr>`
          )
          .join("");
  const ps = tokensPersistenceStatus();
  const warnBanner = ps.persistent
    ? ""
    : `<div class="warn"><strong>⚠ Tokens directory is NOT persistent</strong>${ps.reason.replace(/</g, "&lt;")}<br><br>Current dir: <code>${ps.dir}</code></div>`;
  return html(`
<h1>QuickBooks MCP</h1>
<p class="muted">Read-only multi-tenant QuickBooks Online MCP server. Authorize a client below, then reference it by its <code>slug</code> from any MCP client.</p>
${warnBanner}
<h2>Authorized clients</h2>
<table><thead><tr><th>Slug</th><th>Company</th><th>Realm</th><th>Authorized</th><th></th></tr></thead><tbody>${rows}</tbody></table>
<form action="/oauth/start" method="get">
<h2>Authorize a new client</h2>
<p class="muted">Pick a short slug (lowercase, e.g. <code>acme</code>). You'll be sent to Intuit to sign in and pick the company. Make sure your Intuit user has firm or direct access to that company first.</p>
<input type="text" name="client" placeholder="acme" required pattern="[a-z0-9][a-z0-9_-]{0,63}" />
<button type="submit">Authorize →</button>
</form>
<p class="muted" style="margin-top:32px">Intuit environment: <code>${process.env.QBO_ENVIRONMENT || "production"}</code> · Redirect URI: <code>${process.env.QBO_REDIRECT_URI || "(unset)"}</code> · Tokens dir: <code>${ps.dir}</code> ${ps.persistent ? "" : "<strong style='color:#991b1b'>(EPHEMERAL)</strong>"}</p>
<div class="brand">
  <strong>Built by 8x.</strong> We help operators and accounting firms automate finance ops with AI agents.<br>
  Need help deploying this, customizing it, or building an AI CFO on top of QuickBooks?<br>
  <a href="https://eightx.co">eightx.co</a> · <a href="https://calendly.com/d/csm9-53t-pg6/diagnostic-strategy-call">Book a free diagnostic call →</a>
</div>
`);
}

function send(res: ServerResponse, status: number, body: string, contentType = "text/html; charset=utf-8") {
  res.writeHead(status, { "Content-Type": contentType });
  res.end(body);
}

export async function handleOauthRequest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    send(res, 200, renderHome());
    return true;
  }

  if (req.method === "GET" && url.pathname === "/oauth/start") {
    const slug = (url.searchParams.get("client") || "").trim().toLowerCase();
    try {
      assertSlug(slug);
    } catch (e: any) {
      send(res, 400, html(`<h1>Invalid slug</h1><p>${e.message}</p><p><a href="/">← back</a></p>`));
      return true;
    }
    gcPending();
    const state = crypto.randomBytes(16).toString("hex");
    pending.set(state, { slug, createdAt: Date.now() });
    const client = getOAuthClient();
    const authUri = client.authorizeUri({
      scope: [OAuthClient.scopes.Accounting],
      state,
    });
    res.writeHead(302, { Location: authUri });
    res.end();
    return true;
  }

  if (req.method === "GET" && url.pathname === "/oauth/callback") {
    const state = url.searchParams.get("state") || "";
    const entry = pending.get(state);
    if (!entry) {
      send(res, 400, html(`<h1>Authorization expired</h1><p>Start over from <a href="/">the home page</a>.</p>`));
      return true;
    }
    pending.delete(state);

    try {
      const client = getOAuthClient();
      const fullUrl = `${process.env.QBO_REDIRECT_URI}?${url.searchParams.toString()}`;
      const tokenRes = await client.createToken(fullUrl);
      const json = tokenRes.getJson() as any;
      const realmId =
        (tokenRes as any).token?.realmId ||
        (tokenRes as any).realmId ||
        url.searchParams.get("realmId");
      if (!realmId) throw new Error("No realmId returned from Intuit — make sure you selected a company in the picker.");

      // Best-effort fetch of the company name for the home page UI.
      let companyName: string | undefined;
      try {
        const infoRes = await fetch(
          `${
            (process.env.QBO_ENVIRONMENT || "production") === "production"
              ? "https://quickbooks.api.intuit.com"
              : "https://sandbox-quickbooks.api.intuit.com"
          }/v3/company/${realmId}/companyinfo/${realmId}?minorversion=70`,
          { headers: { Authorization: `Bearer ${json.access_token}`, Accept: "application/json" } }
        );
        if (infoRes.ok) {
          const info = (await infoRes.json()) as any;
          companyName = info?.CompanyInfo?.CompanyName;
        }
      } catch {
        /* ignore */
      }

      saveTokens(entry.slug, {
        access_token: json.access_token,
        refresh_token: json.refresh_token,
        expires_at: Date.now() + json.expires_in * 1000,
        x_refresh_token_expires_at: Date.now() + json.x_refresh_token_expires_in * 1000,
        realmId: String(realmId),
        companyName,
        authorizedAt: Date.now(),
      });

      send(
        res,
        200,
        html(`
<h1>✓ Authorized</h1>
<p>Client <code>${entry.slug}</code>${companyName ? ` (${companyName})` : ""} is now connected.</p>
<p>You can use it from any MCP client by passing <code>client: "${entry.slug}"</code> to any tool.</p>
<p><a href="/">← back to home</a></p>`)
      );
    } catch (e: any) {
      send(
        res,
        500,
        html(`<h1>Authorization failed</h1><pre>${(e.message || String(e)).replace(/</g, "&lt;")}</pre><p><a href="/">← back</a></p>`)
      );
    }
    return true;
  }

  if (req.method === "GET" && url.pathname === "/healthz") {
    send(res, 200, "ok", "text/plain");
    return true;
  }

  return false; // not handled
}
