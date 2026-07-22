---
name: ilan
description: Search and summarize Türkiye Ticaret Sicili Gazetesi (TTSG) announcements for a company. Use when the user asks for a company's trade registry gazette ilans, wants a list of a firm's TTSG announcements (kuruluş, değişiklik, genel kurul, tasfiye, sermaye artırımı, etc.), or asks to fetch/summarize a specific ilan.
---

# TTSG İlan — search & summarize

Use the `ttsg` MCP tools to look up and summarize Turkish Trade Registry Gazette announcements. The user says a company (and registry office); you return a list and, on request, fetch and summarize specific ilans.

## Workflow

1. **Identify office + company.** The registry office (Sicil Müdürlüğü) is **mandatory** — searching by company name alone is impossible on TTSG. If the user gives only a company name, ask which office/city (e.g. "Gebze", "İstanbul"), or use `ttsg_offices` to help them pick. Company name (`unvan`) must be at least 5 characters.

2. **Search** with `ttsg_search` (`office` + `unvan` or `sicilNo`; optional `dateFrom`/`dateTo` in `dd.mm.yyyy`, `includeCourt`). Present the returned list plainly: date, sayı/sayfa, ilan türü, ünvan, sicil no. Keep each ilan's `Guid` — it's needed to fetch the PDF.

3. **If not logged in**, any tool returns a "run ttsg_login" message. Call `ttsg_login`, which opens a browser window; tell the user to complete the e-Devlet/member login themselves (you never enter credentials or solve the CAPTCHA). Once they're in, retry the search.

4. **Fetch on request.** When the user picks an ilan (or asks to summarize), call `ttsg_get_ilan` with its `Guid`. It saves a PDF and returns the path. **Read that file** to get the content.

5. **Summarize** each fetched ilan in this structure (Turkish, since the source is Turkish):

   - **Kimlik**: ünvan, MERSİS no (if present), ticaret sicil no, sicil müdürlüğü
   - **İlan künyesi**: gazete tarihi + sayı, sayfa, ilan türü
   - **Ne değişti / ne yayımlandı**: the substance — kuruluş bilgileri; yeni/ayrılan ortaklar; yönetim kurulu / müdür değişiklikleri; sermaye (önce → sonra); değiştirilen esas sözleşme maddeleri; tasfiye/birleşme kararları
   - **Özet**: 2–3 cümlelik sade özet + bir avukat için önemli olabilecek noktalar (dikkat notu)

## Notes

- The session persists between runs; `ttsg_login` is only needed when it expires.
- Don't invent fields not present in the ilan. If the PDF is unreadable or empty, say so and offer to re-fetch.
- For "all ilans of X", list everything from the search; only fetch PDFs the user asks for (each fetch is a network call).
