import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";

export const runtime = "nodejs";

export async function GET() {
  try {
    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT id, name, description, created_at
       FROM projects
       ORDER BY created_at DESC`
    );
    return NextResponse.json({ projects: rows });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to list projects";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      name?: string;
      description?: string;
    };
    const name = body.name?.trim();
    if (!name) {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }
    const pool = getPool();
    const { rows } = await pool.query(
      `INSERT INTO projects (name, description)
       VALUES ($1, $2)
       RETURNING id, name, description, created_at`,
      [name, body.description?.trim() || null]
    );
    return NextResponse.json({ project: rows[0] });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to create project";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
