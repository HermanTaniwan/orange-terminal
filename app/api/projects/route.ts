import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import {
  enqueueEmitenIngestJob,
  ensureEmitenIngestPollerStarted,
  getLatestEmitenIngestJobsByProject,
} from "@/lib/emitenIngestWorker";

export const runtime = "nodejs";

type ProjectType = "emiten" | "non_emiten";

function normalizeProjectType(input: unknown): ProjectType {
  return input === "emiten" ? "emiten" : "non_emiten";
}

export async function GET() {
  try {
    ensureEmitenIngestPollerStarted();
    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT id, name, description, project_type, ticker_symbol, exchange, industry_topic, created_at
       FROM projects
       ORDER BY created_at DESC`
    );
    const byProject = await getLatestEmitenIngestJobsByProject(rows.map((r) => r.id as string));
    const projects = rows.map((r) => {
      const j = byProject.get(r.id as string);
      return {
        ...r,
        ingest_status: j?.status || null,
        ingest_error: j?.error_message || null,
        ingest_metrics: j?.metrics_json || null,
        ingest_updated_at: j?.updated_at || null,
      };
    });
    return NextResponse.json({ projects });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to list projects";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    ensureEmitenIngestPollerStarted();
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
    const project = rows[0];
    if (projectType === "emiten" && tickerSymbol) {
      await enqueueEmitenIngestJob({
        projectId: project.id as string,
        tickerSymbol,
      });
    }
    return NextResponse.json({ project });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to create project";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
