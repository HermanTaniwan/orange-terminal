type IdxAttachmentRaw = {
  IsAttachment?: boolean;
  OriginalFilename?: string;
  PDFFilename?: string;
  FullSavePath?: string;
};

type IdxReplyRaw = {
  pengumuman?: {
    TglPengumuman?: string;
    JudulPengumuman?: string;
  };
  attachments?: IdxAttachmentRaw[];
};

type IdxApiResponse = {
  ResultCount?: number;
  Replies?: IdxReplyRaw[];
};

export type IdxAttachmentCandidate = {
  title: string;
  publishedAt: string;
  fileName: string;
  url: string;
};

export type IdxSizedAttachment = IdxAttachmentCandidate & {
  sizeBytes: number;
};

/** Satu baris pengumuman yang lolos filter + daftar PDF-nya (sebelum probe ukuran). */
export type IdxAnnouncementPdfGroup = {
  title: string;
  publishedAt: string;
  candidates: IdxAttachmentCandidate[];
};

/** Selaras sanitize_idx_pdf_url di skrip Python (whitespace + karakter kontrol). */
export function sanitizeIdxPdfUrl(url: string): string {
  if (!url) return "";
  return String(url)
    .trim()
    .replace(/[\x00-\x1f\x7f]/g, "")
    .trim();
}

const DEFAULT_KEYWORDS: string[] = [];

/**
 * Judul harus mengandung minimal satu substring ini agar diproses (ingest / daftar lampiran).
 * Selain itu, daftar exclude tetap dipakai sebagai lapisan kedua.
 */
export const DEFAULT_ALLOW_TITLE_SUBSTRINGS: string[] = [
  "penyampaian laporan keuangan",
  "pengungkapan laporan keuangan",
  "laporan keuangan",
  /** Judul IDX sering full EN / campuran (emiten seperti OBAT, ADRO, dll.) */
  "financial report",
  "financial statements",
  "financial statement",
  "annual report",
  "interim financial",
  "quarterly report",
  "laporan tahunan",
  "laporan interim",
  /** Singkatan LK / triwulan tanpa kata "laporan keuangan" di judul */
  "penyampaian lk",
  "lk triwulan",
  "lk tahunan",
  "lk interim",
  "laporan triwulan",
  "laporan semester",
  "ikhtisar keuangan",
  "ringkasan keuangan",
  "laporan penggunaan dana",
  "laporan informasi",
  "fakta material",
  "informasi atau fakta material",
  "public expose",
  "paparan publik",
  "pemenuhan kewajiban",
  "hasil paparan",
];

/** Judul pengumuman yang mengandung salah satu substring ini diabaikan (PDF tidak diambil). */
export const DEFAULT_EXCLUDE_TITLE_SUBSTRINGS: string[] = [
  "Penyampaian Bukti",
  "Laporan Bulanan Registrasi Pemegang Efek",
  /** Variasi ejaan / redaksi IDX untuk laporan pemegang efek (exclude tidak selalu substring-persis) */
  "registrasi pemegang efek",
  "registrasi kepemilikan efek",
  "Perubahan Alamat/Nomor Telepon/Fax/E-Mail/Website/NPWP/NPKP",
  "Perubahan Nama dan Kawasan Gedung Perkantoran",
  "penunjukan/perubahan kantor akuntan publik",
  "Ringkasan Risalah Rapat umum",
  "konfirmasi emiten grup",
  "penjelasan atas volatilitas transaksi",
  "rencana penyelenggaraan",
  "Pemanggilan rapat umum",
  "Pemberitahuan Rencana Rapat Umum",
  "rencana penyampaian",
  "Pengumuman RUPS",
  "Perubahan Nama",
  "Rencana perubahan status anak perusahaan",
  "pengunduran diri",
];

/** Attachment dengan substring ini akan selalu dilewati. */
const DEFAULT_EXCLUDE_ATTACHMENT_SUBSTRINGS = ["lamp1"];
/** Substring keras di nama file/URL (bukan "penyampaian" mentah — itu membuang PDF laporan keuangan). */
const SKIP_ATTACHMENT_HARD_SUBSTRINGS = [
  "bapepam",
  "pengunduran diri",
  /** Lampiran checklist / daftar periksa (bukan LK) */
  "checklist",
  "daftar periksa",
];
const ALLOW_LAMP1_TITLE_SUBSTRINGS = ["laporan informasi", "fakta material"];

const TITLE_ALLOWS_PENYAMPAIAN_IN_FILENAME = [
  "penyampaian laporan keuangan",
  "laporan keuangan",
  "laporan interim",
  "penyampaian lk",
  "lk tahunan",
  "lk triwulan",
  "lk interim",
  "laporan triwulan",
  "laporan semester",
  "laporan penggunaan dana",
  "laporan informasi",
  "fakta material",
  "public expose",
  "pemenuhan kewajiban",
  "paparan publik",
  "lk audit",
];

function parseEnvExcludeTitleSubstrings(): string[] {
  const raw = typeof process !== "undefined" ? process.env?.IDX_EXCLUDE_TITLE_SUBSTRINGS : undefined;
  if (!raw?.trim()) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseEnvAllowTitleSubstrings(): string[] {
  const raw = typeof process !== "undefined" ? process.env?.IDX_ALLOW_TITLE_SUBSTRINGS : undefined;
  if (!raw?.trim()) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function mergeExcludeTitleSubstrings(...lists: (string[] | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists) {
    if (!list) continue;
    for (const s of list) {
      const t = s.trim();
      if (!t) continue;
      const key = t.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(t);
    }
  }
  return out;
}

function titleIsFinancialLkSubmission(lower: string): boolean {
  if (lower.includes("laporan keuangan")) return true;
  if (lower.includes("laporan interim")) return true;
  if (lower.includes("yang tidak diaudit") || lower.includes("tidak diaudit")) return true;
  if (/\bpenyampaian\s+lk\b/i.test(lower)) return true;
  return false;
}

export function titleMatchesExcludeList(title: string, excludeSubstrings: string[]): boolean {
  const lower = (title || "").toLowerCase();
  for (const ex of excludeSubstrings) {
    const t = ex.trim().toLowerCase();
    if (!t || !lower.includes(t)) continue;
    if (t === "rencana penyampaian" && lower.includes("laporan keuangan")) continue;
    if (t === "penyampaian bukti" && titleIsFinancialLkSubmission(lower)) continue;
    return true;
  }
  return false;
}

export function mergeAllowTitleSubstrings(...lists: (string[] | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists) {
    if (!list) continue;
    for (const s of list) {
      const t = s.trim();
      if (!t) continue;
      const key = t.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(t);
    }
  }
  return out;
}

/** Judul lolos filter allowlist (salah satu frasa wajib ada). */
export function titleMatchesAllowList(title: string, allowSubstrings: string[]): boolean {
  const lower = title.toLowerCase();
  return allowSubstrings.some((p) => lower.includes(p.trim().toLowerCase()));
}

const ALLOWLIST_REJECT_LABEL = "(di luar kategori judul yang diproses)";

/** Frasa pengecualian pertama yang cocok dengan judul (untuk ditampilkan di daftar terlewati). */
export function firstMatchingExcludeSubstring(
  title: string,
  excludeSubstrings: string[]
): string {
  const lower = (title || "").toLowerCase();
  for (const ex of excludeSubstrings) {
    const t = ex.trim().toLowerCase();
    if (!t || !lower.includes(t)) continue;
    if (t === "rencana penyampaian" && lower.includes("laporan keuangan")) continue;
    if (t === "penyampaian bukti" && titleIsFinancialLkSubmission(lower)) continue;
    return ex.trim();
  }
  return "";
}

export type IdxExcludedAnnouncementRow = {
  title: string;
  publishedAt: string;
  /** Frasa dari daftar pengecualian yang cocok dengan judul */
  matchedExclude: string;
};

function resolveExcludeTitleSubstrings(extra?: string[]): string[] {
  return mergeExcludeTitleSubstrings(
    DEFAULT_EXCLUDE_TITLE_SUBSTRINGS,
    parseEnvExcludeTitleSubstrings(),
    extra
  );
}

function resolveAllowTitleSubstrings(extra?: string[]): string[] {
  return mergeAllowTitleSubstrings(
    DEFAULT_ALLOW_TITLE_SUBSTRINGS,
    parseEnvAllowTitleSubstrings(),
    extra
  );
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPdf(nameOrUrl: string): boolean {
  return /\.pdf(\?|$)/i.test(nameOrUrl);
}

function titleAllowsLamp1(title: string): boolean {
  const lowerTitle = title.toLowerCase();
  return ALLOW_LAMP1_TITLE_SUBSTRINGS.some((k) => lowerTitle.includes(k));
}

function titleAllowsPenyampaianFilename(title: string): boolean {
  const lt = (title || "").toLowerCase();
  return TITLE_ALLOWS_PENYAMPAIAN_IN_FILENAME.some((p) => lt.includes(p));
}

function shouldSkipAttachment(nameOrUrl: string, title: string): boolean {
  const lower = nameOrUrl.toLowerCase();
  if (lower.includes("lamp1") && titleAllowsLamp1(title)) return false;
  if (SKIP_ATTACHMENT_HARD_SUBSTRINGS.some((k) => lower.includes(k))) return true;
  if (lower.includes("penyampaian")) {
    if (titleAllowsPenyampaianFilename(title)) return false;
    return true;
  }
  return DEFAULT_EXCLUDE_ATTACHMENT_SUBSTRINGS.some((k) => lower.includes(k));
}

function pdfBasenameFromUrl(url: string): string {
  try {
    const u = new URL(String(url).trim());
    const seg = decodeURIComponent(u.pathname.split("/").pop() || "");
    if (/\.pdf$/i.test(seg)) return seg;
  } catch {
    /* ignore */
  }
  return "";
}

/** OriginalFilename; jika kosong, basename .pdf dari URL (selaras Python — IDX sering kosongkan nama untuk PDF utama). */
export function idxSaveFileNameFromAttachment(
  attachment: IdxAttachmentRaw,
  fullSavePathUrl: string
): string {
  const orig = String(attachment.OriginalFilename ?? "").trim();
  if (orig) return orig;
  return pdfBasenameFromUrl(fullSavePathUrl);
}

/** Nama efektif untuk heuristik pilih lampiran (sama seperti idxSaveFileNameFromAttachment). */
export function effectiveIdxPickFileName(fileName: string, url: string): string {
  const t = (fileName || "").trim();
  if (t) return t;
  return pdfBasenameFromUrl(url);
}

/** Satu blok output per pengumuman (satu baris PDF) — untuk UI / API / copy-paste. */
export function formatIdxAnnouncementOutputBlock(args: {
  pengumuman: string;
  date: string;
  outputPdf: string;
}): string {
  const pengumuman = args.pengumuman.trim();
  const date = args.date.trim();
  const outputPdf = args.outputPdf.trim();
  return `{Pengumuman: ${pengumuman}\nDate: ${date}\nOutput PDF: ${outputPdf}}`;
}

function toDateYmd(input: string): string {
  const t = input.trim();
  if (/^\d{8}$/.test(t)) return t;
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return "";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

const IDX_ANNOUNCEMENT_PAGE_SIZE = 100;
/** Batas keamanan: banyak emiten punya ribuan pengumuman sejarah */
const IDX_ANNOUNCEMENT_MAX_PAGES = 50;

function buildIdxAnnouncementUrl(args: {
  kodeEmiten: string;
  dateFrom: string;
  dateTo: string;
  indexFrom: number;
  pageSize: number;
  host: "idx" | "www";
  langSuffix: "id" | "id-id";
}): string {
  const h = args.host === "www" ? "https://www.idx.co.id" : "https://idx.co.id";
  const params = `kodeEmiten=${encodeURIComponent(
    args.kodeEmiten
  )}&emitenType=*&indexFrom=${args.indexFrom}&pageSize=${args.pageSize}&dateFrom=${args.dateFrom}&dateTo=${args.dateTo}&keyword=`;
  return `${h}/primary/ListedCompany/GetAnnouncement?${params}&lang=${args.langSuffix}`;
}

export async function fetchIdxAnnouncements(args: {
  kodeEmiten: string;
  dateFrom?: string;
  dateTo?: string;
}): Promise<IdxReplyRaw[]> {
  const kode = args.kodeEmiten.trim().toUpperCase();
  if (!kode) throw new Error("kodeEmiten is required");

  const dateFrom = toDateYmd(args.dateFrom || "") || "19010101";
  const dateTo = toDateYmd(args.dateTo || "") || toDateYmd(new Date().toISOString());
  const pageSize = IDX_ANNOUNCEMENT_PAGE_SIZE;

  const endpointCandidates: { host: "idx" | "www"; langSuffix: "id" | "id-id" }[] = [
    { host: "idx", langSuffix: "id" },
    { host: "idx", langSuffix: "id-id" },
    { host: "www", langSuffix: "id" },
    { host: "www", langSuffix: "id-id" },
  ];

  let lastErr: unknown = null;
  let saw403 = false;

  for (const ep of endpointCandidates) {
    const refererHost =
      ep.host === "www"
        ? "https://www.idx.co.id/id/perusahaan-tercatat/keterbukaan-informasi/"
        : "https://idx.co.id/id/perusahaan-tercatat/keterbukaan-informasi/";
    const originHost = ep.host === "www" ? "https://www.idx.co.id" : "https://idx.co.id";

    for (let i = 0; i < 2; i++) {
      try {
        const allReplies: IdxReplyRaw[] = [];
        let indexFrom = 0;
        let resultCount: number | null = null;

        for (let page = 0; page < IDX_ANNOUNCEMENT_MAX_PAGES; page++) {
          const url = buildIdxAnnouncementUrl({
            kodeEmiten: kode,
            dateFrom,
            dateTo,
            indexFrom,
            pageSize,
            host: ep.host,
            langSuffix: ep.langSuffix,
          });

          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 12000);
          const res = await fetch(url, {
            method: "GET",
            headers: {
              "User-Agent":
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
              Accept: "application/json, text/plain, */*",
              "Accept-Language": "id-ID,id;q=0.9,en;q=0.8",
              Referer: refererHost,
              Origin: originHost,
              "X-Requested-With": "XMLHttpRequest",
            },
            signal: controller.signal,
          });
          clearTimeout(timeout);

          console.log(`[IDX] GetAnnouncement attempt url=${url} status=${res.status}`);
          if (res.status === 403) {
            saw403 = true;
            throw new Error("IDX API failed: 403");
          }
          if (!res.ok) {
            throw new Error(`IDX API failed: ${res.status}`);
          }
          const data = (await res.json()) as IdxApiResponse;
          const chunk = data.Replies || [];
          if (resultCount === null && typeof data.ResultCount === "number") {
            resultCount = data.ResultCount;
          }
          allReplies.push(...chunk);

          const firstTitle = String(chunk[0]?.pengumuman?.JudulPengumuman || "").trim();
          console.log(
            "[IDX] GetAnnouncement page:",
            JSON.stringify(
              {
                indexFrom,
                resultCount: data.ResultCount ?? null,
                chunkCount: chunk.length,
                firstTitle,
                totalLoaded: allReplies.length,
              },
              null,
              2
            )
          );

          if (chunk.length < pageSize) break;
          indexFrom += pageSize;
          if (resultCount !== null && indexFrom >= resultCount) break;
        }

        return allReplies;
      } catch (e) {
        lastErr = e;
        await sleep(500 * (i + 1));
      }
    }
  }

  if (saw403) {
    throw new Error(
      "IDX API blocked (403). IP/server likely challenged by Cloudflare; try from different network/VPS or allowlist path."
    );
  }
  const msg = lastErr instanceof Error ? lastErr.message : "Failed to fetch IDX data";
  throw new Error(msg);
}

export function extractIdxPdfAttachments(
  replies: IdxReplyRaw[],
  keywords: string[] = DEFAULT_KEYWORDS,
  options?: { excludeTitleSubstrings?: string[]; allowTitleSubstrings?: string[] }
): {
  groups: IdxAnnouncementPdfGroup[];
  excludedAnnouncementsCount: number;
  excludedAnnouncements: IdxExcludedAnnouncementRow[];
} {
  const normalized = keywords.map((k) => k.trim().toLowerCase()).filter(Boolean);
  const excludeList = resolveExcludeTitleSubstrings(options?.excludeTitleSubstrings);
  const allowList = resolveAllowTitleSubstrings(options?.allowTitleSubstrings);
  const groups: IdxAnnouncementPdfGroup[] = [];
  let excludedAnnouncementsCount = 0;
  const excludedAnnouncements: IdxExcludedAnnouncementRow[] = [];

  for (const r of replies) {
    const title = String(r.pengumuman?.JudulPengumuman || "").trim();
    const publishedAt = String(r.pengumuman?.TglPengumuman || "");
    if (titleMatchesExcludeList(title, excludeList)) {
      excludedAnnouncementsCount += 1;
      excludedAnnouncements.push({
        title,
        publishedAt,
        matchedExclude: firstMatchingExcludeSubstring(title, excludeList),
      });
      continue;
    }
    if (!titleMatchesAllowList(title, allowList)) {
      excludedAnnouncementsCount += 1;
      excludedAnnouncements.push({
        title,
        publishedAt,
        matchedExclude: ALLOWLIST_REJECT_LABEL,
      });
      continue;
    }
    const lowerTitle = title.toLowerCase();
    const keywordMatched =
      normalized.length === 0 || normalized.some((k) => lowerTitle.includes(k));
    if (!keywordMatched) continue;

    const groupCandidates: IdxAttachmentCandidate[] = [];
    for (const a of r.attachments || []) {
      if (a.IsAttachment !== true) continue;
      const url = String(a.FullSavePath || "").trim();
      const fileName = idxSaveFileNameFromAttachment(a, url);
      if (!url) continue;
      if (!isPdf(url) && !isPdf(fileName)) continue;
      if (shouldSkipAttachment(fileName, title) || shouldSkipAttachment(url, title)) continue;
      groupCandidates.push({ title, publishedAt, fileName, url });
    }
    if (groupCandidates.length > 0) {
      groups.push({ title, publishedAt, candidates: groupCandidates });
    }
  }
  return { groups, excludedAnnouncementsCount, excludedAnnouncements };
}

function idxPdfProbeHeaders(url: string): Record<string, string> {
  const base = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    Accept: "application/pdf,*/*",
  };
  if (/idx\.co\.id/i.test(url)) {
    return {
      ...base,
      Referer: "https://www.idx.co.id/",
      Origin: "https://www.idx.co.id",
    };
  }
  return base;
}

function parseContentLengthHeader(h: Headers): number {
  const raw = h.get("content-length")?.trim();
  if (!raw || !/^\d+$/.test(raw)) return -1;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : -1;
}

export async function probeAttachmentSize(url: string): Promise<number> {
  const base = idxPdfProbeHeaders(url);
  const headerVariants = [base, { ...base, "Accept-Encoding": "identity" }];

  for (const h of headerVariants) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 12000);
      const res = await fetch(url, { method: "HEAD", headers: h, signal: controller.signal });
      clearTimeout(timeout);
      const n = parseContentLengthHeader(res.headers);
      if (n > 0) return n;
    } catch {
      // ignore
    }
  }

  for (const h of headerVariants) {
    for (const rangeVal of ["bytes=0-0", "bytes=0-16383"] as const) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 28000);
        const res = await fetch(url, {
          method: "GET",
          headers: { ...h, Range: rangeVal },
          signal: controller.signal,
        });
        clearTimeout(timeout);
        const cr = res.headers.get("content-range");
        if (cr && /\/(\d+)$/.test(cr)) {
          const m = cr.match(/\/(\d+)$/);
          if (m) {
            const total = Number(m[1]);
            if (Number.isFinite(total) && total > 0) {
              try {
                await res.arrayBuffer();
              } catch {
                // ignore
              }
              return total;
            }
          }
        }
        const n = parseContentLengthHeader(res.headers);
        if (n > 0) {
          try {
            await res.arrayBuffer();
          } catch {
            // ignore
          }
          return n;
        }
      } catch {
        // ignore
      }
    }
  }

  return -1;
}

/** Laporan keuangan / FS utama — bukan surat Penyampaian LK cover. */
export function isPrimaryFinancialPdfName(fileName: string): boolean {
  const n = (fileName || "").toLowerCase();
  if (n.includes("final report") || n.includes("final_report")) return true;
  if (
    n.includes("consolidated") &&
    (n.includes("report") || n.includes("financial") || /\bcas\b/.test(n))
  )
    return true;
  if (n.includes("consolidated") && /(sept|oct|nov|dec|jan|feb|mar|apr|may|jun|jul|aug)/.test(n))
    return true;
  if (n.includes("financialstatement") || n.includes("financial statement")) return true;
  if (
    n.includes("laporan keuangan") &&
    (n.includes("audited") || n.includes("audit") || n.includes("konsolid"))
  )
    return true;
  return false;
}

/** Bulan ID lengkap + singkatan EN; "maret" harus ada (bukan hanya \bmar\b di dalam kata lain). */
const IDX_MONTH_SHORT_YEAR_RE =
  /\b(?:januari|februari|maret|april|mei|juni|juli|agustus|september|oktober|november|desember|jan|feb|mar|apr|may|jun|jul|agu|aug|sep|sept|oct|okt|nov|dec)\b[.\s_-]*(?:20)?\d{2}\b/i;

/** Bulan Indonesia + tahun 4 digit dengan teks di antaranya (mis. "MSTI Maret 2025"). */
const IDX_ID_MONTH_FULL_YEAR_RE =
  /\b(?:januari|februari|maret|april|mei|juni|juli|agustus|september|oktober|november|desember)\b[^0-9]{0,120}\b20\d{2}\b/i;

/** Mis. OBAT SEP 2025.pdf — selaras is_en_month_year_lk_style_pdf di Python. */
const IDX_EN_MONTH_YEAR_LK_RE =
  /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|okt|nov|dec)\b[\s._-]*20\d{2}\b/i;

const IDX_MONTH_PENALTY_EXEMPT_RE =
  /\b(tahunan|triwulan|annual|kuartal|konsolid|consolidated|audit|interim|q1|q2|q3|q4)\b/i;

function heuristicBonus(fileName: string, url: string): number {
  const f = idxAttachmentBlobLower(fileName, url);
  let s = 0;
  if (f.includes("checklist") || f.includes("daftar periksa")) s -= 900;
  if (f.includes("billingual") || f.includes("bilingual")) s += 500;
  if (f.includes("final report") || f.includes("final_report")) s += 400;
  if (f.includes("consolidated")) s += 350;
  if (f.includes("financialstatement")) s += 200;
  if (f.includes("public expose")) s += 100;
  if (f.includes("lamp")) s -= 50;
  if (f.includes("penyampaian") && (f.includes("lkq") || /\blk[1-4]\b/.test(f))) s -= 600;
  if (/cover[\s_-]+letter/i.test(f)) s -= 650;
  if (/\bpernyataan\s+direksi\b/i.test(f) || /\bpernyataan\s+komisaris\b/i.test(f)) s -= 580;
  if (f.includes("surat pernyataan")) s -= 560;
  if (f.includes("kenaikan aset") && f.includes("penjelasan")) s -= 570;
  if (/\bpenjelasan\s+atas\s+volatilitas\b/i.test(f)) s -= 570;
  if (/\.fa\.\d+/i.test(f)) s -= 500;
  if (/\blap\.?\s*keu\b/i.test(f)) s -= 450;
  if (
    f.includes("penyampaian laporan keuangan") &&
    !/\b(tahunan|triwulan|kuartal|konsolid|consolidated|audited|audit|financial statement)\b/i.test(f)
  ) {
    s -= 520;
  }
  if (
    (IDX_MONTH_SHORT_YEAR_RE.test(f) || IDX_ID_MONTH_FULL_YEAR_RE.test(f)) &&
    !IDX_MONTH_PENALTY_EXEMPT_RE.test(f) &&
    !(/\breport\b/i.test(f) && !f.includes("laporan keuangan"))
  ) {
    s -= 400;
  }
  return s;
}

function idxAttachmentBlobLower(fileName: string, url: string): string {
  let pathPart = "";
  try {
    pathPart = decodeURIComponent(new URL(url.trim()).pathname).toLowerCase();
  } catch {
    /* ignore */
  }
  return `${effectiveIdxPickFileName(fileName, url).toLowerCase()} ${pathPart}`;
}

function isPenjelasan20PersenIdxPdfName(fileName: string, url: string): boolean {
  const blob = idxAttachmentBlobLower(fileName, url);
  if (!blob.includes("penjelasan")) return false;
  if (!blob.includes("persen") && !blob.includes("percent")) return false;
  return /\b20\b|20%/i.test(blob);
}

function isEnMonthYearLkStyleIdxPdfName(fileName: string, url: string): boolean {
  const blob = idxAttachmentBlobLower(fileName, url);
  if (!IDX_EN_MONTH_YEAR_LK_RE.test(blob)) return false;
  if (isPenjelasan20PersenIdxPdfName(fileName, url)) return false;
  return true;
}

/** Surat penyampaian triwulan / cover letter (bukan FS utama). Jangan dipilih jika ada lampiran lain. */
export function isCoverLetterIdxPdfName(c: IdxAttachmentCandidate): boolean {
  const blob = idxAttachmentBlobLower(c.fileName, c.url);
  if (/cover[\s_-]+letter/i.test(blob)) return true;
  if (!blob.includes("penyampaian")) return false;
  if (blob.includes("lkq")) return true;
  if (/\blk\s*q?\s*[1-4]\b/i.test(blob)) return true;
  if (/\bpenyampaian[\s_-]+lk\b/i.test(blob)) return true;
  return false;
}

/** Ringkasan OJK (.FA.), Lap Keu singkat, Jun24, surat penyampaian LK tanpa audited/konsolid, dll. */
export function isSupplementalThinLkIdxPdfName(c: IdxAttachmentCandidate): boolean {
  const blob = idxAttachmentBlobLower(c.fileName, c.url);
  if (blob.includes("checklist") || blob.includes("daftar periksa")) return true;
  if (
    /consolidated|konsolid|audited|tahunan|annual|triwulan|kuartal|financial statement|final report|interim/i.test(
      blob
    )
  ) {
    return false;
  }
  if (/\breport\b/i.test(blob) && !blob.includes("laporan keuangan")) return false;
  if (/\bpernyataan\s+direksi\b/i.test(blob)) return true;
  if (/\bpernyataan\s+komisaris\b/i.test(blob)) return true;
  if (blob.includes("surat pernyataan")) return true;
  if (/\bstatement\s+of\s+directors?\b/i.test(blob)) return true;
  if (blob.includes("kenaikan aset") && blob.includes("penjelasan")) return true;
  if (/\bpenjelasan\s+atas\s+volatilitas\b/i.test(blob)) return true;
  if (/\.fa\.\d+/i.test(blob)) return true;
  if (/\blap\.?\s*keu\b/i.test(blob)) return true;
  if (blob.includes("penyampaian laporan keuangan")) return true;
  if (IDX_MONTH_SHORT_YEAR_RE.test(blob)) return true;
  if (IDX_ID_MONTH_FULL_YEAR_RE.test(blob)) return true;
  return false;
}

function overrideThinIfLargerNonThin(
  pool1Probed: IdxSizedAttachment[],
  selected: IdxSizedAttachment | null
): IdxSizedAttachment | null {
  if (!selected) return null;
  if (!isSupplementalThinLkIdxPdfName(selected)) return selected;
  const wsz = selected.sizeBytes;
  let best: IdxSizedAttachment | null = null;
  let bestSz = -1;
  for (const x of pool1Probed) {
    if (isSupplementalThinLkIdxPdfName(x)) continue;
    if (x.sizeBytes > bestSz) {
      bestSz = x.sizeBytes;
      best = x;
    }
  }
  if (best && bestSz > 0 && (wsz < 0 || bestSz > wsz)) return best;
  return selected;
}

/**
 * Pilih satu lampiran per pengumuman: setelah buang cover (bila ada alternatif),
 * prioritas tertinggi = ukuran terprobesi terbesar; nama file hanya tie-break / fallback.
 */
export async function pickLargestIdxAttachment(
  candidates: IdxAttachmentCandidate[]
): Promise<{
  selected: IdxSizedAttachment | null;
  /** Penjelasan 20 Persen + pola LK EN bulan+tahun (mis. OBAT SEP 2025.pdf), beda URL dari selected. */
  extras: IdxSizedAttachment[];
  sizedCount: number;
  failedCount: number;
  all: IdxSizedAttachment[];
}> {
  if (candidates.length === 0) {
    return { selected: null, extras: [], sizedCount: 0, failedCount: 0, all: [] };
  }

  const nonCover = candidates.filter((c) => !isCoverLetterIdxPdfName(c));
  const pool1 = nonCover.length > 0 ? nonCover : candidates;
  const nonThin = pool1.filter((c) => !isSupplementalThinLkIdxPdfName(c));
  const pool = nonThin.length > 0 ? nonThin : pool1;

  const all: IdxSizedAttachment[] = [];
  for (const c of pool1) {
    const sizeBytes = await probeAttachmentSize(c.url);
    all.push({ ...c, sizeBytes });
  }

  const poolUrl = new Set(pool.map((c) => c.url.trim()));
  const pickList = all.filter((x) => poolUrl.has(x.url.trim()));

  const sizedCount = all.filter((x) => x.sizeBytes >= 0).length;
  const failedCount = all.length - sizedCount;

  let selected: IdxSizedAttachment | null = null;
  if (pickList.length === 1) {
    selected = pickList[0] ?? null;
  } else {
    const measured = pickList.filter((x) => x.sizeBytes >= 0);
    if (measured.length > 0) {
      const sortedMeasured = [...measured].sort((a, b) => {
        if (b.sizeBytes !== a.sizeBytes) return b.sizeBytes - a.sizeBytes;
        return heuristicBonus(b.fileName, b.url) - heuristicBonus(a.fileName, a.url);
      });
      const bestMeasured = sortedMeasured[0] ?? null;
      const maxSz = Math.max(...measured.map((x) => x.sizeBytes));
      const unmeas = pickList.filter((x) => x.sizeBytes < 0);
      const suspectSmall = 550_000;
      const hbGap = 400;
      if (bestMeasured && maxSz < suspectSmall && unmeas.length > 0) {
        const bestU = [...unmeas].sort(
          (a, b) => heuristicBonus(b.fileName, b.url) - heuristicBonus(a.fileName, a.url)
        )[0];
        if (bestU) {
          const hbP = heuristicBonus(bestMeasured.fileName, bestMeasured.url);
          const hbU = heuristicBonus(bestU.fileName, bestU.url);
          if (hbU >= hbP + hbGap) {
            selected = { ...bestU, sizeBytes: -1 };
          } else {
            selected = bestMeasured;
          }
        } else {
          selected = bestMeasured;
        }
      } else {
        selected = bestMeasured;
      }
    } else {
      selected =
        [...pickList].sort((a, b) => {
          const ha = heuristicBonus(a.fileName, a.url);
          const hb = heuristicBonus(b.fileName, b.url);
          if (hb !== ha) return hb - ha;
          return 0;
        })[0] ?? null;
    }
  }

  selected = overrideThinIfLargerNonThin(all, selected);

  const extras: IdxSizedAttachment[] = [];
  if (selected) {
    const selUrl = selected.url.trim();
    const seen = new Set<string>();
    for (const c of all) {
      const u = c.url.trim();
      if (!u || u === selUrl || seen.has(u)) continue;
      if (
        isPenjelasan20PersenIdxPdfName(c.fileName, c.url) ||
        isEnMonthYearLkStyleIdxPdfName(c.fileName, c.url)
      ) {
        seen.add(u);
        extras.push(c);
      }
    }
    extras.sort((a, b) =>
      effectiveIdxPickFileName(a.fileName, a.url).localeCompare(
        effectiveIdxPickFileName(b.fileName, b.url),
        undefined,
        { sensitivity: "base" }
      )
    );
  }

  return { selected, extras, sizedCount, failedCount, all };
}

export async function pickLargestIdxAttachmentPerAnnouncement(groups: IdxAnnouncementPdfGroup[]): Promise<
  {
    title: string;
    publishedAt: string;
    selected: IdxSizedAttachment | null;
    extras: IdxSizedAttachment[];
    sizedCount: number;
    failedCount: number;
    candidatesInAnnouncement: number;
  }[]
> {
  const out: {
    title: string;
    publishedAt: string;
    selected: IdxSizedAttachment | null;
    extras: IdxSizedAttachment[];
    sizedCount: number;
    failedCount: number;
    candidatesInAnnouncement: number;
  }[] = [];

  for (const g of groups) {
    const { selected, extras, sizedCount, failedCount } = await pickLargestIdxAttachment(
      g.candidates
    );
    out.push({
      title: g.title,
      publishedAt: g.publishedAt,
      selected,
      extras,
      sizedCount,
      failedCount,
      candidatesInAnnouncement: g.candidates.length,
    });
  }

  return out;
}

