import { dirname } from "node:path";
import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { removeUploadDirectory } from "@/lib/uploadCleanup";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

export async function DELETE(_req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const reqUrl = new URL(_req.url);
    const projectId = reqUrl.searchParams.get("projectId")?.trim();
    if (!projectId) {
      return NextResponse.json({ error: "projectId is required" }, { status: 400 });
    }
    const pool = getPool();
    const { rows } = await pool.query<{ storage_path: string }>(
      `SELECT storage_path
       FROM documents
       WHERE id = $1::uuid AND project_id = $2::uuid`,
      [id, projectId]
    );
    if (!rows[0]) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    await removeUploadDirectory(dirname(rows[0].storage_path));
    await pool.query(`DELETE FROM documents WHERE id = $1::uuid`, [id]);
    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Delete failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
