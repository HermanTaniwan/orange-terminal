import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { getPool } from "./db";
import { getServerEnv } from "./env";
import { extractTextFromFile } from "./extract";
import { splitIntoChunks } from "./chunk";
import { embedTexts } from "./openrouter";
import { toVectorParam } from "./vector";
import { generateAndStoreInsights } from "./insights";
import { inferDocumentName } from "./inferDocumentName";

const EMBED_BATCH = 24;

export async function processDocument(args: {
  documentId: string;
  filePath: string;
  mimeType: string;
  fileName: string;
}): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE documents SET status = 'processing', error_message = NULL WHERE id = $1`,
    [args.documentId]
  );

  try {
    const text = await extractTextFromFile(
      args.filePath,
      args.mimeType,
      args.fileName
    );
    const trimmed = text.replace(/\s+/g, " ").trim();
    if (!trimmed) {
      await pool.query(
        `UPDATE documents SET status = 'failed', error_message = $2, char_count = 0 WHERE id = $1`,
        [args.documentId, "No extractable text in file"]
      );
      return;
    }

    // Try to rename the document based on detected context (Annual/Quarterly/Monthly + year/month).
    // This is best-effort and must never break ingestion.
    try {
      const { suggestedFileName, confidence } = await inferDocumentName({
        originalFileName: args.fileName,
        textSample: trimmed.slice(0, 12000),
      });

      const lowerOriginalName = args.fileName.toLowerCase();
      const hasPublicExpose =
        /public\s*(expose|exposure)|paparan\s*publik|expose\s*publik/.test(
          lowerOriginalName
        );

      if (
        suggestedFileName &&
        confidence >= 0.9 &&
        suggestedFileName.length > 0
      ) {
        // Extra safety: if the original clearly says "public expose",
        // never allow rename into an Annual/Quarterly/Monthly template.
        if (hasPublicExpose) {
          const lowerSuggested = suggestedFileName.toLowerCase();
          const matchesPublicExpose =
            /paparan\s*publik|public\s*expose/.test(lowerSuggested);
          if (!matchesPublicExpose) {
            return;
          }
        }

        await pool.query(`UPDATE documents SET file_name = $2 WHERE id = $1`, [
          args.documentId,
          suggestedFileName,
        ]);
      }
    } catch (renameErr) {
      console.error("Auto-rename inference failed:", renameErr);
    }

    await pool.query(
      `UPDATE documents SET char_count = $2 WHERE id = $1`,
      [args.documentId, trimmed.length]
    );

    const chunks = splitIntoChunks(trimmed);
    await pool.query(`DELETE FROM chunks WHERE document_id = $1`, [
      args.documentId,
    ]);

    for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
      const batch = chunks.slice(i, i + EMBED_BATCH);
      const embeddings = await embedTexts(batch);
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        for (let j = 0; j < batch.length; j++) {
          const idx = i + j;
          await client.query(
            `INSERT INTO chunks (document_id, chunk_index, content, embedding)
             VALUES ($1, $2, $3, $4::vector)`,
            [
              args.documentId,
              idx,
              batch[j],
              toVectorParam(embeddings[j]),
            ]
          );
        }
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }
    }

    await pool.query(
      `UPDATE documents SET status = 'ready' WHERE id = $1`,
      [args.documentId]
    );

    try {
      await generateAndStoreInsights({
        documentId: args.documentId,
        textSample: trimmed.slice(0, 20000),
      });
    } catch (insightErr) {
      console.error("Insights generation failed:", insightErr);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await pool.query(
      `UPDATE documents SET status = 'failed', error_message = $2 WHERE id = $1`,
      [args.documentId, msg]
    );
    throw err;
  }
}

export async function ensureUploadRoot(): Promise<string> {
  const { uploadDir } = getServerEnv();
  const root = join(process.cwd(), uploadDir);
  await mkdir(root, { recursive: true });
  return root;
}

