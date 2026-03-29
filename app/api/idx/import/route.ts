import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { getServerEnv } from "@/lib/env";
import { allowedUpload, sanitizeFileName } from "@/lib/files";
import { ensureUploadRoot, processDocument } from "@/lib/ingest";

export const runtime = "nodejs";

type ImportAttachment = {
  title?: string;
  publishedAt?: string;
  fileName?: string;
  url?: string;
};

function buildIdxFileName(a: ImportAttachment): string {
  const raw = (a.fileName || "").trim();
  if (raw.toLowerCase().endsWith(".pdf")) return raw;
  return `${raw || "idx_document"}.pdf`;
}

async function fetchIdxPdf(url: string): Promise<Buffer> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        Accept: "application/pdf,*/*",
      },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Failed PDF download: ${res.status}`);
    const ab = await res.arrayBuffer();
    return Buffer.from(ab);
  } finally {
    clearTimeout(timeout);
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      projectId?: string;
      attachments?: ImportAttachment[];
    };
    const projectId = body.projectId?.trim();
    if (!projectId) {
      return NextResponse.json({ error: "projectId is required" }, { status: 400 });
    }
    const attachments = Array.isArray(body.attachments) ? body.attachments : [];
    if (attachments.length === 0) {
      return NextResponse.json({ error: "attachments is required" }, { status: 400 });
    }

    const pool = getPool();
    const { rows: projectRows } = await pool.query(
      `SELECT id FROM projects WHERE id = $1::uuid`,
      [projectId]
    );
    if (!projectRows[0]) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    const env = getServerEnv();
    const maxBytes = env.maxUploadMb * 1024 * 1024;
    const root = await ensureUploadRoot();

    const imported: { documentId: string; fileName: string; sha256: string }[] = [];
    const skipped: { reason: string; fileName: string; url: string }[] = [];
    const failed: { reason: string; fileName: string; url: string }[] = [];

    for (const a of attachments) {
      const url = String(a.url || "").trim();
      const fileName = buildIdxFileName(a);
      if (!url) {
        skipped.push({ reason: "missing url", fileName, url });
        continue;
      }
      if (!allowedUpload(fileName)) {
        skipped.push({ reason: "unsupported extension", fileName, url });
        continue;
      }

      try {
        const buffer = await fetchIdxPdf(url);
        if (buffer.byteLength > maxBytes) {
          skipped.push({ reason: `too large > ${env.maxUploadMb}MB`, fileName, url });
          continue;
        }

        const sha256 = createHash("sha256").update(buffer).digest("hex");
        const id = randomUUID();
        const safeName = sanitizeFileName(fileName);
        const dir = join(root, id);
        await mkdir(dir, { recursive: true });
        const storagePath = join(dir, safeName);
        await writeFile(storagePath, buffer);

        const mimeType = "application/pdf";
        await pool.query(
          `INSERT INTO documents (id, project_id, file_name, mime_type, storage_path, status, sha256, idx_source_url)
           VALUES ($1::uuid, $2::uuid, $3, $4, $5, 'pending', $6, $7)`,
          [id, projectId, fileName, mimeType, storagePath, sha256, url]
        );
        await processDocument({
          documentId: id,
          filePath: storagePath,
          mimeType,
          fileName,
        });

        imported.push({ documentId: id, fileName, sha256 });
      } catch (e) {
        const msg = e instanceof Error ? e.message : "import failed";
        failed.push({ reason: msg, fileName, url });
      }
    }

    return NextResponse.json({
      importedCount: imported.length,
      skippedCount: skipped.length,
      failedCount: failed.length,
      imported,
      skipped,
      failed,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "IDX import failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

