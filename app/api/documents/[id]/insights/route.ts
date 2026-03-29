import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { generateAndStoreInsights } from "@/lib/insights";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(_req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const reqUrl = new URL(_req.url);
    const projectId = reqUrl.searchParams.get("projectId")?.trim();
    if (!projectId) {
      return NextResponse.json({ error: "projectId is required" }, { status: 400 });
    }
    const pool = getPool();
    const { rows } = await pool.query<{
      file_name: string;
      char_count: number | null;
      status: string;
      sha256: string | null;
    }>(
      `SELECT file_name, char_count, status, sha256
       FROM documents
       WHERE id = $1::uuid AND project_id = $2::uuid AND deleted_at IS NULL`,
      [id, projectId]
    );
    const doc = rows[0];
    if (!doc) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    if (doc.status !== "ready") {
      return NextResponse.json(
        { error: "Document is not ready for insights" },
        { status: 400 }
      );
    }
    const { rows: chunkRows } = await pool.query<{ content: string }>(
      `SELECT content FROM chunks WHERE document_id = $1::uuid ORDER BY chunk_index ASC LIMIT 30`,
      [id]
    );
    const textSample = chunkRows.map((r) => r.content).join("\n\n").slice(0, 20000);
    if (!textSample.trim()) {
      return NextResponse.json(
        { error: "No chunk text available" },
        { status: 400 }
      );
    }
    const insights = await generateAndStoreInsights({
      documentId: id,
      textSample,
      sha256: doc.sha256,
    });
    return NextResponse.json({ insights });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Insights failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
