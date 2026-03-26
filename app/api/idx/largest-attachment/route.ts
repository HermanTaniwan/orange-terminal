import { NextResponse } from "next/server";
import {
  extractIdxPdfAttachments,
  fetchIdxAnnouncements,
  pickLargestIdxAttachment,
} from "@/lib/idx";

export const runtime = "nodejs";

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const kodeEmiten = (url.searchParams.get("kodeEmiten") || "").trim();
    const dateFrom = (url.searchParams.get("dateFrom") || "").trim();
    const dateTo = (url.searchParams.get("dateTo") || "").trim();
    const rawKeywords = (url.searchParams.get("keywords") || "").trim();
    console.log(
      `[IDX] largest-attachment request kodeEmiten=${kodeEmiten || "-"} dateFrom=${
        dateFrom || "-"
      } dateTo=${dateTo || "-"} keywords=${rawKeywords || "(default)"}`
    );
    if (!kodeEmiten) {
      return NextResponse.json(
        { error: "kodeEmiten is required" },
        { status: 400 }
      );
    }

    const keywords = rawKeywords
      ? rawKeywords
          .split(",")
          .map((x) => x.trim().toLowerCase())
          .filter(Boolean)
      : undefined;

    const replies = await fetchIdxAnnouncements({ kodeEmiten, dateFrom, dateTo });
    const candidates = extractIdxPdfAttachments(replies, keywords);
    const { selected, sizedCount, failedCount, all } =
      await pickLargestIdxAttachment(candidates);
    console.log(
      "[IDX] largest-attachment result:",
      JSON.stringify(
        {
          candidatesCount: candidates.length,
          sizedCount,
          failedCount,
          selectedFile: selected?.fileName || null,
          selectedSizeBytes: selected?.sizeBytes ?? null,
        },
        null,
        2
      )
    );

    return NextResponse.json({
      selected,
      candidatesCount: candidates.length,
      sizedCount,
      failedCount,
      // keep tiny preview for debug/fallback UI transparency
      topCandidates: all
        .sort((a, b) => b.sizeBytes - a.sizeBytes)
        .slice(0, 5)
        .map((x) => ({
          title: x.title,
          publishedAt: x.publishedAt,
          fileName: x.fileName,
          url: x.url,
          sizeBytes: x.sizeBytes,
        })),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to query IDX";
    const status = /403|blocked/i.test(msg) ? 502 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}

