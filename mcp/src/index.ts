/**
 * TTSG İlan MCP server (stdio).
 *
 * Exposes tools to log in to ticaretsicil.gov.tr, list registry offices, search
 * gazette announcements by company name/registry number, and download an ilan PDF.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  login,
  loadOffices,
  search,
  getIlanPdf,
  close,
  NotLoggedInError,
} from "./ttsg.js";
import { resolveOffice, normalizeTr } from "./offices.js";

const server = new McpServer({
  name: "ttsg-ilan",
  version: "0.1.0",
});

const DATE_RE = /^\d{2}\.\d{2}\.\d{4}$/;

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function errorResult(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

server.tool(
  "ttsg_login",
  "Open a browser window on ticaretsicil.gov.tr and wait for the user to complete the e-Devlet / member login. The session is persisted, so this is only needed occasionally. Never enters credentials automatically.",
  {},
  async () => {
    try {
      await login();
      return textResult("Logged in to ticaretsicil.gov.tr. The session is saved; you can now search.");
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  }
);

server.tool(
  "ttsg_offices",
  "List the trade registry offices (Ticaret Sicili Müdürlükleri) available in the İlan Görüntüleme search, with their ids. Optionally filter by a name fragment. Requires an active session.",
  {
    filter: z
      .string()
      .optional()
      .describe("Optional name fragment to filter offices, e.g. 'GEB' or 'İstanbul'."),
  },
  async ({ filter }) => {
    try {
      const offices = await loadOffices();
      const list = filter
        ? offices.filter((o) => normalizeTr(o.name).includes(normalizeTr(filter)))
        : offices;
      const lines = list.map((o) => `${o.name} (id: ${o.id})`).join("\n");
      return textResult(`${list.length} office(s):\n${lines}`);
    } catch (err) {
      if (err instanceof NotLoggedInError) return errorResult(err.message);
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  }
);

server.tool(
  "ttsg_search",
  "Search Türkiye Ticaret Sicili Gazetesi announcements. A registry office is REQUIRED (name or id), plus either a company name (unvan, min 5 chars) or a registry number (sicilNo). Returns the list of matching ilanlar with their Guid (use ttsg_get_ilan to fetch a PDF). Requires an active session.",
  {
    office: z
      .string()
      .describe("Registry office name or id, e.g. 'Gebze', 'İstanbul', or '88'. Required."),
    unvan: z
      .string()
      .optional()
      .describe("Company trade name, at least 5 characters. Use this OR sicilNo."),
    sicilNo: z
      .string()
      .optional()
      .describe("Trade registry number. Use this OR unvan."),
    dateFrom: z
      .string()
      .optional()
      .describe("Start of publication date range, format dd.mm.yyyy."),
    dateTo: z
      .string()
      .optional()
      .describe("End of publication date range, format dd.mm.yyyy."),
    includeCourt: z
      .boolean()
      .optional()
      .describe("Also search court and bankruptcy/enforcement office announcements."),
  },
  async ({ office, unvan, sicilNo, dateFrom, dateTo, includeCourt }) => {
    if (!unvan && !sicilNo) {
      return errorResult("Provide either 'unvan' (company name) or 'sicilNo' (registry number).");
    }
    if (unvan && unvan.trim().length < 5) {
      return errorResult("'unvan' must be at least 5 characters (site requirement).");
    }
    for (const [label, v] of [
      ["dateFrom", dateFrom],
      ["dateTo", dateTo],
    ] as const) {
      if (v && !DATE_RE.test(v)) return errorResult(`'${label}' must be in dd.mm.yyyy format.`);
    }

    try {
      const offices = await loadOffices();
      const resolved = resolveOffice(office, offices);
      if (!resolved) {
        const near = offices
          .filter((o) => normalizeTr(o.name).includes(normalizeTr(office)))
          .slice(0, 10)
          .map((o) => `${o.name} (${o.id})`);
        const hint =
          near.length > 0
            ? ` Did you mean: ${near.join(", ")}?`
            : " Use ttsg_offices to list valid offices.";
        return errorResult(`Could not resolve registry office "${office}".${hint}`);
      }

      const result = await search(
        { office: resolved.id, unvan, sicilNo, dateFrom, dateTo, includeCourt },
        resolved
      );

      if (result.count === 0) {
        return textResult(
          `No announcements found in ${resolved.name} for ${unvan ? `unvan "${unvan}"` : `sicil no ${sicilNo}`}.`
        );
      }

      const header = `${result.count} announcement(s) in ${resolved.name}:`;
      const body = result.ilanlar
        .map(
          (i, n) =>
            `${n + 1}. ${i.yayinTarihi} | Sayı ${i.sayi}${i.sayfa ? `, Sayfa ${i.sayfa}` : ""} | ${i.ilanTuru}\n   ${i.unvan} (Sicil ${i.sicilNo})\n   Guid: ${i.guid}`
        )
        .join("\n");
      return textResult(`${header}\n${body}`);
    } catch (err) {
      if (err instanceof NotLoggedInError) return errorResult(err.message);
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  }
);

server.tool(
  "ttsg_get_ilan",
  "Download a gazette announcement PDF by its Guid (from ttsg_search) through the authenticated session. Returns the saved file path; read that file to view/summarize the ilan. Requires an active session.",
  {
    guid: z.string().describe("The ilan Guid returned by ttsg_search."),
  },
  async ({ guid }) => {
    try {
      const r = await getIlanPdf(guid);
      return textResult(
        `Saved ilan PDF (${r.bytes} bytes, ${r.contentType}) to:\n${r.filePath}\n\nRead this file to view or summarize the announcement.`
      );
    } catch (err) {
      if (err instanceof NotLoggedInError) return errorResult(err.message);
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    await close();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
