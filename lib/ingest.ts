import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { getPool } from "./db";
import { getServerEnv } from "./env";
import { extractTextFromFile } from "./extract";
import { splitIntoChunks } from "./chunk";
import { embedTexts } from "./openrouter";
import { toVectorParam } from "./vector";
import { generateAndStoreInsights, resolveInsightsWithoutLLM } from "./insights";
import { inferDocumentName } from "./inferDocumentName";

const EMBED_BATCH = 24;

async function hydrateDocumentChunksFromCache(args: {
  documentId: string;
  sha256: string;
}): Promise<{ copiedChunks: number }> {
  const pool = getPool();
  await pool.query(`DELETE FROM chunks WHERE document_id = $1`, [args.documentId]);
  const { rowCount } = await pool.query(
    `INSERT INTO chunks (document_id, chunk_index, content, embedding)
     SELECT $1::uuid, c.chunk_index, c.content, c.embedding
     FROM embedding_cache_chunks c
     WHERE c.sha256 = $2
     ORDER BY c.chunk_index`,
    [args.documentId, args.sha256]
  );
  return { copiedChunks: rowCount ?? 0 };
}

async function documentHasStoredInsights(documentId: string): Promise<boolean> {
  const pool = getPool();
  const { rows } = await pool.query<{ ok: boolean }>(
    `SELECT (insights_json IS NOT NULL) AS ok FROM documents WHERE id = $1::uuid`,
    [documentId]
  );
  return rows[0]?.ok === true;
}

async function buildTextSampleFromChunks(args: {
  documentId: string;
  limit?: number;
}): Promise<string> {
  const pool = getPool();
  const limit = Number.isFinite(args.limit) ? Math.max(1, Number(args.limit)) : 30;
  const { rows } = await pool.query<{ content: string }>(
    `SELECT content
     FROM chunks
     WHERE document_id = $1::uuid
     ORDER BY chunk_index ASC
     LIMIT $2`,
    [args.documentId, limit]
  );
  return rows
    .map((r) => r.content)
    .join("\n\n")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 20000);
}

export async function processDocument(args: {
  documentId: string;
  filePath: string;
  mimeType: string;
  fileName: string;
}): Promise<void> {
  const pool = getPool();
  const { rows: docRows } = await pool.query<{
    sha256: string | null;
    file_name: string;
    idx_source_url: string | null;
    idx_announcement_id: string | null;
  }>(
    `SELECT sha256, file_name, idx_source_url, idx_announcement_id FROM documents WHERE id = $1`,
    [args.documentId]
  );
  const row = docRows[0];
  const sha256 = row?.sha256 || null;
  const skipIdxAutoRename =
    Boolean(String(row?.idx_source_url || "").trim()) ||
    Boolean(String(row?.idx_announcement_id || "").trim());

  await pool.query(
    `UPDATE documents SET status = 'processing', error_message = NULL WHERE id = $1`,
    [args.documentId]
  );

  try {
    if (sha256) {
      const { rows: cacheRows } = await pool.query<{
        status: string;
        char_count: number | null;
      }>(
        `SELECT status, char_count
         FROM embedding_cache_sets
         WHERE sha256 = $1`,
        [sha256]
      );

      if (cacheRows[0]?.status === "ready") {
        const { copiedChunks } = await hydrateDocumentChunksFromCache({
          documentId: args.documentId,
          sha256,
        });
        if (copiedChunks > 0) {
          const resolved = await resolveInsightsWithoutLLM({
            documentId: args.documentId,
            sha256,
          });
          if (!resolved) {
            try {
              const textSample = await buildTextSampleFromChunks({
                documentId: args.documentId,
              });
              if (textSample) {
                await generateAndStoreInsights({
                  documentId: args.documentId,
                  textSample,
                  sha256,
                });
              }
            } catch (insightErr) {
              console.error("Insights generation (cache-hit fallback) failed:", insightErr);
            }
          } else {
            console.log(
              `[INGEST] insights_reused_sha256 documentId=${args.documentId} sha256=${sha256}`
            );
          }
          await pool.query(
            `UPDATE documents
             SET status = 'ready',
                 char_count = COALESCE($2, char_count)
             WHERE id = $1`,
            [args.documentId, cacheRows[0].char_count]
          );
          console.log(
            `[INGEST] cache_hit_sha256 documentId=${args.documentId} sha256=${sha256} copiedChunks=${copiedChunks}`
          );
          return;
        }
      }
    }

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

    // IDX / emiten: keep OriginalFilename from API; manual uploads still get inferred titles.
    if (!skipIdxAutoRename) {
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
          let applyRename = true;
          if (hasPublicExpose) {
            const lowerSuggested = suggestedFileName.toLowerCase();
            const matchesPublicExpose =
              /paparan\s*publik|public\s*expose/.test(lowerSuggested);
            if (!matchesPublicExpose) {
              applyRename = false;
            }
          }
          if (applyRename) {
            await pool.query(`UPDATE documents SET file_name = $2 WHERE id = $1`, [
              args.documentId,
              suggestedFileName,
            ]);
          }
        }
      } catch (renameErr) {
        console.error("Auto-rename inference failed:", renameErr);
      }
    }

    await pool.query(
      `UPDATE documents SET char_count = $2 WHERE id = $1`,
      [args.documentId, trimmed.length]
    );

    const chunks = splitIntoChunks(trimmed);
    await pool.query(`DELETE FROM chunks WHERE document_id = $1`, [
      args.documentId,
    ]);

    if (sha256) {
      await pool.query(
        `INSERT INTO embedding_cache_sets (sha256, status, char_count, source_file_name, updated_at)
         VALUES ($1, 'processing', $2, $3, now())
         ON CONFLICT (sha256)
         DO UPDATE SET status = 'processing', char_count = $2, source_file_name = $3, updated_at = now()`,
        [sha256, trimmed.length, args.fileName]
      );
      await pool.query(`DELETE FROM embedding_cache_chunks WHERE sha256 = $1`, [sha256]);
    }

    for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
      const batch = chunks.slice(i, i + EMBED_BATCH);
      const embeddings = await embedTexts(batch);
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        for (let j = 0; j < batch.length; j++) {
          const idx = i + j;
          const vec = toVectorParam(embeddings[j]);
          await client.query(
            `INSERT INTO chunks (document_id, chunk_index, content, embedding)
             VALUES ($1, $2, $3, $4::vector)`,
            [
              args.documentId,
              idx,
              batch[j],
              vec,
            ]
          );
          if (sha256) {
            await client.query(
              `INSERT INTO embedding_cache_chunks (sha256, chunk_index, content, embedding)
               VALUES ($1, $2, $3, $4::vector)`,
              [sha256, idx, batch[j], vec]
            );
          }
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
    if (sha256) {
      await pool.query(
        `UPDATE embedding_cache_sets
         SET status = 'ready', char_count = $2, updated_at = now()
         WHERE sha256 = $1`,
        [sha256, trimmed.length]
      );
      console.log(`[INGEST] cache_miss_sha256 documentId=${args.documentId} sha256=${sha256}`);
    }

    try {
      if (sha256) {
        const resolved = await resolveInsightsWithoutLLM({
          documentId: args.documentId,
          sha256,
        });
        if (!resolved) {
          await generateAndStoreInsights({
            documentId: args.documentId,
            textSample: trimmed.slice(0, 20000),
            sha256,
          });
        } else {
          console.log(
            `[INGEST] insights_reused_sha256 documentId=${args.documentId} sha256=${sha256}`
          );
        }
      } else if (await documentHasStoredInsights(args.documentId)) {
        console.log(`[INGEST] insights_skip_existing documentId=${args.documentId} (no sha256)`);
      } else {
        await generateAndStoreInsights({
          documentId: args.documentId,
          textSample: trimmed.slice(0, 20000),
        });
      }
    } catch (insightErr) {
      console.error("Insights generation failed:", insightErr);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (sha256) {
      await pool.query(
        `INSERT INTO embedding_cache_sets (sha256, status, source_file_name, updated_at)
         VALUES ($1, 'failed', $2, now())
         ON CONFLICT (sha256)
         DO UPDATE SET status = 'failed', updated_at = now()`,
        [sha256, args.fileName]
      );
    }
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

