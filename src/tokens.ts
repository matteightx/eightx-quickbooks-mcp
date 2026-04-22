// Per-client token storage.
//
// Tokens live in QBO_TOKENS_DIR (default ./tokens), one file per client slug:
//   ./tokens/acme.json
//   ./tokens/example-co.json
//
// On Railway, mount a persistent volume at QBO_TOKENS_DIR so refresh-token
// rotation survives redeploys.

import fs from "node:fs";
import path from "node:path";

export interface StoredTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  x_refresh_token_expires_at: number;
  realmId: string;
  companyName?: string;       // human-readable, captured on first auth
  authorizedAt: number;
}

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function assertSlug(slug: string): void {
  if (!SLUG_RE.test(slug)) {
    throw new Error(
      `Invalid client slug "${slug}". Must be lowercase alphanumeric with _ or -, max 64 chars.`
    );
  }
}

export function tokensDir(): string {
  return path.resolve(process.env.QBO_TOKENS_DIR || "./tokens");
}

// Signals whether the tokens directory is on persistent storage. On Railway,
// anything outside a mounted volume is wiped on every redeploy, which silently
// kills all client authorizations. We surface this at startup and on the home
// page so it's impossible to miss.
//
// Heuristic: `QBO_TOKENS_DIR` must be set to an absolute path that isn't inside
// the working directory. Railway's convention is to mount a volume at `/data`
// and point `QBO_TOKENS_DIR=/data/tokens`, which passes both checks.
export function tokensPersistenceStatus(): {
  persistent: boolean;
  reason: string;
  dir: string;
} {
  const raw = process.env.QBO_TOKENS_DIR;
  const dir = tokensDir();
  if (!raw) {
    return {
      persistent: false,
      dir,
      reason:
        "QBO_TOKENS_DIR is unset — tokens are being written under the working directory and will be WIPED on the next redeploy. Mount a Railway volume at /data and set QBO_TOKENS_DIR=/data/tokens.",
    };
  }
  if (!path.isAbsolute(raw)) {
    return {
      persistent: false,
      dir,
      reason: `QBO_TOKENS_DIR="${raw}" is a relative path. Use an absolute path on a mounted volume (e.g. /data/tokens).`,
    };
  }
  const cwd = path.resolve(process.cwd());
  if (dir === cwd || dir.startsWith(cwd + path.sep)) {
    return {
      persistent: false,
      dir,
      reason: `QBO_TOKENS_DIR="${dir}" is inside the working directory, which is ephemeral on Railway. Point it at a mounted volume (e.g. /data/tokens).`,
    };
  }
  return { persistent: true, dir, reason: "" };
}

function tokenFile(slug: string): string {
  assertSlug(slug);
  return path.join(tokensDir(), `${slug}.json`);
}

export function listClients(): { slug: string; companyName?: string; authorizedAt: number; realmId: string }[] {
  const dir = tokensDir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const slug = f.replace(/\.json$/, "");
      try {
        const t = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as StoredTokens;
        return {
          slug,
          companyName: t.companyName,
          authorizedAt: t.authorizedAt,
          realmId: t.realmId,
        };
      } catch {
        return { slug, authorizedAt: 0, realmId: "" };
      }
    });
}

export function loadTokens(slug: string): StoredTokens {
  const p = tokenFile(slug);
  if (!fs.existsSync(p)) {
    throw new Error(
      `No tokens for client "${slug}". Visit the home page and authorize this client first.`
    );
  }
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

export function saveTokens(slug: string, t: StoredTokens): void {
  const dir = tokensDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(tokenFile(slug), JSON.stringify(t, null, 2));
}

export function hasClient(slug: string): boolean {
  try {
    return fs.existsSync(tokenFile(slug));
  } catch {
    return false;
  }
}
