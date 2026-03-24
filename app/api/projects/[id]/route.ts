import { NextResponse } from "next/server";
import { dirname } from "node:path";
import { getPool } from "@/lib/db";
import { removeUploadDirectory } from "@/lib/uploadCleanup";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const body = (await req.json().catch(() => ({}))) as {
      name?: string;
      description?: string | null;
    };
    const name = body.name?.trim();
    if (!name) {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }
    const pool = getPool();
    const { rows } = await pool.query(
      `UPDATE projects
       SET name = $2,
           description = $3
       WHERE id = $1::uuid
       RETURNING id, name, description, created_at`,
      [id, name, body.description?.trim() || null]
    );
    if (!rows[0]) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }
    return NextResponse.json({ project: rows[0] });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to update project";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function DELETE(_req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    if (id === "00000000-0000-0000-0000-000000000001") {
      return NextResponse.json(
        { error: "Default project cannot be deleted" },
        { status: 400 }
      );
    }
    const pool = getPool();
    const { rows: docs } = await pool.query<{ storage_path: string }>(
      `SELECT storage_path FROM documents WHERE project_id = $1::uuid`,
      [id]
    );
    for (const doc of docs) {
      await removeUploadDirectory(dirname(doc.storage_path));
    }
    const { rows } = await pool.query(
      `DELETE FROM projects WHERE id = $1::uuid RETURNING id`,
      [id]
    );
    if (!rows[0]) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to delete project";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
