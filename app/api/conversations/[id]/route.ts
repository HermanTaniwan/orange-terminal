import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const pool = getPool();
    const { rows: conv } = await pool.query(
      `SELECT id, title, created_at FROM conversations WHERE id = $1::uuid`,
      [id]
    );
    if (!conv[0]) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const { rows: messages } = await pool.query(
      `SELECT id, role, content, sources_json, created_at
       FROM messages WHERE conversation_id = $1::uuid ORDER BY created_at ASC`,
      [id]
    );
    return NextResponse.json({ conversation: conv[0], messages });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to load conversation";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
