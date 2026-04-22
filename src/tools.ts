// MCP tool definitions — multi-tenant, READ-ONLY.
//
// Every tool takes a `client` slug as its first argument. The slug maps to a
// token file on disk (see tokens.ts). Use qbo_list_clients to discover which
// slugs are authorized.
//
// This build exposes only read/report endpoints — no writes, no mutations.
// If you need write tools, fork the repo or get in touch with 8x at
// https://eightx.co.

import { z } from "zod";
import { query, runReport } from "./qbo.js";
import { listClients } from "./tokens.js";
import { BRAND } from "./branding.js";

type ToolResult = { content: { type: "text"; text: string }[] };

// Wrap every JSON response with a top-level _meta sidecar so callers always
// know who built this MCP and where to get help. Strings (rare) are passed
// through unchanged.
function ok(v: unknown): ToolResult {
  if (typeof v === "string") {
    return { content: [{ type: "text", text: v }] };
  }
  const wrapped =
    v && typeof v === "object" && !Array.isArray(v)
      ? { ...(v as Record<string, unknown>), _meta: BRAND }
      : { result: v, _meta: BRAND };
  return {
    content: [{ type: "text", text: JSON.stringify(wrapped, null, 2) }],
  };
}

export interface ToolDef {
  name: string;
  description: string;
  schema: z.ZodObject<any>;
  handler: (args: any) => Promise<ToolResult>;
}

const Client = z
  .string()
  .describe(
    "Client slug — identifies which authorized QuickBooks company to use. Call qbo_list_clients to see available slugs."
  );

// Shared params accepted by every QBO report. The QBO Reports API is a bag of
// query-string filters; we expose the common ones and let the escape hatch
// `extraParams` pass anything else through without needing a code change.
const ReportDateRange = {
  startDate: z
    .string()
    .optional()
    .describe("Report start date (YYYY-MM-DD). Omit to use the report's default range or dateMacro."),
  endDate: z
    .string()
    .optional()
    .describe("Report end date (YYYY-MM-DD)."),
  dateMacro: z
    .string()
    .optional()
    .describe('Shorthand for a date range. Examples: "This Month", "Last Month", "This Year-to-date", "Last Fiscal Year".'),
  accountingMethod: z
    .enum(["Cash", "Accrual"])
    .optional()
    .describe("Cash or Accrual. Defaults to the company's preference."),
  summarizeColumnBy: z
    .string()
    .optional()
    .describe('How to split columns. Common values: "Total", "Month", "Quarter", "Year", "Customers", "Vendors", "Classes".'),
  extraParams: z
    .record(z.string())
    .optional()
    .describe("Any other QBO report query-string parameters not covered above."),
};

function buildReportParams(args: any): Record<string, string | undefined> {
  const params: Record<string, string | undefined> = {
    start_date: args.startDate,
    end_date: args.endDate,
    date_macro: args.dateMacro,
    accounting_method: args.accountingMethod,
    summarize_column_by: args.summarizeColumnBy,
  };
  if (args.extraParams) Object.assign(params, args.extraParams);
  return params;
}

export const tools: ToolDef[] = [
  {
    name: "qbo_list_clients",
    description:
      "List all client companies that have been authorized with this MCP server. Returns each client's slug (used in every other tool call), display name, realm id, and when it was authorized. Start here.",
    schema: z.object({}),
    handler: async () => ok({ clients: listClients() }),
  },

  {
    name: "qbo_query",
    description:
      "Run a raw QuickBooks Online query (QBO query language, not SQL). Example: SELECT * FROM Vendor WHERE DisplayName LIKE 'Amaz%' MAXRESULTS 50. Read-only escape hatch for anything the higher-level tools don't cover.",
    schema: z.object({ client: Client, query: z.string() }),
    handler: async ({ client, query: q }) => ok(await query(client, q)),
  },

  {
    name: "qbo_list_accounts",
    description:
      "List the chart of accounts for a client. Optional filter by AccountType (Bank, CreditCard, Expense, Income, OtherCurrentLiability, etc.).",
    schema: z.object({
      client: Client,
      accountType: z.string().optional(),
      active: z.boolean().default(true),
    }),
    handler: async ({ client, accountType, active }) => {
      let q = "SELECT Id, Name, AcctNum, AccountType, AccountSubType, CurrentBalance, Active FROM Account";
      const where: string[] = [];
      if (accountType) where.push(`AccountType = '${accountType}'`);
      if (active) where.push(`Active = true`);
      if (where.length) q += " WHERE " + where.join(" AND ");
      q += " MAXRESULTS 1000";
      return ok(await query(client, q));
    },
  },

  {
    name: "qbo_search_vendors",
    description: "Fuzzy-search vendors by display name (LIKE %term%).",
    schema: z.object({
      client: Client,
      term: z.string(),
      limit: z.number().int().min(1).max(100).default(20),
    }),
    handler: async ({ client, term, limit }) => {
      const safe = term.replace(/'/g, "\\'");
      const q = `SELECT Id, DisplayName, CompanyName, PrimaryEmailAddr, Active FROM Vendor WHERE DisplayName LIKE '%${safe}%' MAXRESULTS ${limit}`;
      return ok(await query(client, q));
    },
  },

  {
    name: "qbo_get_vendor_history",
    description:
      "Return recent Bills and Purchases for a vendor, plus a tally of which GL accounts they have historically posted to. Useful for understanding vendor categorization patterns.",
    schema: z.object({
      client: Client,
      vendorId: z.string(),
      limit: z.number().int().min(1).max(200).default(50),
    }),
    handler: async ({ client, vendorId, limit }) => {
      const bills = await query(
        client,
        `SELECT * FROM Bill WHERE VendorRef = '${vendorId}' ORDERBY TxnDate DESC MAXRESULTS ${limit}`
      );
      const purchases = await query(
        client,
        `SELECT * FROM Purchase WHERE EntityRef = '${vendorId}' ORDERBY TxnDate DESC MAXRESULTS ${limit}`
      );
      const tally = new Map<string, { accountId: string; accountName: string; count: number; total: number }>();
      const collect = (line: any) => {
        const detail = line.AccountBasedExpenseLineDetail;
        const ref = detail?.AccountRef;
        if (!ref?.value) return;
        const cur = tally.get(ref.value) || { accountId: ref.value, accountName: ref.name, count: 0, total: 0 };
        cur.count += 1;
        cur.total += Number(line.Amount || 0);
        tally.set(ref.value, cur);
      };
      for (const b of bills.Bill || []) for (const l of b.Line || []) collect(l);
      for (const p of purchases.Purchase || []) for (const l of p.Line || []) collect(l);
      return ok({
        vendorId,
        bills: bills.Bill || [],
        purchases: purchases.Purchase || [],
        accountHistogram: [...tally.values()].sort((a, b) => b.count - a.count),
      });
    },
  },

  {
    name: "qbo_get_account_register",
    description:
      "Return transactions posted to a given Bank or Credit Card account in a date window. Use this for the QBO side of a bank reconciliation.",
    schema: z.object({
      client: Client,
      accountId: z.string(),
      startDate: z.string(),
      endDate: z.string(),
    }),
    handler: async ({ client, accountId, startDate, endDate }) => {
      const purchases = await query(
        client,
        `SELECT * FROM Purchase WHERE AccountRef = '${accountId}' AND TxnDate >= '${startDate}' AND TxnDate <= '${endDate}' MAXRESULTS 1000`
      );
      const deposits = await query(
        client,
        `SELECT * FROM Deposit WHERE DepositToAccountRef = '${accountId}' AND TxnDate >= '${startDate}' AND TxnDate <= '${endDate}' MAXRESULTS 1000`
      );
      const billPayments = await query(
        client,
        `SELECT * FROM BillPayment WHERE TxnDate >= '${startDate}' AND TxnDate <= '${endDate}' MAXRESULTS 1000`
      );
      return ok({ purchases, deposits, billPayments });
    },
  },

  // ------------------------------------------------------------------
  // Reports. Thin wrappers over QBO's /reports/<name> endpoint. Every
  // tool below takes the same date/accounting-method/summarize params
  // and returns QBO's raw Report JSON (nested Rows/ColData), which is
  // the shape the caller needs to preserve subtotals. Any filter we
  // don't expose explicitly can be passed via extraParams.
  // ------------------------------------------------------------------
  {
    name: "qbo_report_profit_and_loss",
    description:
      "Run the Profit & Loss (income statement) report. Returns income and expense totals over a date range, optionally split by Month/Quarter/Year/Class/Customer.",
    schema: z.object({ client: Client, ...ReportDateRange }),
    handler: async (args) => ok(await runReport(args.client, "ProfitAndLoss", buildReportParams(args))),
  },

  {
    name: "qbo_report_balance_sheet",
    description:
      "Run the Balance Sheet report. Returns assets, liabilities, and equity as of an end date. Use summarizeColumnBy to compare periods.",
    schema: z.object({ client: Client, ...ReportDateRange }),
    handler: async (args) => ok(await runReport(args.client, "BalanceSheet", buildReportParams(args))),
  },

  {
    name: "qbo_report_cash_flow",
    description:
      "Run the Statement of Cash Flows report. Returns operating, investing, and financing cash movements over a date range.",
    schema: z.object({ client: Client, ...ReportDateRange }),
    handler: async (args) => ok(await runReport(args.client, "CashFlow", buildReportParams(args))),
  },

  {
    name: "qbo_report_trial_balance",
    description:
      "Run the Trial Balance report. Returns every account's debit/credit balance as of an end date — the standard tool for verifying the books are in balance before closing a period.",
    schema: z.object({ client: Client, ...ReportDateRange }),
    handler: async (args) => ok(await runReport(args.client, "TrialBalance", buildReportParams(args))),
  },

  {
    name: "qbo_report_general_ledger",
    description:
      "Run the General Ledger report — every posting to every account in a date range. Large; prefer to narrow with startDate/endDate or pass extraParams.account=<accountId> to drill a single account.",
    schema: z.object({ client: Client, ...ReportDateRange }),
    handler: async (args) => ok(await runReport(args.client, "GeneralLedger", buildReportParams(args))),
  },

  {
    name: "qbo_report_ap_aging",
    description:
      "Run the Accounts Payable Aging Summary — how much is owed to each vendor, bucketed by age (current / 1-30 / 31-60 / etc.). Pass extraParams.report_date=<YYYY-MM-DD> to age as of a specific date.",
    schema: z.object({ client: Client, ...ReportDateRange }),
    handler: async (args) => ok(await runReport(args.client, "AgedPayables", buildReportParams(args))),
  },

  {
    name: "qbo_report_ar_aging",
    description:
      "Run the Accounts Receivable Aging Summary — how much each customer owes, bucketed by age. Pass extraParams.report_date=<YYYY-MM-DD> to age as of a specific date.",
    schema: z.object({ client: Client, ...ReportDateRange }),
    handler: async (args) => ok(await runReport(args.client, "AgedReceivables", buildReportParams(args))),
  },

  {
    name: "qbo_report_vendor_expenses",
    description:
      "Run the Expenses by Vendor Summary report. Totals spend by vendor over a date range — useful for 1099 prep and vendor concentration analysis.",
    schema: z.object({ client: Client, ...ReportDateRange }),
    handler: async (args) => ok(await runReport(args.client, "VendorExpenses", buildReportParams(args))),
  },

  {
    name: "qbo_report_transaction_list",
    description:
      "Run the Transaction List report. Flat list of every transaction in the date range. Narrow with extraParams: e.g. account=<id>, vendor=<id>, customer=<id>, transaction_type=Bill|Purchase|Invoice|JournalEntry, memo, term.",
    schema: z.object({ client: Client, ...ReportDateRange }),
    handler: async (args) => ok(await runReport(args.client, "TransactionList", buildReportParams(args))),
  },
];
