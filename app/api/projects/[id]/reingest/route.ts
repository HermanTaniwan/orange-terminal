import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { enqueueEmitenIngestJob, ensureEmitenIngestPollerStarted } from "@/lib/emitenIngestWorker";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(_req: Request, ctx: Ctx) {
  try {
    ensureEmitenIngestPollerStarted();
    const { id } = await ctx.params;
    const pool = getPool();
    const { rows } = await pool.query<{
      id: string;
      project_type: "emiten" | "non_emiten";
      ticker_symbol: string | null;
    }>(
      `SELECT id, project_type, ticker_symbol
       FROM projects
       WHERE id = $1::uuid`,
      [id]
    );
    const project = rows[0];
    if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });
    if (project.project_type !== "emiten") {
      return NextResponse.json({ error: "Only emiten project can be re-ingested" }, { status: 400 });
    }
    if (!project.ticker_symbol) {
      return NextResponse.json({ error: "tickerSymbol is required" }, { status: 400 });
    }

    const queued = await enqueueEmitenIngestJob({
      projectId: project.id,
      tickerSymbol: project.ticker_symbol,
      force: true,
    });
    return NextResponse.json({
      ok: true,
      jobId: queued.jobId,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to enqueue re-ingest";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

