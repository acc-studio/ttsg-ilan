/**
 * TTSG (ticaretsicil.gov.tr) automation over a persistent Playwright browser.
 *
 * The İlan Görüntüleme flow is login-walled (member account or e-Devlet SSO) and
 * the login page carries a CAPTCHA, but the *logged-in* search has no CAPTCHA — it
 * rides the session cookie. We therefore keep a persistent browser profile so the
 * user logs in once (interactively) and subsequent searches reuse the session.
 *
 * The user always performs the login themselves in the headed window; this module
 * never types credentials or solves CAPTCHAs.
 */

import { chromium, type BrowserContext, type Page } from "playwright";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { type Office } from "./offices.js";

const BASE = "https://www.ticaretsicil.gov.tr";
const SEARCH_PAGE = `${BASE}/view/hizlierisim/ilangoruntuleme.php`;
const PDF_ENDPOINT = `${BASE}/view/hizlierisim/pdf_goster.php?Guid=`;

/** A single gazette announcement row from the search results. */
export interface Ilan {
  office: string;
  sicilNo: string;
  unvan: string;
  yayinTarihi: string;
  sayi: string;
  sayfa: string;
  ilanTuru: string;
  guid: string;
}

export interface SearchParams {
  office: string;
  unvan?: string;
  sicilNo?: string;
  /** dd.mm.yyyy */
  dateFrom?: string;
  /** dd.mm.yyyy */
  dateTo?: string;
  includeCourt?: boolean;
}

export interface SearchResult {
  office: Office;
  count: number;
  ilanlar: Ilan[];
}

export interface PdfResult {
  guid: string;
  filePath: string;
  bytes: number;
  contentType: string;
}

export class NotLoggedInError extends Error {
  constructor() {
    super("Not logged in to ticaretsicil.gov.tr. Run the ttsg_login tool first.");
    this.name = "NotLoggedInError";
  }
}

function dataDir(): string {
  const base =
    process.env.TTSG_DATA_DIR && process.env.TTSG_DATA_DIR.trim().length > 0
      ? process.env.TTSG_DATA_DIR
      : path.join(os.homedir(), ".claude", "ttsg-ilan", "data");
  fs.mkdirSync(base, { recursive: true });
  return base;
}

function profileDir(): string {
  const dir = path.join(dataDir(), "browser-profile");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function pdfDir(): string {
  const dir = path.join(dataDir(), "ilanlar");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

let context: BrowserContext | null = null;

async function ensureContext(): Promise<BrowserContext> {
  if (context) return context;
  // Use an installed system browser (Chrome by default) rather than Playwright's
  // bundled Chromium, which lives inside the packaged-app sandbox and fails to
  // spawn ("spawn UNKNOWN"). Overridable via env for machines without Chrome.
  const channel = process.env.TTSG_BROWSER_CHANNEL?.trim() || "chrome";
  const executablePath = process.env.TTSG_BROWSER_EXECUTABLE?.trim() || undefined;
  context = await chromium.launchPersistentContext(profileDir(), {
    headless: false,
    ...(executablePath ? { executablePath } : { channel }),
    viewport: { width: 1280, height: 900 },
    args: ["--disable-blink-features=AutomationControlled"],
  });
  context.setDefaultTimeout(30_000);
  return context;
}

async function getPage(): Promise<Page> {
  const ctx = await ensureContext();
  const existing = ctx.pages();
  return existing.length > 0 ? existing[0] : await ctx.newPage();
}

/** Logged-in state is indicated by the "ÇIKIŞ" (logout) link in the top nav. */
async function isLoggedIn(page: Page): Promise<boolean> {
  const logout = page.getByRole("link", { name: "ÇIKIŞ", exact: false });
  return (await logout.count()) > 0;
}

/** The <select> for registry office, scoped to the search form. */
function officeSelect(page: Page) {
  return page
    .locator("select", {
      has: page.locator("option", { hasText: "Sicil Müdürlüğü Seçiniz" }),
    })
    .first();
}

/**
 * Open a headed window on the search page and wait for the user to complete the
 * e-Devlet / member login themselves. Resolves once logged in, or throws on timeout.
 */
export async function login(timeoutMs = 300_000): Promise<{ status: "logged_in" }> {
  const page = await getPage();
  await page.goto(SEARCH_PAGE, { waitUntil: "domcontentloaded" });

  if (await isLoggedIn(page)) return { status: "logged_in" };

  // Surface the login dialog for the user if the wall's "Giriş Yap" button is present.
  const girisYap = page.getByRole("button", { name: "Giriş Yap", exact: false });
  if ((await girisYap.count()) > 0) {
    await girisYap.first().click().catch(() => {});
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isLoggedIn(page)) return { status: "logged_in" };
    await page.waitForTimeout(2000);
  }
  throw new Error(
    "Timed out waiting for login. Complete the e-Devlet/member login in the browser window, then retry."
  );
}

/** Scrape the authoritative office list (name -> select value) from the search page. */
export async function loadOffices(): Promise<Office[]> {
  const page = await getPage();
  await page.goto(SEARCH_PAGE, { waitUntil: "domcontentloaded" });
  if (!(await isLoggedIn(page))) throw new NotLoggedInError();

  const select = officeSelect(page);
  await select.waitFor({ state: "attached" });
  const offices = await select.locator("option").evaluateAll((opts) =>
    opts
      .map((o) => ({ name: (o.textContent || "").trim(), id: (o as HTMLOptionElement).value }))
      .filter((o) => o.id && o.id !== "0")
  );
  return offices;
}

function toIso(ddmmyyyy: string): string {
  return ddmmyyyy; // site expects dd.mm.yyyy; pass through, validated at the tool layer
}

/**
 * Run a search. Requires a valid session; throws NotLoggedInError otherwise.
 * The office must already be resolved to a live Office (id + name) by the caller.
 */
export async function search(
  params: SearchParams,
  resolvedOffice: Office
): Promise<SearchResult> {
  const page = await getPage();
  await page.goto(SEARCH_PAGE, { waitUntil: "domcontentloaded" });
  if (!(await isLoggedIn(page))) throw new NotLoggedInError();

  const select = officeSelect(page);
  await select.waitFor({ state: "attached" });
  await select.selectOption(resolvedOffice.id);

  if (params.sicilNo) {
    await page.getByPlaceholder("Ticaret Sicili No").fill(params.sicilNo);
  }
  if (params.unvan) {
    await page.getByPlaceholder(/Ticaret Unvanı/).fill(params.unvan);
  }

  if (params.includeCourt) {
    const court = page.getByText("Mahkeme ve İcra/İflas Dairesi İlanlarında Ara", {
      exact: false,
    });
    const cb = court.locator("xpath=preceding::input[@type='checkbox'][1]");
    if ((await cb.count()) > 0) await cb.first().check().catch(() => {});
  }

  if (params.dateFrom || params.dateTo) {
    const rangeToggle = page
      .getByText("Tarih Aralığına Göre Sorgulama", { exact: false })
      .locator("xpath=following::input[@type='checkbox'][1]");
    if ((await rangeToggle.count()) > 0) await rangeToggle.first().check().catch(() => {});
    const dateInputs = page.getByPlaceholder("gg.aa.yyyy");
    if (params.dateFrom) await dateInputs.nth(0).fill(toIso(params.dateFrom));
    if (params.dateTo) await dateInputs.nth(1).fill(toIso(params.dateTo));
  }

  const form = page.locator("form", { has: officeSelect(page) }).first();
  await form.locator('button[type="submit"]').first().click();

  // Wait for either the results table or the "count" heading to render.
  await page
    .locator('a[href*="pdf_goster.php"]')
    .first()
    .waitFor({ state: "attached", timeout: 20_000 })
    .catch(() => {});

  const ilanlar = await page.$$eval('a[href*="pdf_goster.php"]', (links) => {
    const seen = new Set<string>();
    const out: Record<string, string>[] = [];
    for (const a of links) {
      const tr = a.closest("tr");
      if (!tr) continue;
      const tds = Array.from(tr.querySelectorAll("td"));
      const cell = (i: number) => (tds[i]?.textContent || "").trim().replace(/\s+/g, " ");
      const href = a.getAttribute("href") || "";
      const m = href.match(/Guid=([0-9a-fA-F-]+)/);
      const guid = m ? m[1] : "";
      if (!guid || seen.has(guid)) continue;
      seen.add(guid);
      out.push({
        office: cell(0),
        sicilNo: cell(1),
        unvan: cell(2),
        yayinTarihi: cell(3),
        sayi: cell(4),
        sayfa: cell(5),
        ilanTuru: cell(6),
        guid,
      });
    }
    return out;
  });

  return {
    office: resolvedOffice,
    count: ilanlar.length,
    ilanlar: ilanlar as unknown as Ilan[],
  };
}

/** Download an ilan PDF by Guid through the authenticated session. */
export async function getIlanPdf(guid: string): Promise<PdfResult> {
  const ctx = await ensureContext();
  const page = await getPage();
  if (!(await isLoggedIn(page))) {
    // A stale profile may still hold cookies; verify via the search page.
    await page.goto(SEARCH_PAGE, { waitUntil: "domcontentloaded" });
    if (!(await isLoggedIn(page))) throw new NotLoggedInError();
  }

  const url = PDF_ENDPOINT + encodeURIComponent(guid);
  const resp = await ctx.request.get(url);
  if (!resp.ok()) {
    throw new Error(`PDF request failed: HTTP ${resp.status()} for Guid=${guid}`);
  }
  const contentType = resp.headers()["content-type"] || "";
  let body = await resp.body();

  // If the endpoint returns an HTML viewer wrapper, try to follow an embedded PDF url.
  const looksPdf = contentType.includes("pdf") || body.subarray(0, 5).toString("latin1") === "%PDF-";
  if (!looksPdf) {
    const html = body.toString("utf8");
    const embedded = html.match(/(?:src|href|data)=["']([^"']+\.pdf[^"']*)["']/i);
    if (embedded) {
      const abs = embedded[1].startsWith("http")
        ? embedded[1]
        : new URL(embedded[1], SEARCH_PAGE).toString();
      const r2 = await ctx.request.get(abs);
      if (r2.ok()) body = await r2.body();
    }
  }

  const filePath = path.join(pdfDir(), `${guid}.pdf`);
  fs.writeFileSync(filePath, body);
  return {
    guid,
    filePath,
    bytes: body.length,
    contentType: contentType || "application/octet-stream",
  };
}

export async function close(): Promise<void> {
  if (context) {
    await context.close().catch(() => {});
    context = null;
  }
}
