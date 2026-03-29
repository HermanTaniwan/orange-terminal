import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";

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
    const { rows } = await pool.query(
      `UPDATE documents
       SET deleted_at = now()
       WHERE id = $1::uuid AND project_id = $2::uuid AND deleted_at IS NULL
       RETURNING id`,
      [id, projectId]
    );
    if (!rows[0]) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Delete failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const reqUrl = new URL(req.url);
    const projectId = reqUrl.searchParams.get("projectId")?.trim();
    if (!projectId) {
      return NextResponse.json(
        { error: "projectId is required" },
        { status: 400 }
      );
    }

    const body = (await req.json().catch(() => ({}))) as {
      fileName?: string;
    };
    const fileName = body.fileName?.trim();
    if (!fileName) {
      return NextResponse.json({ error: "fileName is required" }, { status: 400 });
    }
    if (fileName.length > 200) {
      return NextResponse.json(
        { error: "fileName is too long (max 200 chars)" },
        { status: 400 }
      );
    }

    const pool = getPool();
    const { rows } = await pool.query(
      `UPDATE documents
       SET file_name = $2
       WHERE id = $1::uuid AND project_id = $3::uuid AND deleted_at IS NULL
       RETURNING id`,
      [id, fileName, projectId]
    );

    if (!rows[0]) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Rename failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
