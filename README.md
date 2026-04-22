# eightx-quickbooks-mcp

> A **read-only**, multi-tenant Model Context Protocol (MCP) server for QuickBooks Online — built so an AI agent (Claude, GPT, etc.) can pull live financials, run reports, and reason over the books without ever being able to write or change anything.

Built and maintained by **[8x](https://eightx.co)**. We help operators and accounting firms automate finance ops with AI agents. If you want help deploying this, customizing it, or building an "AI CFO" workflow on top of it, [book a free diagnostic call](https://calendly.com/d/csm9-53t-pg6/diagnostic-strategy-call).

---

## What it does

- Connects one MCP server to **as many QuickBooks Online companies as you want**. Each authorized company is a "client" with its own slug.
- Exposes **15 read-only tools** an LLM can call: chart of accounts, vendor search & history, account registers, raw QBO query escape hatch, and **9 native QuickBooks reports** (P&L, Balance Sheet, Cash Flow, Trial Balance, General Ledger, AR/AP Aging, Vendor Expenses, Transaction List).
- **No write tools.** No `create_*`, no `update_*`, no `delete_*`. Safe to give to any AI agent.
- Hosted OAuth flow: deploy once on Railway, click a link, pick a company in Intuit's picker. Done. Each new client is one more click — no developer required to add another company.
- Runs in two modes from the same code: **stdio** for local Claude Code, **HTTP/SSE** for hosted MCP clients on Railway.

---

## Tools

| Tool | What it returns |
|---|---|
| `qbo_list_clients` | Authorized client companies with their slugs. **Start here.** |
| `qbo_query` | Raw QBO query language (read-only, escape hatch) |
| `qbo_list_accounts` | Chart of accounts (filter by AccountType) |
| `qbo_search_vendors` | Fuzzy vendor lookup by name |
| `qbo_get_vendor_history` | Recent Bills + Purchases + GL-account histogram for a vendor |
| `qbo_get_account_register` | Purchases / Deposits / BillPayments against a bank or CC in a date window |
| `qbo_report_profit_and_loss` | Income statement |
| `qbo_report_balance_sheet` | Assets, liabilities, equity |
| `qbo_report_cash_flow` | Statement of Cash Flows |
| `qbo_report_trial_balance` | Per-account debit/credit balances |
| `qbo_report_general_ledger` | Every posting to every account in a window |
| `qbo_report_ap_aging` | Aged Payables — what's owed to each vendor |
| `qbo_report_ar_aging` | Aged Receivables — what each customer owes |
| `qbo_report_vendor_expenses` | Total spend by vendor (1099 prep, concentration analysis) |
| `qbo_report_transaction_list` | Flat list of every transaction in a window |

Every tool (except `qbo_list_clients`) takes a `client` slug as its first argument so it's always explicit which company's books are being queried.

---

## Why this exists

Most QuickBooks integrations are either single-company or built for write-heavy bookkeeping workflows. Neither shape is right for an AI agent that just needs to **read and reason**. This MCP solves three things at once:

1. **Multi-tenant** — one deployment, many companies. Add a new client in 30 seconds via the hosted OAuth UI.
2. **Read-only by construction** — there is no code path in this build that mutates QBO. You can hand it to an autonomous agent without worrying about hallucinated journal entries.
3. **Reports as first-class tools** — the 9 native QuickBooks reports are exposed directly, with date ranges, accounting method, and column-summarization passthrough. Perfect for an LLM that needs to answer "what was margin in Q1?" or "who do we owe more than $5K to?"

If you need write capabilities (create vendors, post journal entries, re-categorize transactions, apply bill payments, etc.), [get in touch](https://calendly.com/d/csm9-53t-pg6/diagnostic-strategy-call) — 8x runs a production version with full write support and audit trails.

---

## Deploy to Railway

This is the recommended way to run it. ~5 minutes from "git push" to "MCP responds."

1. **Create an Intuit app**: <https://developer.intuit.com> → Dashboard → Create an app → QuickBooks Online and Payments. Copy the **Production** Client ID and Secret. Add a redirect URI: `https://<your-service>.up.railway.app/oauth/callback`.

2. **Deploy this repo** to Railway. (Railway → New Project → Deploy from GitHub repo → point at this repo.)

3. **Mount a volume** at `/data` (Service → Settings → Volumes → New Volume → Mount path `/data`). Token files live there — without it, every redeploy wipes your authorized clients.

4. **Set env vars**:
   ```
   QBO_CLIENT_ID=...
   QBO_CLIENT_SECRET=...
   QBO_ENVIRONMENT=production
   QBO_REDIRECT_URI=https://<your-service>.up.railway.app/oauth/callback
   QBO_TOKENS_DIR=/data/tokens
   ```
   (Don't set `PORT` — Railway injects it automatically.)

5. **Open the deployed URL**. You'll see a home page with a form to authorize your first client. Type a slug (e.g. `acme`), click Authorize, sign into Intuit, pick the company, you're done.

6. **Wire up Claude / your MCP client**:
   ```json
   {
     "mcpServers": {
       "quickbooks": {
         "url": "https://<your-service>.up.railway.app/sse"
       }
     }
   }
   ```

That's it. Ask Claude *"List my QuickBooks clients"* — it'll call `qbo_list_clients` and you're off.

---

## Run locally (stdio)

For a single-user Claude Code session on your laptop:

```bash
git clone https://github.com/matteightx/eightx-quickbooks-mcp.git
cd eightx-quickbooks-mcp
npm install
cp .env.example .env
# Fill in QBO_CLIENT_ID / QBO_CLIENT_SECRET
# Set QBO_REDIRECT_URI=http://localhost:8080/oauth/callback
npm run build

# Run once in HTTP mode to authorize a client via browser:
PORT=8080 npm start
# → visit http://localhost:8080/, authorize a client, ctrl+c

# Then run in stdio mode (no PORT) for Claude Code:
npm start
```

Add to your Claude Code MCP config:
```json
{
  "mcpServers": {
    "quickbooks": {
      "command": "node",
      "args": ["/absolute/path/to/eightx-quickbooks-mcp/dist/index.js"]
    }
  }
}
```

---

## Configuration reference

| Env var | Default | Notes |
|---|---|---|
| `QBO_CLIENT_ID` | — | From developer.intuit.com |
| `QBO_CLIENT_SECRET` | — | From developer.intuit.com |
| `QBO_ENVIRONMENT` | `production` | `production` or `sandbox` |
| `QBO_REDIRECT_URI` | — | Must exactly match an Intuit app redirect URI |
| `PORT` | unset | Set → HTTP/SSE mode. Unset → stdio mode. |
| `QBO_TOKENS_DIR` | `./tokens` | Point at a persistent path on Railway (e.g. `/data/tokens`) |

---

## Working with an accounting firm's client books

If you're an accountant with **firm access** to multiple QuickBooks companies, you can authorize all of them through this single MCP without anyone on the client side doing anything. Sign into Intuit as your firm user, and every company you've been invited into shows up in the "Choose a company" picker during OAuth.

---

## Need write access, custom reporting, or a full AI CFO?

This is the open-source, read-only version. The team at **8x** built it and runs the production version with write support, audit trails, batch tools, and AI workflows on top.

- **[eightx.co](https://eightx.co)** — what we do
- **[Book a free diagnostic call](https://calendly.com/d/csm9-53t-pg6/diagnostic-strategy-call)** — tell us about your books and we'll show you what's possible

PRs welcome. Issues welcome. License: MIT.
