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

const DEFAULT_KEYWORDS = ["penyampaian laporan keuangan", "public expose"];

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPdf(nameOrUrl: string): boolean {
  return /\.pdf(\?|$)/i.test(nameOrUrl);
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

export async function fetchIdxAnnouncements(args: {
  kodeEmiten: string;
  dateFrom?: string;
  dateTo?: string;
}): Promise<IdxReplyRaw[]> {
  const kode = args.kodeEmiten.trim().toUpperCase();
  if (!kode) throw new Error("kodeEmiten is required");

  const dateFrom = toDateYmd(args.dateFrom || "") || "19010101";
  const dateTo = toDateYmd(args.dateTo || "") || toDateYmd(new Date().toISOString());
  const baseParams = `kodeEmiten=${encodeURIComponent(
    kode
  )}&emitenType=*&indexFrom=0&pageSize=100&dateFrom=${dateFrom}&dateTo=${dateTo}&keyword=`;
  const urls = [
    `https://idx.co.id/primary/ListedCompany/GetAnnouncement?${baseParams}&lang=id`,
    `https://idx.co.id/primary/ListedCompany/GetAnnouncement?${baseParams}&lang=id-id`,
    `https://www.idx.co.id/primary/ListedCompany/GetAnnouncement?${baseParams}&lang=id`,
    `https://www.idx.co.id/primary/ListedCompany/GetAnnouncement?${baseParams}&lang=id-id`,
  ];

  let lastErr: unknown = null;
  let saw403 = false;

  for (const url of urls) {
    const refererHost = url.includes("://www.idx.co.id")
      ? "https://www.idx.co.id/id/perusahaan-tercatat/keterbukaan-informasi/"
      : "https://idx.co.id/id/perusahaan-tercatat/keterbukaan-informasi/";
    const originHost = url.includes("://www.idx.co.id")
      ? "https://www.idx.co.id"
      : "https://idx.co.id";

    for (let i = 0; i < 2; i++) {
      try {
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
        const replies = data.Replies || [];
        const firstTitle = String(
          replies[0]?.pengumuman?.JudulPengumuman || ""
        ).trim();
        console.log(
          "[IDX] GetAnnouncement parsed:",
          JSON.stringify(
            {
              resultCount: data.ResultCount ?? null,
              repliesCount: replies.length,
              firstTitle,
            },
            null,
            2
          )
        );
        return replies;
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
  keywords: string[] = DEFAULT_KEYWORDS
): IdxAttachmentCandidate[] {
  const normalized = keywords.map((k) => k.trim().toLowerCase()).filter(Boolean);
  const out: IdxAttachmentCandidate[] = [];
  for (const r of replies) {
    const title = String(r.pengumuman?.JudulPengumuman || "").trim();
    const lowerTitle = title.toLowerCase();
    if (!normalized.some((k) => lowerTitle.includes(k))) continue;

    const publishedAt = String(r.pengumuman?.TglPengumuman || "");
    for (const a of r.attachments || []) {
      if (a.IsAttachment !== true) continue;
      const url = String(a.FullSavePath || "").trim();
      const fileName = String(a.OriginalFilename || a.PDFFilename || "").trim();
      if (!url) continue;
      if (!isPdf(url) && !isPdf(fileName)) continue;
      out.push({ title, publishedAt, fileName: fileName || url, url });
    }
  }
  return out;
}

export async function probeAttachmentSize(url: string): Promise<number> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(url, {
      method: "HEAD",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        Accept: "*/*",
      },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const len = res.headers.get("content-length");
    if (len) return Number(len);
  } catch {
    // ignore and fallback
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Range: "bytes=0-0",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const cr = res.headers.get("content-range");
    if (cr && /\/(\d+)$/.test(cr)) {
      const m = cr.match(/\/(\d+)$/);
      if (m) return Number(m[1]);
    }
  } catch {
    // ignore
  }

  return -1;
}

function heuristicBonus(fileName: string): number {
  const f = fileName.toLowerCase();
  let s = 0;
  if (f.includes("billingual") || f.includes("bilingual")) s += 500;
  if (f.includes("financialstatement")) s += 200;
  if (f.includes("public expose")) s += 100;
  if (f.includes("lamp")) s -= 50;
  return s;
}

export async function pickLargestIdxAttachment(
  candidates: IdxAttachmentCandidate[]
): Promise<{
  selected: IdxSizedAttachment | null;
  sizedCount: number;
  failedCount: number;
  all: IdxSizedAttachment[];
}> {
  const all: IdxSizedAttachment[] = [];
  for (const c of candidates) {
    const sizeBytes = await probeAttachmentSize(c.url);
    all.push({ ...c, sizeBytes });
  }

  const sizedCount = all.filter((x) => x.sizeBytes >= 0).length;
  const failedCount = all.length - sizedCount;

  const selected =
    [...all].sort((a, b) => {
      const aScore =
        (a.sizeBytes >= 0 ? a.sizeBytes / 1_000_000 : 0) + heuristicBonus(a.fileName);
      const bScore =
        (b.sizeBytes >= 0 ? b.sizeBytes / 1_000_000 : 0) + heuristicBonus(b.fileName);
      return bScore - aScore;
    })[0] || null;

  return { selected, sizedCount, failedCount, all };
}

