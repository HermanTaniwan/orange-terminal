import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { getServerEnv } from "@/lib/env";
import { processDocument, ensureUploadRoot } from "@/lib/ingest";
import { allowedUpload, sanitizeFileName } from "@/lib/files";

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
      `SELECT id, project_id, file_name, mime_type, status, error_message, char_count, insights_json, created_at, idx_announcement_id
       FROM documents
       WHERE project_id = $1::uuid AND deleted_at IS NULL
       ORDER BY created_at DESC`,
      [projectId]
    );
    return NextResponse.json({ documents: rows });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to list documents";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const env = getServerEnv();
    const maxBytes = env.maxUploadMb * 1024 * 1024;
    const form = await req.formData();
    const projectId = String(form.get("projectId") || "").trim();
    if (!projectId) {
      return NextResponse.json({ error: "projectId is required" }, { status: 400 });
    }

    const file = form.get("file");
    if (!file || !(file instanceof File)) {
      return NextResponse.json({ error: "Missing file field" }, { status: 400 });
    }
    if (!allowedUpload(file.name)) {
      return NextResponse.json(
        { error: "Only PDF and Excel (.xlsx, .xls) are allowed" },
        { status: 400 }
      );
    }
    if (file.size > maxBytes) {
      return NextResponse.json(
        { error: `File too large (max ${env.maxUploadMb} MB)` },
        { status: 400 }
      );
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const sha256 = createHash("sha256").update(buffer).digest("hex");
    const id = randomUUID();
    const root = await ensureUploadRoot();
    const safeName = sanitizeFileName(file.name);
    const dir = join(root, id);
    await mkdir(dir, { recursive: true });
    const storagePath = join(dir, safeName);
    await writeFile(storagePath, buffer);

    const mimeType = file.type || "application/octet-stream";
    const pool = getPool();
    const { rows: projectRows } = await pool.query(
      `SELECT id FROM projects WHERE id = $1::uuid`,
      [projectId]
    );
    if (!projectRows[0]) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    await pool.query(
      `INSERT INTO documents (id, project_id, file_name, mime_type, storage_path, status, sha256)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5, 'pending', $6)`,
      [id, projectId, file.name, mimeType, storagePath, sha256]
    );

    await processDocument({
      documentId: id,
      filePath: storagePath,
      mimeType,
      fileName: file.name,
    });

    const { rows } = await pool.query(
      `SELECT id, project_id, file_name, mime_type, status, error_message, char_count, insights_json, created_at, idx_announcement_id
       FROM documents WHERE id = $1 AND deleted_at IS NULL`,
      [id]
    );
    return NextResponse.json({ document: rows[0] });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Upload failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
