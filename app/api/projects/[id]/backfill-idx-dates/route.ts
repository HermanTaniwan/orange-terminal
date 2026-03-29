import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { extractIdxPdfAttachments, fetchIdxAnnouncements } from "@/lib/idx";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

function parseIdxDateToIso(raw: string): string | null {
  const s = String(raw || "").trim();
  if (!s) return null;
  const m = s.match(
    /^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/
  );
  if (m) {
    const day = Number(m[1]);
    const month = Number(m[2]);
    const year = Number(m[3]);
    const hour = Number(m[4] || "0");
    const minute = Number(m[5] || "0");
    const second = Number(m[6] || "0");
    if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
      return new Date(Date.UTC(year, month - 1, day, hour, minute, second)).toISOString();
    }
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export async function POST(_req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const pool = getPool();

    const { rows: projectRows } = await pool.query<{
      id: string;
      project_type: "emiten" | "non_emiten";
      ticker_symbol: string | null;
    }>(
      `SELECT id, project_type, ticker_symbol
       FROM projects
       WHERE id = $1::uuid`,
      [id]
    );
    const project = projectRows[0];
    if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });
    if (project.project_type !== "emiten") {
      return NextResponse.json({ error: "Only emiten project can be backfilled" }, { status: 400 });
    }
    if (!project.ticker_symbol) {
      return NextResponse.json({ error: "tickerSymbol is required" }, { status: 400 });
    }

    const replies = await fetchIdxAnnouncements({ kodeEmiten: project.ticker_symbol });
    const { groups } = extractIdxPdfAttachments(replies, []);

    const byFile = new Map<string, string>();
    for (const g of groups) {
      const iso = parseIdxDateToIso(g.publishedAt);
      if (!iso) continue;
      for (const c of g.candidates) {
        const key = c.fileName.trim().toLowerCase();
        if (!key) continue;
        const prev = byFile.get(key);
        if (!prev || new Date(iso).getTime() > new Date(prev).getTime()) {
          byFile.set(key, iso);
        }
      }
    }

    const { rows: docRows } = await pool.query<{ id: string; file_name: string; created_at: string }>(
      `SELECT id, file_name, created_at
       FROM documents
       WHERE project_id = $1::uuid
         AND mime_type = 'application/pdf'`,
      [project.id]
    );

    let matched = 0;
    let updated = 0;
    let unchanged = 0;
    let unmatched = 0;

    for (const d of docRows) {
      const key = String(d.file_name || "").trim().toLowerCase();
      const iso = byFile.get(key);
      if (!iso) {
        unmatched += 1;
        continue;
      }
      matched += 1;
      const curr = new Date(d.created_at).getTime();
      const next = new Date(iso).getTime();
      if (Number.isNaN(curr) || curr !== next) {
        await pool.query(`UPDATE documents SET created_at = $2::timestamptz WHERE id = $1::uuid`, [
          d.id,
          iso,
        ]);
        updated += 1;
      } else {
        unchanged += 1;
      }
    }

    return NextResponse.json({
      ok: true,
      projectId: project.id,
      tickerSymbol: project.ticker_symbol,
      stats: {
        totalDocuments: docRows.length,
        idxFilenameMapped: byFile.size,
        matched,
        updated,
        unchanged,
        unmatched,
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to backfill IDX dates";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

