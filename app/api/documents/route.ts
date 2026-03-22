import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { getServerEnv } from "@/lib/env";
import { processDocument, ensureUploadRoot } from "@/lib/ingest";
import { allowedUpload, sanitizeFileName } from "@/lib/files";

export const runtime = "nodejs";

export async function GET() {
  try {
    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT id, file_name, mime_type, status, error_message, char_count, insights_json, created_at
       FROM documents ORDER BY created_at DESC`
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
    const id = randomUUID();
    const root = await ensureUploadRoot();
    const safeName = sanitizeFileName(file.name);
    const dir = join(root, id);
    await mkdir(dir, { recursive: true });
    const storagePath = join(dir, safeName);
    await writeFile(storagePath, buffer);

    const mimeType = file.type || "application/octet-stream";
    const pool = getPool();
    await pool.query(
      `INSERT INTO documents (id, file_name, mime_type, storage_path, status)
       VALUES ($1::uuid, $2, $3, $4, 'pending')`,
      [id, file.name, mimeType, storagePath]
    );

    await processDocument({
      documentId: id,
      filePath: storagePath,
      mimeType,
      fileName: file.name,
    });

    const { rows } = await pool.query(
      `SELECT id, file_name, mime_type, status, error_message, char_count, insights_json, created_at
       FROM documents WHERE id = $1`,
      [id]
    );
    return NextResponse.json({ document: rows[0] });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Upload failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
