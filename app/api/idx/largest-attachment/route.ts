import { NextResponse } from "next/server";
import {
  extractIdxPdfAttachments,
  fetchIdxAnnouncements,
  formatIdxAnnouncementOutputBlock,
  pickLargestIdxAttachmentPerAnnouncement,
} from "@/lib/idx";

export const runtime = "nodejs";

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const kodeEmiten = (url.searchParams.get("kodeEmiten") || "").trim();
    const dateFrom = (url.searchParams.get("dateFrom") || "").trim();
    const dateTo = (url.searchParams.get("dateTo") || "").trim();
    const rawKeywords = (url.searchParams.get("keywords") || "").trim();
    const rawExcludeTitle = (url.searchParams.get("excludeTitle") || "").trim();
    console.log(
      `[IDX] largest-attachment request kodeEmiten=${kodeEmiten || "-"} dateFrom=${
        dateFrom || "-"
      } dateTo=${dateTo || "-"} keywords=${rawKeywords || "(default)"} excludeTitle=${
        rawExcludeTitle || "(default+env)"
      }`
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

    const extraExcludeTitle = rawExcludeTitle
      ? rawExcludeTitle.split(",").map((x) => x.trim()).filter(Boolean)
      : undefined;

    const replies = await fetchIdxAnnouncements({ kodeEmiten, dateFrom, dateTo });
    const { groups, excludedAnnouncementsCount, excludedAnnouncements } =
      extractIdxPdfAttachments(replies, keywords, {
        excludeTitleSubstrings: extraExcludeTitle,
      });
    const announcements = await pickLargestIdxAttachmentPerAnnouncement(groups);
    const candidatesCount = groups.reduce((n, g) => n + g.candidates.length, 0);
    const sizedCount = announcements.reduce((n, a) => n + a.sizedCount, 0);
    const failedCount = announcements.reduce((n, a) => n + a.failedCount, 0);

    console.log(
      "[IDX] largest-attachment result:",
      JSON.stringify(
        {
          announcementsCount: announcements.length,
          candidatesCount,
          excludedAnnouncementsCount,
          sizedCount,
          failedCount,
        },
        null,
        2
      )
    );

    return NextResponse.json({
      announcements: announcements.map((a) => {
        const outputPdf = a.selected?.fileName?.trim() || "(tidak ada)";
        return {
          title: a.title,
          publishedAt: a.publishedAt,
          selected: a.selected,
          extras: a.extras,
          candidatesInAnnouncement: a.candidatesInAnnouncement,
          sizedCount: a.sizedCount,
          failedCount: a.failedCount,
          outputBlock: formatIdxAnnouncementOutputBlock({
            pengumuman: a.title,
            date: a.publishedAt,
            outputPdf,
          }),
        };
      }),
      candidatesCount,
      excludedAnnouncementsCount,
      excludedAnnouncements,
      sizedCount,
      failedCount,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to query IDX";
    const status = /403|blocked/i.test(msg) ? 502 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}

