import { chatCompletionJson } from "./openrouter";

export async function inferDocumentName(args: {
  originalFileName: string;
  textSample: string;
}): Promise<{ suggestedFileName: string | null; confidence: number }> {
  const originalBase = args.originalFileName.replace(/\.[^/.]+$/, "");

  // Heuristics first: reduce misclassification risk for common document types.
  const lowerBase = originalBase.toLowerCase();
  const lowerText = args.textSample.toLowerCase();
  const hasPublicExpose =
    /public\s*(expose|exposure)|paparan\s*publik|expose\s*publik/.test(
      lowerBase
    ) ||
    /public\s*(expose|exposure)|paparan\s*publik|expose\s*publik/.test(
      lowerText
    );
  const hasQnAPublicExpose =
    (/(qna|q\s*&\s*a|q&a|tanya\s*jawab|question\s*and\s*answer)/i.test(
      lowerBase
    ) ||
      /(qna|q\s*&\s*a|q&a|tanya\s*jawab|question\s*and\s*answer)/i.test(
        lowerText
      )) &&
      hasPublicExpose;

  const extractYear = (s: string): string | null => {
    const m = s.match(/(?:19|20)\d{2}/);
    return m ? m[0] : null;
  };

  const MONTHS_ID: Record<string, string> = {
    januari: "Januari",
    jan: "Januari",
    februar: "Februari",
    februari: "Februari",
    feb: "Februari",
    maret: "Maret",
    mar: "Maret",
    april: "April",
    apr: "April",
    mei: "Mei",
    june: "Juni",
    juni: "Juni",
    jun: "Juni",
    july: "Juli",
    juli: "Juli",
    jul: "Juli",
    agustus: "Agustus",
    august: "Agustus",
    aug: "Agustus",
    september: "September",
    sep: "September",
    oktober: "Oktober",
    okt: "Oktober",
    october: "Oktober",
    nov: "November",
    november: "November",
    desember: "Desember",
    dec: "Desember",
    december: "Desember",
  };

  const MONTHS_NUM: Record<string, string> = {
    "1": "Januari",
    "2": "Februari",
    "3": "Maret",
    "4": "April",
    "5": "Mei",
    "6": "Juni",
    "7": "Juli",
    "8": "Agustus",
    "9": "September",
    "10": "Oktober",
    "11": "November",
    "12": "Desember",
  };

  const extractMonthName = (s: string): string | null => {
    const keys = Object.keys(MONTHS_ID).sort((a, b) => b.length - a.length);
    for (const k of keys) {
      const re = new RegExp(`\\b${k}\\b`, "i");
      if (re.test(s)) return MONTHS_ID[k];
    }
    // Fallback: numeric month (only when preceded by "bulan"/"month").
    const mNum = s.match(/(?:bulan|month)\s*(?:ke-)?\s*(1[0-2]|0?[1-9])\b/i);
    if (mNum) {
      const n = String(parseInt(mNum[1], 10));
      return MONTHS_NUM[n] ?? null;
    }
    return null;
  };

  const extractQuarter = (s: string): string | null => {
    const m1 = s.match(/\btriwulan\s*([1-4])\b/i);
    if (m1) return `Q${m1[1]}`;
    const m2 = s.match(/\bQ\s*([1-4])\b/i);
    if (m2) return `Q${m2[1]}`;
    return null;
  };

  if (hasPublicExpose) {
    const year = extractYear(args.textSample) ?? extractYear(originalBase);
    const month =
      extractMonthName(args.textSample) ?? extractMonthName(originalBase);

    // Without a year, avoid forcing an incorrect rename.
    if (!year) return { suggestedFileName: null, confidence: 0.0 };

    if (hasQnAPublicExpose) {
      const suggestedFileName = month
        ? `Q&A Paparan Publik ${month} ${year}`
        : `Q&A Paparan Publik ${year}`;
      return { suggestedFileName, confidence: 0.98 };
    }

    const suggestedFileName = month
      ? `Paparan Publik ${month} ${year}`
      : `Paparan Publik ${year}`;
    return { suggestedFileName, confidence: 0.95 };
  }

  const year = extractYear(args.textSample) ?? extractYear(originalBase);
  const month =
    extractMonthName(args.textSample) ?? extractMonthName(originalBase);
  const quarter =
    extractQuarter(args.textSample) ?? extractQuarter(originalBase);

  const hasFinancial =
    /(laporan\s*keuangan|financial\s*statement|financial\s*report)/i.test(
      lowerText
    ) || /(laporan\s*keuangan|financial\s*statement|financial\s*report)/i.test(lowerBase);

  const hasMaterialFacts =
    /(laporan\s*fakta\s*material|fakta\s*material|material\s*facts)/i.test(
      lowerText
    ) || /(laporan\s*fakta\s*material|fakta\s*material|material\s*facts)/i.test(lowerBase);

  const hasAnnualReport =
    /(annual\s*report|laporan\s*tahunan)/i.test(lowerText) ||
    /(annual\s*report|laporan\s*tahunan)/i.test(lowerBase);

  const hasCorporatePresentation =
    /(corporate\s*presentation|company\s*presentation|presentasi\s*korporat|investor\s*presentation)/i.test(
      lowerText
    ) ||
    /(corporate\s*presentation|company\s*presentation|presentasi\s*korporat|investor\s*presentation)/i.test(
      lowerBase
    );

  const hasTranscriptYoutube =
    /(transkrip|transcript)/i.test(lowerText) &&
    /(youtube|yt)/i.test(lowerText);

  const hasResearchSecurities =
    /(sekuritas|securities|research\s*report|equity\s*research|analyst)/i.test(
      lowerText
    ) || /(sekuritas|securities|research\s*report|equity\s*research|analyst)/i.test(lowerBase);

  const isMonthly = /(bulanan|monthly)/i.test(lowerText) || /(bulanan|monthly)/i.test(lowerBase);
  const isAnnual = /(tahunan|annual)/i.test(lowerText) || /(tahunan|annual)/i.test(lowerBase);
  const isQuarterly =
    /(triwulan|quarterly)/i.test(lowerText) ||
    /(triwulan|quarterly)/i.test(lowerBase);

  // Laporan keuangan bulanan/tahunan/triwulan
  if (hasFinancial && year) {
    if (isMonthly) {
      const suggestedFileName = month
        ? `Laporan Keuangan Bulanan ${month} ${year}`
        : `Laporan Keuangan Bulanan ${year}`;
      return { suggestedFileName, confidence: 0.95 };
    }
    if (isQuarterly) {
      const suggestedFileName = quarter
        ? `Laporan Keuangan Triwulanan ${year} ${quarter}`
        : `Laporan Keuangan Triwulanan ${year}`;
      return { suggestedFileName, confidence: 0.95 };
    }
    if (isAnnual) {
      const suggestedFileName = `Laporan Keuangan Tahunan ${year}`;
      return { suggestedFileName, confidence: 0.95 };
    }

    // Fallback: if periodicity keywords are missing, use quarter/month if present.
    if (quarter) {
      return {
        suggestedFileName: `Laporan Keuangan Triwulanan ${year} ${quarter}`,
        confidence: 0.92,
      };
    }
    if (month) {
      return {
        suggestedFileName: `Laporan Keuangan Bulanan ${month} ${year}`,
        confidence: 0.92,
      };
    }
    return { suggestedFileName: `Laporan Keuangan ${year}`, confidence: 0.9 };
  }

  // Laporan Fakta Material
  if (hasMaterialFacts && year) {
    const suggestedFileName = month
      ? `Laporan Fakta Material ${month} ${year}`
      : `Laporan Fakta Material ${year}`;
    return { suggestedFileName, confidence: 0.95 };
  }

  // Annual Report
  if (hasAnnualReport && year) {
    const suggestedFileName = `Laporan Tahunan ${year}`;
    return { suggestedFileName, confidence: 0.95 };
  }

  // Corporate Presentation
  if (hasCorporatePresentation && year) {
    const suggestedFileName = month
      ? `Corporate Presentation ${month} ${year}`
      : `Corporate Presentation ${year}`;
    return { suggestedFileName, confidence: 0.95 };
  }

  // QnA atau Public expose lainnya sudah ditangani di blok awal.

  // Transcript YouTube
  if (hasTranscriptYoutube && year) {
    const suggestedFileName = month
      ? `Transkrip Youtube ${month} ${year}`
      : `Transkrip Youtube ${year}`;
    return { suggestedFileName, confidence: 0.9 };
  }

  // Research sekuritas / equity research
  if (hasResearchSecurities && year) {
    const suggestedFileName = month
      ? `Laporan Riset Sekuritas ${month} ${year}`
      : `Laporan Riset Sekuritas ${year}`;
    return { suggestedFileName, confidence: 0.9 };
  }

  // Generic: kalau tidak cocok dengan tipe khusus tapi ada konteks tahun/bulan
  if (year) {
    const suggestedFileName = month
      ? `Dokumen ${month} ${year}`
      : `Dokumen ${year}`;
    return { suggestedFileName, confidence: 0.9 };
  }

  const system = `Kamu asisten penamaan dokumen keuangan.
Tugas: dari cuplikan teks + nama file asli, tebak konteks dokumen (mis. Annual Report/Laporan Tahunan, Quarterly Report/Laporan Triwulanan, Monthly Report/Laporan Bulanan) dan ambil tahun serta/atau bulan bila ada.

Output: HANYA valid JSON dengan bentuk persis:
{"suggested_file_name":"string|null","confidence":number}

Aturan:
- suggested_file_name harus berbahasa Indonesia dan TANPA ekstensi.
- Gunakan template maksimal 80 karakter:
  - "Laporan Tahunan {Tahun}"
  - "Laporan Triwulanan {Tahun} Q{1-4}"
  - "Laporan Bulanan {NamaBulan} {Tahun}" (contoh: Januari, Februari, ...; "NamaBulan" dalam Bahasa Indonesia)
- Jika tidak yakin atau tidak ada indikasi eksplisit (mis. kata Annual/Quarterly/Monthly atau padanan Indonesia di teks/nama file) atau tahun/bulan tidak ditemukan, suggested_file_name = null dan confidence < 0.7.
`;

  const user = `Nama file asli: ${originalBase}

Cuplikan teks (bisa berisi judul/daftar isi/angka):
${args.textSample}`;

  const raw = await chatCompletionJson({
    system,
    user,
    temperature: 0.2,
  });

  const parsed = JSON.parse(raw) as {
    suggested_file_name?: string | null;
    confidence?: number;
  };

  const suggestedFileName =
    typeof parsed.suggested_file_name === "string"
      ? parsed.suggested_file_name.trim()
      : null;
  const confidence =
    typeof parsed.confidence === "number" ? parsed.confidence : 0;

  if (!suggestedFileName || suggestedFileName.length === 0) {
    return { suggestedFileName: null, confidence };
  }

  // Guard: jangan pernah simpan nama kosong / terlalu panjang.
  return {
    suggestedFileName: suggestedFileName.slice(0, 200),
    confidence,
  };
}

