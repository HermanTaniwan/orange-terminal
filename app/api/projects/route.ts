import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";

export const runtime = "nodejs";

type ProjectType = "emiten" | "non_emiten";

function normalizeProjectType(input: unknown): ProjectType {
  return input === "emiten" ? "emiten" : "non_emiten";
}

export async function GET() {
  try {
    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT id, name, description, project_type, ticker_symbol, exchange, industry_topic, created_at
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
      description?: string | null;
      projectType?: ProjectType;
      tickerSymbol?: string | null;
      exchange?: string | null;
      industryTopic?: string | null;
    };
    const name = body.name?.trim();
    if (!name) {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }
    const projectType = normalizeProjectType(body.projectType);
    const tickerSymbol = body.tickerSymbol?.trim().toUpperCase() || null;
    const exchange = body.exchange?.trim().toUpperCase() || null;
    const industryTopic = body.industryTopic?.trim() || null;

    if (projectType === "emiten" && !tickerSymbol) {
      return NextResponse.json(
        { error: "tickerSymbol is required for emiten project" },
        { status: 400 }
      );
    }
    if (projectType === "non_emiten" && !industryTopic) {
      return NextResponse.json(
        { error: "industryTopic is required for non-emiten project" },
        { status: 400 }
      );
    }

    const pool = getPool();
    const { rows } = await pool.query(
      `INSERT INTO projects (name, description, project_type, ticker_symbol, exchange, industry_topic)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, name, description, project_type, ticker_symbol, exchange, industry_topic, created_at`,
      [
        name,
        body.description?.trim() || null,
        projectType,
        tickerSymbol,
        exchange,
        industryTopic,
      ]
    );
    return NextResponse.json({ project: rows[0] });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to create project";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
