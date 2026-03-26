import { NextResponse } from "next/server";
import { dirname } from "node:path";
import { getPool } from "@/lib/db";
import { removeUploadDirectory } from "@/lib/uploadCleanup";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };
type ProjectType = "emiten" | "non_emiten";

function normalizeProjectType(input: unknown): ProjectType {
  return input === "emiten" ? "emiten" : "non_emiten";
}

export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
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
    const pool = getPool();
    const { rows: currentRows } = await pool.query<{
      project_type: ProjectType;
      ticker_symbol: string | null;
      exchange: string | null;
      industry_topic: string | null;
    }>(
      `SELECT project_type, ticker_symbol, exchange, industry_topic
       FROM projects WHERE id = $1::uuid`,
      [id]
    );
    const current = currentRows[0];
    if (!current) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    const projectType =
      body.projectType === undefined
        ? current.project_type
        : normalizeProjectType(body.projectType);
    const tickerSymbol =
      body.tickerSymbol === undefined
        ? current.ticker_symbol
        : body.tickerSymbol?.trim().toUpperCase() || null;
    const exchange =
      body.exchange === undefined
        ? current.exchange
        : body.exchange?.trim().toUpperCase() || null;
    const industryTopic =
      body.industryTopic === undefined
        ? current.industry_topic
        : body.industryTopic?.trim() || null;

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

    const { rows } = await pool.query(
      `UPDATE projects
       SET name = $2,
           description = $3,
           project_type = $4,
           ticker_symbol = $5,
           exchange = $6,
           industry_topic = $7
       WHERE id = $1::uuid
       RETURNING id, name, description, project_type, ticker_symbol, exchange, industry_topic, created_at`,
      [
        id,
        name,
        body.description?.trim() || null,
        projectType,
        tickerSymbol,
        exchange,
        industryTopic,
      ]
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
