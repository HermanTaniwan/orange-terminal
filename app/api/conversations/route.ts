import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";

export const runtime = "nodejs";

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const projectId = url.searchParams.get("projectId")?.trim();
    if (!projectId) {
      return NextResponse.json(
        { error: "projectId query param is required" },
        { status: 400 }
      );
    }
    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT c.id, c.project_id, c.title, c.created_at,
        (SELECT content FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_preview
       FROM conversations c
       WHERE c.project_id = $1::uuid
       ORDER BY c.created_at DESC
       LIMIT 50`,
      [projectId]
    );
    return NextResponse.json({ conversations: rows });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to list conversations";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      title?: string;
      projectId?: string;
    };
    const projectId = body.projectId?.trim();
    if (!projectId) {
      return NextResponse.json({ error: "projectId is required" }, { status: 400 });
    }
    const pool = getPool();
    const { rows: projectRows } = await pool.query(
      `SELECT id FROM projects WHERE id = $1::uuid`,
      [projectId]
    );
    if (!projectRows[0]) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }
    const { rows } = await pool.query(
      `INSERT INTO conversations (project_id, title)
       VALUES ($1::uuid, $2)
       RETURNING id, project_id, title, created_at`,
      [projectId, body.title?.trim() || null]
    );
    return NextResponse.json({ conversation: rows[0] });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to create conversation";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
