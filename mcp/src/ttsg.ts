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

/**
 * Whether normal operations (search/offices/get_ilan) run in a headless
 * (invisible) browser. Login always uses a visible window regardless, since it
 * is interactive. Set TTSG_HEADLESS=false to force the old always-visible
 * behavior (e.g. for debugging selectors).
 */
const HEADLESS_DEFAULT = process.env.TTSG_HEADLESS?.trim().toLowerCase() !== "false";

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
/** Headless mode of the live `context`, so we can detect a mode switch. */
let contextHeadless: boolean | null = null;

async function ensureContext(headless: boolean = HEADLESS_DEFAULT): Promise<BrowserContext> {
  // Reuse the live context only if its headless mode matches what's requested.
  // A context's headless mode is fixed at launch, so switching (e.g. from the
  // headed login window to headless searches) means closing and relaunching;
  // the persistent profile carries the session across the relaunch.
  //
  // The "close" listener below nulls this singleton when the context ends (user
  // closes the window, or we close it here), so the next call transparently
  // re-launches instead of reusing a dead context (which would throw
  // "Target page, context or browser has been closed").
  //
  // NOTE: do NOT gate reuse on context.browser()?.isConnected() — a persistent
  // context's browser() is always null, so that check would treat every live
  // context as dead and re-launch on every call (dropping the logged-in session).
  if (context && contextHeadless === headless) return context;
  if (context) {
    await context.close().catch(() => {});
    context = null;
    contextHeadless = null;
  }
  // Use an installed system browser (Chrome by default) rather than Playwright's
  // bundled Chromium, which lives inside the packaged-app sandbox and fails to
  // spawn ("spawn UNKNOWN"). Overridable via env for machines without Chrome.
  const channel = process.env.TTSG_BROWSER_CHANNEL?.trim() || "chrome";
  const executablePath = process.env.TTSG_BROWSER_EXECUTABLE?.trim() || undefined;
  const ctx = await chromium.launchPersistentContext(profileDir(), {
    headless,
    ...(executablePath ? { executablePath } : { channel }),
    viewport: { width: 1280, height: 900 },
    args: ["--disable-blink-features=AutomationControlled"],
  });
  ctx.setDefaultTimeout(30_000);
  // When the window/context closes, clear the singleton so the next call
  // transparently re-launches a fresh browser.
  ctx.once("close", () => {
    if (context === ctx) {
      context = null;
      contextHeadless = null;
    }
  });
  context = ctx;
  contextHeadless = headless;
  return context;
}

async function getPage(headless?: boolean): Promise<Page> {
  const ctx = await ensureContext(headless);
  const existing = ctx.pages();
  return existing.length > 0 ? existing[0] : await ctx.newPage();
}

/**
 * Logged-in state is indicated by the "ÇIKIŞ" (logout) link in the top nav.
 *
 * The nav is rendered by JS after `domcontentloaded`, so an instantaneous count
 * races the render and false-negatives on a freshly navigated page. Wait briefly
 * for the link to attach before concluding "logged out" — this keeps login()'s
 * poll loop fast (returns as soon as the link appears) while making the one-shot
 * checks in search()/loadOffices() reliable. `waitMs` is kept small for the
 * genuinely-logged-out case so callers don't stall.
 */
async function isLoggedIn(page: Page, waitMs = 8000): Promise<boolean> {
  const logout = page.getByRole("link", { name: "ÇIKIŞ", exact: false });
  try {
    await logout.first().waitFor({ state: "attached", timeout: waitMs });
    return true;
  } catch {
    return false;
  }
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
 * Open a **visible** window on the search page and wait for the user to complete
 * the e-Devlet / member login themselves (login is interactive — CAPTCHA + SSO —
 * so it always needs a headed window, regardless of HEADLESS_DEFAULT).
 *
 * Once logged in, if normal ops run headless we close the visible window and
 * reopen headless on the same profile so no window lingers. To survive that
 * close we first promote session-scoped cookies (e.g. PHPSESSID) to persistent,
 * then verify the headless context is still authenticated and report it via
 * `windowless`.
 */
export async function login(
  timeoutMs = 300_000
): Promise<{ status: "logged_in"; windowless: boolean }> {
  const page = await getPage(false); // headed: the user must see and drive this
  await page.goto(SEARCH_PAGE, { waitUntil: "domcontentloaded" });

  if (!(await isLoggedIn(page))) {
    // Surface the login dialog for the user if the wall's "Giriş Yap" button is present.
    const girisYap = page.getByRole("button", { name: "Giriş Yap", exact: false });
    if ((await girisYap.count()) > 0) {
      await girisYap.first().click().catch(() => {});
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && !(await isLoggedIn(page))) {
      await page.waitForTimeout(2000);
    }
    if (!(await isLoggedIn(page))) {
      throw new Error(
        "Timed out waiting for login. Complete the e-Devlet/member login in the browser window, then retry."
      );
    }
  }

  // If normal ops stay headed, we're done — keep the (now logged-in) window.
  if (!HEADLESS_DEFAULT) return { status: "logged_in", windowless: false };

  // Promote session cookies to persistent so the auth survives the browser close
  // that the headed→headless switch performs. Cookies without an expiry are
  // session-scoped and would otherwise be dropped.
  try {
    const nowSec = Math.floor(Date.now() / 1000);
    const promoted = (await page.context().cookies()).map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      expires: !c.expires || c.expires < 0 ? nowSec + 7 * 24 * 3600 : c.expires,
      httpOnly: c.httpOnly,
      secure: c.secure,
      sameSite: c.sameSite,
    }));
    await page.context().addCookies(promoted);
  } catch {
    // Best-effort; the verification below is the source of truth.
  }

  // Switch to headless (closes the visible window, relaunches on the same
  // profile) and confirm the session carried over.
  const headlessPage = await getPage(true);
  await headlessPage.goto(SEARCH_PAGE, { waitUntil: "domcontentloaded" });
  const windowless = await isLoggedIn(headlessPage);
  return { status: "logged_in", windowless };
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

  // Scope all field lookups to the search form. The page also hosts a "become a
  // member" form whose fields share similar placeholders (e.g. #Unvan
  // "…Ticaret Unvanı…"), so an unscoped getByPlaceholder(/Ticaret Unvanı/)
  // matches two inputs and Playwright's strict mode throws. The search form is
  // the one containing the office <select>.
  const form = page.locator("form", { has: officeSelect(page) }).first();

  if (params.sicilNo) {
    await form.getByPlaceholder("Ticaret Sicili No").fill(params.sicilNo);
  }
  if (params.unvan) {
    // #TicaretUnvani is the search form's company-name input (unique page-wide),
    // distinct from the membership form's #Unvan.
    await form.locator("#TicaretUnvani").fill(params.unvan);
  }

  if (params.includeCourt) {
    const court = form.getByText("Mahkeme ve İcra/İflas Dairesi İlanlarında Ara", {
      exact: false,
    });
    const cb = court.locator("xpath=preceding::input[@type='checkbox'][1]");
    if ((await cb.count()) > 0) await cb.first().check().catch(() => {});
  }

  if (params.dateFrom || params.dateTo) {
    const rangeToggle = form
      .getByText("Tarih Aralığına Göre Sorgulama", { exact: false })
      .locator("xpath=following::input[@type='checkbox'][1]");
    if ((await rangeToggle.count()) > 0) await rangeToggle.first().check().catch(() => {});
    const dateInputs = form.getByPlaceholder("gg.aa.yyyy");
    if (params.dateFrom) await dateInputs.nth(0).fill(toIso(params.dateFrom));
    if (params.dateTo) await dateInputs.nth(1).fill(toIso(params.dateTo));
  }

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

  const typed = ilanlar as unknown as Ilan[];
  // Cache metadata by Guid so getIlanPdf can build a human-readable filename
  // (the get-ilan tool only receives a Guid).
  for (const i of typed) ilanCache.set(i.guid, i);

  return {
    office: resolvedOffice,
    count: typed.length,
    ilanlar: typed,
  };
}

/**
 * In-memory Guid -> Ilan metadata, populated by search(). Lets getIlanPdf name
 * the saved file "<YYYYMMDD>_<company> <short type>.pdf" instead of "<guid>.pdf".
 * Cold on a fresh process (no prior search) -> falls back to the Guid name.
 */
const ilanCache = new Map<string, Ilan>();

/** Turkish-aware title case for a single word: "ANT" -> "Ant", "İST" -> "İst". */
function titleCaseTr(w: string): string {
  if (!w) return w;
  return w.charAt(0).toLocaleUpperCase("tr") + w.slice(1).toLocaleLowerCase("tr");
}

/**
 * Short brand/company name from a full legal ünvan: the leading word(s) before
 * the first sector/legal term, title-cased and capped at two words.
 * "ANT SYSTEMS NANO TEKNOLOJİ ... ANONİM ŞİRKETİ" -> "Ant Systems".
 */
const COMPANY_STOPWORDS = new Set([
  "ANONİM", "LİMİTED", "ŞİRKET", "ŞİRKETİ", "ŞTİ", "LTD", "AŞ", "A.Ş", "A.Ş.",
  "KOLLEKTİF", "KOMANDİT", "KOOPERATİF", "SANAYİ", "SAN", "TİCARET", "TİC",
  "İNŞAAT", "GIDA", "TEKSTİL", "TURİZM", "NAKLİYAT", "LOJİSTİK", "OTOMOTİV",
  "ENERJİ", "TARIM", "SAĞLIK", "EĞİTİM", "BİLİŞİM", "TEKNOLOJİ", "TEKNOLOJİLERİ",
  "YAZILIM", "DANIŞMANLIK", "PAZARLAMA", "İTHALAT", "İHRACAT", "ÜRETİM", "İMALAT",
  "HİZMETLERİ", "HİZMET", "ARGE", "AR-GE", "MÜHENDİSLİK", "ELEKTRONİK",
  "MADENCİLİK", "KİMYA", "İLAÇ", "MOBİLYA", "YAPI", "EMLAK", "GAYRİMENKUL",
  "FİNANS", "SİGORTA", "REKLAM", "ORGANİZASYON", "İNOVASYON", "VE", "İLE",
]);
function shortCompany(unvan: string): string {
  const words = (unvan || "").split(/\s+/).filter(Boolean);
  const out: string[] = [];
  for (const w of words) {
    const up = w.toLocaleUpperCase("tr").replace(/[.,]/g, "");
    if (COMPANY_STOPWORDS.has(up)) break;
    out.push(w);
    if (out.length >= 2) break;
  }
  if (out.length === 0 && words.length) out.push(words[0]);
  return out.map(titleCaseTr).join(" ");
}

/**
 * Simplified ilan type. The site's raw ilanTuru concatenates a category, the
 * company-form descriptor, and the actual change — and the descriptor (e.g.
 * "TEK PAY SAHİPLİ ANONİM ŞİRKET") causes false positives. The real change
 * follows the last "ŞİRKET", so match against that slice first.
 */
function shortIlanType(raw: string): string {
  const full = raw || "";
  const idx = full.toLocaleUpperCase("tr").lastIndexOf("ŞİRKET");
  const change = idx >= 0 ? full.slice(idx + "ŞİRKET".length) : full;
  const s = change.toLocaleUpperCase("tr");
  const rules: [RegExp, string][] = [
    [/KURULUŞ/, "Kuruluş"],
    [/TASFİYE/, "Tasfiye"],
    [/BİRLEŞME/, "Birleşme"],
    [/BÖLÜNME/, "Bölünme"],
    [/TÜR DEĞİŞ/, "Tür Değişikliği"],
    [/SERMAYE.*ARTIR/, "Sermaye Artırımı"],
    [/SERMAYE.*AZALT/, "Sermaye Azaltımı"],
    [/SERMAYE/, "Sermaye Değişikliği"],
    [/GENEL KURUL İÇ YÖNERGE/, "Genel Kurul İç Yönergesi"],
    [/TEK PAY SAHİ|TEK ORTAK/, "Tek Pay Sahipliği Değişikliği"],
    [/YÖNETİM KURULU/, "Yönetim Kurulu Değişikliği"],
    [/MÜDÜR/, "Müdür Değişikliği"],
    [/TEMSİL/, "Temsil ve İlzam Değişikliği"],
    [/ADRES|MERKEZ/, "Adres Değişikliği"],
    [/UNVAN/, "Unvan Değişikliği"],
    [/ESAS SÖZLEŞME|ANA SÖZLEŞME/, "Esas Sözleşme Değişikliği"],
    [/GENEL KURUL/, "Genel Kurul"],
  ];
  for (const [re, label] of rules) if (re.test(s)) return label;
  const m = change.match(/Değişiklik\s*-\s*([^-]{3,50})/);
  if (m) return m[1].trim();
  const cleaned = change.replace(/[-–]/g, " ").replace(/\s+/g, " ").trim();
  return cleaned.slice(0, 50) || "İlan";
}

/** Strip characters illegal in Windows filenames and collapse whitespace. */
function sanitizeFileName(s: string): string {
  return s.replace(/[\\/:*?"<>|]/g, "").replace(/\s+/g, " ").trim();
}

/** "<YYYYMMDD>_<company> <short type>.pdf" from cached ilan metadata. */
function ilanFileName(ilan: Ilan): string {
  const d = ilan.yayinTarihi?.match(/(\d{2})\.(\d{2})\.(\d{4})/);
  const ymd = d ? `${d[3]}${d[2]}${d[1]}` : "00000000";
  const base = `${ymd}_${shortCompany(ilan.unvan)} ${shortIlanType(ilan.ilanTuru)}`;
  return `${sanitizeFileName(base)}.pdf`;
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

  // Name the file readably from cached search metadata; fall back to the Guid
  // when this process has no prior search for it (e.g. fetched cold after restart).
  const meta = ilanCache.get(guid);
  const fileName = meta ? ilanFileName(meta) : `${guid}.pdf`;
  const filePath = path.join(pdfDir(), fileName);
  fs.writeFileSync(filePath, body);

  // The endpoint mislabels the header as text/html even when the body is a PDF;
  // report based on the actual bytes.
  const isPdf = body.subarray(0, 5).toString("latin1") === "%PDF-";
  return {
    guid,
    filePath,
    bytes: body.length,
    contentType: isPdf ? "application/pdf" : contentType || "application/octet-stream",
  };
}

export async function close(): Promise<void> {
  if (context) {
    await context.close().catch(() => {});
    context = null;
  }
}
