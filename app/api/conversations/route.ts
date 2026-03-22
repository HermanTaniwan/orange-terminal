import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";

export const runtime = "nodejs";

export async function GET() {
  try {
    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT c.id, c.title, c.created_at,
        (SELECT content FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_preview
       FROM conversations c
       ORDER BY c.created_at DESC
       LIMIT 50`
    );
    return NextResponse.json({ conversations: rows });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to list conversations";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as { title?: string };
    const pool = getPool();
    const { rows } = await pool.query(
      `INSERT INTO conversations (title) VALUES ($1) RETURNING id, title, created_at`,
      [body.title?.trim() || null]
    );
    return NextResponse.json({ conversation: rows[0] });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to create conversation";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
