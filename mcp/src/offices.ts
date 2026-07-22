/**
 * Trade registry office (Ticaret Sicili Müdürlüğü) helpers.
 *
 * The İlan Görüntüleme search form REQUIRES a registry office. Each office maps
 * to a numeric id used as the <select> value. The authoritative list is scraped
 * live from the search page at runtime (see ttsg.ts -> loadOffices), because the
 * set can change. The curated map below is a convenience for offline name->id
 * matching and for describing valid inputs to callers; runtime data wins.
 */

/** Normalize a Turkish office/company string for case- and diacritic-insensitive matching. */
export function normalizeTr(input: string): string {
  return input
    .toLocaleUpperCase("tr-TR")
    .replace(/İ/g, "I")
    .replace(/I/g, "I")
    .replace(/Ş/g, "S")
    .replace(/Ğ/g, "G")
    .replace(/Ü/g, "U")
    .replace(/Ö/g, "O")
    .replace(/Ç/g, "C")
    .replace(/\s+/g, " ")
    .trim();
}

/** Curated shortlist of common offices (name -> select value). Runtime scrape is authoritative. */
export const COMMON_OFFICES: Readonly<Record<string, string>> = {
  ISTANBUL: "232",
  ANKARA: "18",
  IZMIR: "233",
  BURSA: "52",
  ANTALYA: "19",
  ADANA: "2",
  KONYA: "129",
  KOCAELI: "127",
  GEBZE: "88",
  KORFEZ: "133",
  GAZIANTEP: "87",
  KAYSERI: "118",
  MERSIN: "144",
  DENIZLI: "62",
  ESKISEHIR: "84",
  SAMSUN: "171",
  SAKARYA: "169",
  TEKIRDAG: "192",
  CERKEZKOY: "221",
  CORLU: "222",
  MANISA: "140",
  BALIKESIR: "30",
  TRABZON: "197",
  DIYARBAKIR: "71",
  SANLIURFA: "235",
  MUGLA: "149",
};

export interface Office {
  /** Display name exactly as it appears in the site's <select>. */
  name: string;
  /** Numeric select value used when submitting the search. */
  id: string;
}

/**
 * Resolve a user-supplied office string to a select value, given the live office
 * list. Tries exact id, exact normalized name, then unique prefix/substring match.
 * Returns the matched Office or null when ambiguous/not found.
 */
export function resolveOffice(query: string, offices: Office[]): Office | null {
  const q = query.trim();
  if (/^\d+$/.test(q)) {
    const byId = offices.find((o) => o.id === q);
    if (byId) return byId;
  }
  const nq = normalizeTr(q);
  const exact = offices.filter((o) => normalizeTr(o.name) === nq);
  if (exact.length === 1) return exact[0];

  const starts = offices.filter((o) => normalizeTr(o.name).startsWith(nq));
  if (starts.length === 1) return starts[0];

  const contains = offices.filter((o) => normalizeTr(o.name).includes(nq));
  if (contains.length === 1) return contains[0];

  return null;
}
