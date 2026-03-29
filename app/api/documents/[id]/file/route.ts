import { createReadStream } from "node:fs";
import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

function escapeFileNameForHeader(name: string): string {
  // Minimal sanitization to keep header parsing safe.
  return name.replace(/[\r\n"]/g, "");
}

export async function GET(_req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const reqUrl = new URL(_req.url);
    const projectId = reqUrl.searchParams.get("projectId")?.trim();
    if (!projectId) {
      return NextResponse.json(
        { error: "projectId is required" },
        { status: 400 }
      );
    }

    const pool = getPool();
    const { rows } = await pool.query<{
      storage_path: string;
      file_name: string;
      mime_type: string;
    }>(
      `SELECT storage_path, file_name, mime_type
       FROM documents
       WHERE id = $1::uuid AND project_id = $2::uuid AND deleted_at IS NULL`,
      [id, projectId]
    );

    if (!rows[0]) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const { storage_path: storagePath, file_name: fileName, mime_type: mimeType } =
      rows[0];

    const stream = createReadStream(storagePath);

    return new NextResponse(stream as any, {
      headers: {
        "Content-Type": mimeType || "application/octet-stream",
        "Content-Disposition": `inline; filename="${escapeFileNameForHeader(
          fileName || "document"
        )}"`,
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to serve file";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

