// Multi-tenant QBO REST client. Every call takes a client slug, looks up that
// client's tokens, refreshes if needed, and hits QBO for the matching realmId.
//
// READ-ONLY: this build of the MCP intentionally exposes only GET endpoints.
// No createEntity / updateEntity helpers are exported.

import OAuthClient from "intuit-oauth";
import "dotenv/config";
import { loadTokens, saveTokens, StoredTokens } from "./tokens.js";

const ENV = (process.env.QBO_ENVIRONMENT || "production") as "sandbox" | "production";
const BASE =
  ENV === "production"
    ? "https://quickbooks.api.intuit.com"
    : "https://sandbox-quickbooks.api.intuit.com";

let oauthClient: OAuthClient | null = null;
export function getOAuthClient(): OAuthClient {
  if (oauthClient) return oauthClient;
  const clientId = process.env.QBO_CLIENT_ID;
  const clientSecret = process.env.QBO_CLIENT_SECRET;
  const redirectUri = process.env.QBO_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error(
      "QBO_CLIENT_ID, QBO_CLIENT_SECRET, and QBO_REDIRECT_URI must all be set."
    );
  }
  oauthClient = new OAuthClient({
    clientId,
    clientSecret,
    environment: ENV,
    redirectUri,
  });
  return oauthClient;
}

async function ensureFreshToken(slug: string): Promise<StoredTokens> {
  let tokens = loadTokens(slug);
  if (Date.now() > tokens.expires_at - 60_000) {
    const client = getOAuthClient();
    const res = await client.refreshUsingToken(tokens.refresh_token);
    const json = res.getJson() as any;
    tokens = {
      ...tokens,
      access_token: json.access_token,
      refresh_token: json.refresh_token,
      expires_at: Date.now() + json.expires_in * 1000,
      x_refresh_token_expires_at: Date.now() + json.x_refresh_token_expires_in * 1000,
    };
    saveTokens(slug, tokens);
  }
  return tokens;
}

async function qboFetch(
  slug: string,
  urlPath: string
): Promise<any> {
  const tokens = await ensureFreshToken(slug);
  const url = `${BASE}/v3/company/${tokens.realmId}${urlPath}`;
  const res = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${tokens.access_token}`,
      Accept: "application/json",
    },
  });
  const text = await res.text();
  // Capture Intuit's transaction ID for support tickets. Intuit support will
  // ask for this any time you open a case — always include it in errors.
  const intuitTid = res.headers.get("intuit_tid") || "-";
  console.error(
    `qbo [${slug}] GET ${urlPath} → ${res.status} intuit_tid=${intuitTid}`
  );
  if (!res.ok) {
    throw new Error(
      `QBO [${slug}] GET ${urlPath} → ${res.status} (intuit_tid=${intuitTid}): ${text}`
    );
  }
  return text ? JSON.parse(text) : null;
}

// --- Public surface (read-only) ---

export async function query(slug: string, qboQL: string): Promise<any> {
  const encoded = encodeURIComponent(qboQL);
  const j = await qboFetch(slug, `/query?query=${encoded}&minorversion=70`);
  return j?.QueryResponse ?? {};
}

export async function getEntity(slug: string, entity: string, id: string): Promise<any> {
  const j = await qboFetch(slug, `/${entity.toLowerCase()}/${id}?minorversion=70`);
  return j?.[entity] ?? j;
}

export async function runReport(
  slug: string,
  reportName: string,
  params: Record<string, string | number | boolean | undefined> = {}
): Promise<any> {
  const qs = new URLSearchParams({ minorversion: "70" });
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
  }
  return qboFetch(slug, `/reports/${reportName}?${qs.toString()}`);
}
