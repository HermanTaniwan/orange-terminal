import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { backfillIdxDocumentFileNamesFromCache } from "@/lib/emitenIngestWorker";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST: set document file_name from .runtime/idx-cache/<TICKER>/result.json (OriginalFilename).
 * Needs a valid local IDX cache (run ingest once, or same machine as last Python run).
 */
export async function POST(_req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT id FROM projects WHERE id = $1::uuid`,
      [id]
    );
    if (!rows[0]) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }
    const result = await backfillIdxDocumentFileNamesFromCache(id);
    return NextResponse.json({
      ok: true,
      ...result,
      hint: result.cacheHit
        ? undefined
        : "No IDX cache for this ticker (wrong IDX_CACHE_VERSION or never ingested). Run emiten ingest or delete idx-cache to refresh.",
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Backfill failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
