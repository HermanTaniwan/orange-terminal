import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Pool } from "pg";
import { getPool } from "./db";
import { allowedUpload, sanitizeFileName } from "./files";
import { ensureUploadRoot, processDocument } from "./ingest";
import { sanitizeIdxPdfUrl } from "./idx";

type IngestJobStatus = "queued" | "running" | "completed" | "failed";

type PythonRunOutput = {
  selected_docs?: {
    title?: string;
    date?: string;
    file_name?: string;
    expected_file_name?: string;
    downloaded_file_name?: string;
    url?: string;
    /** pengumuman.Id2 from IDX API */
    announcement_id?: string;
  }[];
};

let pollerStarted = false;
let pollerBusy = false;
const IDX_CACHE_VERSION = 36;

function nowIso() {
  return new Date().toISOString();
}

function parseIdxDateToIso(raw: string): string | null {
  const s = String(raw || "").trim();
  if (!s) return null;
  // Common IDX style: dd/mm/yyyy [HH:MM[:SS]]
  const m = s.match(
    /^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/
  );
  if (m) {
    const day = Number(m[1]);
    const month = Number(m[2]);
    const year = Number(m[3]);
    const hour = Number(m[4] || "0");
    const minute = Number(m[5] || "0");
    const second = Number(m[6] || "0");
    if (
      Number.isFinite(day) &&
      Number.isFinite(month) &&
      Number.isFinite(year) &&
      day >= 1 &&
      day <= 31 &&
      month >= 1 &&
      month <= 12
    ) {
      return new Date(Date.UTC(year, month - 1, day, hour, minute, second)).toISOString();
    }
  }
  const asDate = new Date(s);
  return Number.isNaN(asDate.getTime()) ? null : asDate.toISOString();
}

function resolvePythonBin(): string {
  return process.env.PYTHON_BIN?.trim() || "python";
}

function resolveIdxWaitSeconds(): string {
  const raw = process.env.IDX_WAIT_SECONDS?.trim();
  const n = raw ? Number(raw) : 10;
  if (!Number.isFinite(n) || n < 0) return "10";
  return String(Math.floor(n));
}

function useIdxHeadless(): boolean {
  return process.env.IDX_HEADLESS === "1" || process.env.IDX_HEADLESS === "true";
}

function buildJobDir(jobId: string): string {
  return resolve(process.cwd(), ".runtime", "idx-jobs", jobId);
}

function buildIdxCacheDir(tickerSymbol: string): string {
  return resolve(process.cwd(), ".runtime", "idx-cache", tickerSymbol.trim().toUpperCase());
}

function buildIdxCacheJsonPath(tickerSymbol: string): string {
  return join(buildIdxCacheDir(tickerSymbol), "result.json");
}

async function firstExistingFile(paths: string[]): Promise<string | null> {
  for (const p of paths) {
    try {
      const s = await stat(p);
      if (s.isFile()) return p;
    } catch {
      // ignore
    }
  }
  return null;
}

async function resolveDownloadedSourcePath(args: {
  outputDir: string;
  diskName: string;
  fileName: string;
}): Promise<string | null> {
  const fallbackDir =
    process.env.IDX_FALLBACK_DOWNLOAD_DIR?.trim() || join(homedir(), "Downloads", "idx-dokumen");
  const candidates = [
    join(args.outputDir, args.diskName),
    join(args.outputDir, args.fileName),
    join(fallbackDir, args.diskName),
    join(fallbackDir, args.fileName),
  ];
  return await firstExistingFile(candidates);
}

async function fetchPdfBufferFromUrl(url: string): Promise<Buffer> {
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
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const ab = await res.arrayBuffer();
    return Buffer.from(ab);
  } finally {
    clearTimeout(timeout);
  }
}

async function loadCachedIdxResult(tickerSymbol: string): Promise<PythonRunOutput | null> {
  const p = buildIdxCacheJsonPath(tickerSymbol);
  try {
    const raw = await readFile(p, "utf-8");
    const parsed = JSON.parse(raw) as { selected_docs?: unknown; cacheVersion?: number };
    if (parsed.cacheVersion !== IDX_CACHE_VERSION) return null;
    const docs = Array.isArray(parsed.selected_docs)
      ? (parsed.selected_docs as NonNullable<PythonRunOutput["selected_docs"]>)
      : [];
    return docs.length > 0 ? { selected_docs: docs } : null;
  } catch {
    return null;
  }
}

async function saveCachedIdxResult(tickerSymbol: string, parsed: PythonRunOutput): Promise<void> {
  const dir = buildIdxCacheDir(tickerSymbol);
  const p = buildIdxCacheJsonPath(tickerSymbol);
  await mkdir(dir, { recursive: true });
  const wrapped = {
    cacheVersion: IDX_CACHE_VERSION,
    savedAt: nowIso(),
    selected_docs: Array.isArray(parsed.selected_docs) ? parsed.selected_docs : [],
  };
  await writeFile(p, JSON.stringify(wrapped, null, 2), "utf-8");
}

async function loadImportedIdxSkipState(projectId: string): Promise<{
  urls: Set<string>;
  legacyAnnouncementIds: Set<string>;
}> {
  const pool = getPool();
  const { rows } = await pool.query<{
    idx_source_url: string | null;
    idx_announcement_id: string | null;
  }>(
    `SELECT idx_source_url, idx_announcement_id
     FROM documents
     WHERE project_id = $1::uuid AND deleted_at IS NULL`,
    [projectId]
  );
  const urls = new Set<string>();
  const legacyAnnouncementIds = new Set<string>();
  for (const r of rows) {
    const u = String(r.idx_source_url ?? "").trim();
    const aid = String(r.idx_announcement_id ?? "").trim();
    if (u) {
      urls.add(sanitizeIdxPdfUrl(u));
    } else if (aid) {
      legacyAnnouncementIds.add(aid);
    }
  }
  return { urls, legacyAnnouncementIds };
}

function filterSelectedDocsAlreadyImported(
  parsed: PythonRunOutput,
  state: { urls: Set<string>; legacyAnnouncementIds: Set<string> }
): PythonRunOutput {
  const docs = parsed.selected_docs;
  if (!Array.isArray(docs)) return parsed;
  if (state.urls.size === 0 && state.legacyAnnouncementIds.size === 0) return parsed;
  const filtered = docs.filter((d) => {
    const u = sanitizeIdxPdfUrl(String(d.url || ""));
    const aid = String(d.announcement_id || "").trim();
    if (u && state.urls.has(u)) return false;
    if (aid && state.legacyAnnouncementIds.has(aid)) return false;
    return true;
  });
  return { ...parsed, selected_docs: filtered };
}

/**
 * Apply OriginalFilename from full IDX JSON to existing rows. Runs before
 * filterSelectedDocsAlreadyImported so re-ingest still updates names when all Id2 are "known".
 */
async function syncIdxFileNamesFromPayload(
  projectId: string,
  parsed: PythonRunOutput
): Promise<number> {
  const pool = getPool();
  const docs = parsed.selected_docs;
  if (!Array.isArray(docs)) return 0;
  let n = 0;
  for (const d of docs) {
    const fileName = String(d.file_name || d.expected_file_name || "").trim();
    const sourceUrl = String(d.url || "").trim();
    const announcementId = String(d.announcement_id || "").trim();
    if (!fileName || !allowedUpload(fileName)) continue;
    if (announcementId) {
      const urlKey = sourceUrl ? sanitizeIdxPdfUrl(sourceUrl) : "";
      if (urlKey) {
        const { rowCount } = await pool.query(
          `UPDATE documents
           SET file_name = $3
           WHERE project_id = $1::uuid
             AND idx_announcement_id = $2
             AND idx_source_url = $4
             AND deleted_at IS NULL
             AND file_name IS DISTINCT FROM $3`,
          [projectId, announcementId, fileName, urlKey]
        );
        n += rowCount ?? 0;
      } else {
        const { rowCount } = await pool.query(
          `UPDATE documents
           SET file_name = $3
           WHERE project_id = $1::uuid
             AND idx_announcement_id = $2
             AND idx_source_url IS NULL
             AND deleted_at IS NULL
             AND file_name IS DISTINCT FROM $3`,
          [projectId, announcementId, fileName]
        );
        n += rowCount ?? 0;
      }
    } else if (sourceUrl) {
      const { rowCount } = await pool.query(
        `UPDATE documents
         SET file_name = $3
         WHERE project_id = $1::uuid
           AND idx_source_url = $2
           AND deleted_at IS NULL
           AND file_name IS DISTINCT FROM $3`,
        [projectId, sourceUrl, fileName]
      );
      n += rowCount ?? 0;
    }
  }
  return n;
}

/** Manual backfill: match project docs to ticker IDX cache and set file_name from JSON. */
export async function backfillIdxDocumentFileNamesFromCache(projectId: string): Promise<{
  updated: number;
  ticker: string | null;
  cacheHit: boolean;
}> {
  const pool = getPool();
  const { rows } = await pool.query<{ ticker_symbol: string | null }>(
    `SELECT ticker_symbol FROM projects WHERE id = $1::uuid AND project_type = 'emiten'`,
    [projectId]
  );
  const ticker = rows[0]?.ticker_symbol?.trim().toUpperCase() || null;
  if (!ticker) return { updated: 0, ticker: null, cacheHit: false };
  const parsed = await loadCachedIdxResult(ticker);
  if (!parsed?.selected_docs?.length) {
    return { updated: 0, ticker, cacheHit: false };
  }
  const updated = await syncIdxFileNamesFromPayload(projectId, parsed);
  return { updated, ticker, cacheHit: true };
}

async function runPythonIdxJob(args: {
  tickerSymbol: string;
  outputDir: string;
  jsonOut: string;
  skipAnnouncementIdsFile?: string;
  onStdoutLine?: (line: string) => void;
}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  await mkdir(args.outputDir, { recursive: true });
  const scriptPath = resolve(process.cwd(), "scripts", "idx_download_annual_reports.py");
  const cmdArgs = [
    scriptPath,
    "--kode",
    args.tickerSymbol,
    "--output-dir",
    args.outputDir,
    "--wait-seconds",
    resolveIdxWaitSeconds(),
    "--no-prompt",
    "--json-out",
    args.jsonOut,
  ];
  if (args.skipAnnouncementIdsFile) {
    cmdArgs.push("--skip-announcement-ids-file", args.skipAnnouncementIdsFile);
  }
  if (useIdxHeadless()) {
    cmdArgs.push("--headless");
  }

  return await new Promise((resolveRun) => {
    const child = spawn(resolvePythonBin(), cmdArgs, {
      cwd: process.cwd(),
      env: process.env,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let stdoutBuf = "";
    child.stdout.on("data", (d) => {
      const s = String(d);
      stdout += s;
      stdoutBuf += s;
      const parts = stdoutBuf.split(/\r?\n/);
      stdoutBuf = parts.pop() || "";
      for (const line of parts) {
        const t = line.trim();
        if (!t) continue;
        args.onStdoutLine?.(t);
      }
    });
    child.stderr.on("data", (d) => {
      stderr += String(d);
    });
    child.on("close", (code) => {
      resolveRun({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}

async function enqueueEmitenIngestJobInternal(args: {
  projectId: string;
  tickerSymbol: string;
  force?: boolean;
}): Promise<{ jobId: string | null; skipped: boolean }> {
  const pool = getPool();
  if (!args.force) {
    const { rows: activeRows } = await pool.query<{ id: string }>(
      `SELECT id FROM emiten_ingest_jobs
       WHERE project_id = $1::uuid AND status IN ('queued', 'running')
       ORDER BY created_at DESC
       LIMIT 1`,
      [args.projectId]
    );
    if (activeRows[0]) return { jobId: activeRows[0].id, skipped: true };
  }

  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO emiten_ingest_jobs (project_id, ticker_symbol, status)
     VALUES ($1::uuid, $2, 'queued')
     RETURNING id`,
    [args.projectId, args.tickerSymbol]
  );
  return { jobId: rows[0]?.id ?? null, skipped: false };
}

async function updateJobStatus(args: {
  jobId: string;
  status: IngestJobStatus;
  errorMessage?: string | null;
  metrics?: Record<string, unknown>;
  started?: boolean;
  finished?: boolean;
}) {
  const pool = getPool();
  const setParts = ["status = $2", "updated_at = now()"];
  const values: unknown[] = [args.jobId, args.status];
  let idx = 3;
  if (args.errorMessage !== undefined) {
    setParts.push(`error_message = $${idx++}`);
    values.push(args.errorMessage);
  }
  if (args.metrics !== undefined) {
    setParts.push(`metrics_json = $${idx++}::jsonb`);
    values.push(JSON.stringify(args.metrics || {}));
  }
  if (args.started) setParts.push("started_at = now()");
  if (args.finished) setParts.push("finished_at = now()");
  await pool.query(
    `UPDATE emiten_ingest_jobs
     SET ${setParts.join(", ")}
     WHERE id = $1::uuid`,
    values
  );
}

/**
 * Duplikat per project: SHA sama DAN identitas IDX sama.
 * - Ada URL: cocokkan `idx_source_url` (PDF identik lintas kuartal = URL beda → baris terpisah).
 * - Tanpa URL (payload legacy / parsial): cocokkan `idx_announcement_id` agar byte-identik
 *   antar pengumuman tidak menimpa kuartal lain.
 * - Tanpa URL dan tanpa announcement_id: fallback lama (SHA saja).
 */
async function findActiveDocDuplicateByShaAndIdxUrl(args: {
  pool: Pool;
  projectId: string;
  sha256: string;
  sourceUrlKey: string;
  announcementId?: string;
}): Promise<string | null> {
  const ann = String(args.announcementId ?? "").trim();
  if (args.sourceUrlKey) {
    const { rows } = await args.pool.query<{ id: string }>(
      `SELECT id FROM documents
       WHERE project_id = $1::uuid AND sha256 = $2 AND deleted_at IS NULL
         AND idx_source_url = $3
       LIMIT 1`,
      [args.projectId, args.sha256, args.sourceUrlKey]
    );
    return rows[0]?.id ?? null;
  }
  if (ann) {
    const { rows } = await args.pool.query<{ id: string }>(
      `SELECT id FROM documents
       WHERE project_id = $1::uuid AND sha256 = $2 AND deleted_at IS NULL
         AND idx_announcement_id = $3
       LIMIT 1`,
      [args.projectId, args.sha256, ann]
    );
    return rows[0]?.id ?? null;
  }
  const { rows } = await args.pool.query<{ id: string }>(
    `SELECT id FROM documents
     WHERE project_id = $1::uuid AND sha256 = $2 AND deleted_at IS NULL
     LIMIT 1`,
    [args.projectId, args.sha256]
  );
  return rows[0]?.id ?? null;
}

async function importDownloadedDocs(args: {
  projectId: string;
  outputDir: string;
  parsed: PythonRunOutput;
  onProgress?: (s: {
    total: number;
    processed: number;
    importedCount: number;
    skippedCount: number;
    failedCount: number;
    duplicateReadyCount: number;
    skipDuplicateProjectCount: number;
    skipNoFileCount: number;
    skipUnsupportedCount: number;
    currentFile?: string;
    action?: string;
  }) => Promise<void>;
}): Promise<{
  importedCount: number;
  skippedCount: number;
  failedCount: number;
  total: number;
  duplicateReadyCount: number;
  skipDuplicateProjectCount: number;
  skipNoFileCount: number;
  skipUnsupportedCount: number;
}> {
  const pool = getPool();
  const root = await ensureUploadRoot();
  const docs = Array.isArray(args.parsed.selected_docs) ? args.parsed.selected_docs : [];
  const total = docs.length;
  let importedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;
  let duplicateReadyCount = 0;
  let skipDuplicateProjectCount = 0;
  let skipNoFileCount = 0;
  let skipUnsupportedCount = 0;
  let processed = 0;

  for (const d of docs) {
    const announcementId = String(d.announcement_id || "").trim();
    const fileName = String(d.file_name || d.expected_file_name || "").trim();
    const downloadedName = String(d.downloaded_file_name || "").trim();
    const sourceUrl = String(d.url || "").trim();
    const sourceUrlKey = sourceUrl ? sanitizeIdxPdfUrl(sourceUrl) : "";
    const idxDateIso = parseIdxDateToIso(String(d.date || ""));

    if (sourceUrlKey) {
      const { rows: dupByUrlRows } = await pool.query<{ id: string }>(
        `SELECT id
         FROM documents
         WHERE project_id = $1::uuid AND idx_source_url = $2 AND deleted_at IS NULL
         LIMIT 1`,
        [args.projectId, sourceUrlKey]
      );
      const dupByUrlId = dupByUrlRows[0]?.id;
      if (dupByUrlId) {
        if (fileName && allowedUpload(fileName)) {
          await pool.query(
            `UPDATE documents
             SET file_name = $2,
                 idx_announcement_id = COALESCE(NULLIF(trim($3::text), ''), idx_announcement_id)
             WHERE id = $1::uuid`,
            [dupByUrlId, fileName, announcementId || null]
          );
        }
        skippedCount += 1;
        skipDuplicateProjectCount += 1;
        processed += 1;
        if (args.onProgress) {
          await args.onProgress({
            total,
            processed,
            importedCount,
            skippedCount,
            failedCount,
            duplicateReadyCount,
            skipDuplicateProjectCount,
            skipNoFileCount,
            skipUnsupportedCount,
            currentFile: fileName,
            action: "skip_duplicate_idx_url",
          });
        }
        continue;
      }
    } else if (announcementId) {
      const { rows: dupAnnRows } = await pool.query<{ id: string }>(
        `SELECT id
         FROM documents
         WHERE project_id = $1::uuid AND idx_announcement_id = $2 AND deleted_at IS NULL
         LIMIT 1`,
        [args.projectId, announcementId]
      );
      const dupAnnId = dupAnnRows[0]?.id;
      if (dupAnnId) {
        if (fileName && allowedUpload(fileName)) {
          await pool.query(
            `UPDATE documents
             SET file_name = $2,
                 idx_source_url = COALESCE(NULLIF(trim($3::text), ''), idx_source_url)
             WHERE id = $1::uuid`,
            [dupAnnId, fileName, sourceUrl || null]
          );
        }
        skippedCount += 1;
        skipDuplicateProjectCount += 1;
        processed += 1;
        if (args.onProgress) {
          await args.onProgress({
            total,
            processed,
            importedCount,
            skippedCount,
            failedCount,
            duplicateReadyCount,
            skipDuplicateProjectCount,
            skipNoFileCount,
            skipUnsupportedCount,
            currentFile: fileName,
            action: "skip_duplicate_idx_announcement_id",
          });
        }
        continue;
      }
    }
    if (!fileName) {
      skippedCount += 1;
      skipNoFileCount += 1;
      processed += 1;
      if (args.onProgress) {
        await args.onProgress({
          total,
          processed,
          importedCount,
          skippedCount,
          failedCount,
          duplicateReadyCount,
          skipDuplicateProjectCount,
          skipNoFileCount,
          skipUnsupportedCount,
          currentFile: fileName,
          action: "skip_missing_filename",
        });
      }
      continue;
    }
    if (!allowedUpload(fileName)) {
      skippedCount += 1;
      skipUnsupportedCount += 1;
      processed += 1;
      if (args.onProgress) {
        await args.onProgress({
          total,
          processed,
          importedCount,
          skippedCount,
          failedCount,
          duplicateReadyCount,
          skipDuplicateProjectCount,
          skipNoFileCount,
          skipUnsupportedCount,
          currentFile: fileName,
          action: "skip_unsupported_extension",
        });
      }
      continue;
    }
    const diskName = downloadedName || fileName;
    try {
      if (sourceUrlKey) {
        const { rows: localByUrl } = await pool.query<{
          id: string;
          deleted_at: string | null;
          status: string;
          storage_path: string;
        }>(
          `SELECT id, deleted_at, status, storage_path
           FROM documents
           WHERE project_id = $1::uuid AND idx_source_url = $2
           LIMIT 1`,
          [args.projectId, sourceUrlKey]
        );
        const loc = localByUrl[0];
        if (loc) {
          if (!loc.deleted_at) {
            if (fileName && allowedUpload(fileName)) {
              await pool.query(
                `UPDATE documents
                 SET file_name = $2,
                     idx_announcement_id = COALESCE(NULLIF(trim($3::text), ''), idx_announcement_id)
                 WHERE id = $1::uuid`,
                [loc.id, fileName, announcementId || null]
              );
            }
            skippedCount += 1;
            skipDuplicateProjectCount += 1;
            processed += 1;
            if (args.onProgress) {
              await args.onProgress({
                total,
                processed,
                importedCount,
                skippedCount,
                failedCount,
                duplicateReadyCount,
                skipDuplicateProjectCount,
                skipNoFileCount,
                skipUnsupportedCount,
                currentFile: fileName,
                action: "skip_duplicate_idx_url",
              });
            }
            continue;
          }
          await pool.query(
            `UPDATE documents
             SET deleted_at = NULL,
                 file_name = $2,
                 created_at = COALESCE($3::timestamptz, created_at),
                 error_message = NULL,
                 idx_source_url = COALESCE($4, idx_source_url),
                 idx_announcement_id = COALESCE($5, idx_announcement_id)
             WHERE id = $1::uuid`,
            [loc.id, fileName, idxDateIso, sourceUrlKey || null, announcementId || null]
          );
          if (loc.status === "ready") {
            importedCount += 1;
          } else {
            await processDocument({
              documentId: loc.id,
              filePath: loc.storage_path,
              mimeType: "application/pdf",
              fileName,
            });
            importedCount += 1;
          }
          processed += 1;
          if (args.onProgress) {
            await args.onProgress({
              total,
              processed,
              importedCount,
              skippedCount,
              failedCount,
              duplicateReadyCount,
              skipDuplicateProjectCount,
              skipNoFileCount,
              skipUnsupportedCount,
              currentFile: fileName,
              action: "restored_soft_deleted_idx_url",
            });
          }
          continue;
        }

        const { rows: repoRows } = await pool.query<{
          project_id: string;
          storage_path: string;
          sha256: string | null;
        }>(
          `SELECT project_id, storage_path, sha256
           FROM documents
           WHERE idx_source_url = $1 AND deleted_at IS NULL
           LIMIT 1`,
          [sourceUrlKey]
        );
        const repo = repoRows[0];
        if (repo && repo.project_id !== args.projectId) {
          const buf = await readFile(repo.storage_path);
          const sha256 =
            (repo.sha256 && String(repo.sha256).trim()) ||
            createHash("sha256").update(buf).digest("hex");

          const activeDupId = await findActiveDocDuplicateByShaAndIdxUrl({
            pool,
            projectId: args.projectId,
            sha256,
            sourceUrlKey,
            announcementId,
          });
          if (activeDupId) {
            skippedCount += 1;
            skipDuplicateProjectCount += 1;
            processed += 1;
            if (args.onProgress) {
              await args.onProgress({
                total,
                processed,
                importedCount,
                skippedCount,
                failedCount,
                duplicateReadyCount,
                skipDuplicateProjectCount,
                skipNoFileCount,
                skipUnsupportedCount,
                currentFile: fileName,
                action: "skip_duplicate_already_in_project",
              });
            }
            continue;
          }

          const { rows: cacheRowsRepo } = await pool.query<{ status: string | null }>(
            `SELECT status FROM embedding_cache_sets WHERE sha256 = $1`,
            [sha256]
          );
          const cacheReadyRepo = cacheRowsRepo[0]?.status === "ready";
          if (cacheReadyRepo) {
            duplicateReadyCount += 1;
          }

          const documentId = randomUUID();
          const safeName = sanitizeFileName(fileName);
          const dir = join(root, documentId);
          await mkdir(dir, { recursive: true });
          const storagePath = join(dir, safeName);
          await writeFile(storagePath, buf);
          await pool.query(
            `INSERT INTO documents (id, project_id, file_name, mime_type, storage_path, status, sha256, created_at, idx_source_url, idx_announcement_id)
             VALUES ($1::uuid, $2::uuid, $3, $4, $5, 'pending', $6, COALESCE($7::timestamptz, now()), $8, $9)`,
            [
              documentId,
              args.projectId,
              fileName,
              "application/pdf",
              storagePath,
              sha256,
              idxDateIso,
              sourceUrlKey,
              announcementId || null,
            ]
          );
          if (args.onProgress) {
            await args.onProgress({
              total,
              processed,
              importedCount,
              skippedCount,
              failedCount,
              duplicateReadyCount,
              skipDuplicateProjectCount,
              skipNoFileCount,
              skipUnsupportedCount,
              currentFile: fileName,
              action: cacheReadyRepo ? "copy_from_repo_cache_ready" : "copy_from_repo_embedding",
            });
          }
          await processDocument({
            documentId,
            filePath: storagePath,
            mimeType: "application/pdf",
            fileName,
          });
          importedCount += 1;
          processed += 1;
          if (args.onProgress) {
            await args.onProgress({
              total,
              processed,
              importedCount,
              skippedCount,
              failedCount,
              duplicateReadyCount,
              skipDuplicateProjectCount,
              skipNoFileCount,
              skipUnsupportedCount,
              currentFile: fileName,
              action: "processed",
            });
          }
          continue;
        }
      }

      const srcPath = await resolveDownloadedSourcePath({
        outputDir: args.outputDir,
        diskName,
        fileName,
      });
      let buffer: Buffer;
      if (srcPath) {
        const info = await stat(srcPath);
        if (!info.isFile()) {
          throw new Error("source path is not a file");
        }
        buffer = await readFile(srcPath);
      } else if (sourceUrl) {
        if (args.onProgress) {
          await args.onProgress({
            total,
            processed,
            importedCount,
            skippedCount,
            failedCount,
            duplicateReadyCount,
            skipDuplicateProjectCount,
            skipNoFileCount,
            skipUnsupportedCount,
            currentFile: fileName,
            action: "redownload_from_url",
          });
        }
        buffer = await fetchPdfBufferFromUrl(sourceUrl);
      } else {
        skippedCount += 1;
        skipNoFileCount += 1;
        processed += 1;
        if (args.onProgress) {
          await args.onProgress({
            total,
            processed,
            importedCount,
            skippedCount,
            failedCount,
            duplicateReadyCount,
            skipDuplicateProjectCount,
            skipNoFileCount,
            skipUnsupportedCount,
            currentFile: fileName,
            action: "skip_download_not_found",
          });
        }
        continue;
      }
      const sha256 = createHash("sha256").update(buffer).digest("hex");

      const dupShaId = await findActiveDocDuplicateByShaAndIdxUrl({
        pool,
        projectId: args.projectId,
        sha256,
        sourceUrlKey,
        announcementId,
      });
      if (dupShaId) {
        if (fileName && allowedUpload(fileName)) {
          await pool.query(
            `UPDATE documents
             SET file_name = $2,
                 idx_announcement_id = COALESCE(NULLIF(trim($3::text), ''), idx_announcement_id)
             WHERE id = $1::uuid`,
            [dupShaId, fileName, announcementId || null]
          );
        }
        skippedCount += 1;
        skipDuplicateProjectCount += 1;
        processed += 1;
        if (args.onProgress) {
          await args.onProgress({
            total,
            processed,
            importedCount,
            skippedCount,
            failedCount,
            duplicateReadyCount,
            skipDuplicateProjectCount,
            skipNoFileCount,
            skipUnsupportedCount,
            currentFile: fileName,
            action: "skip_duplicate_already_in_project",
          });
        }
        continue;
      }

      const softParams: unknown[] = [args.projectId, sha256];
      let softWhere = `project_id = $1::uuid AND sha256 = $2 AND deleted_at IS NOT NULL`;
      if (sourceUrlKey) {
        softParams.push(sourceUrlKey);
        softWhere += ` AND idx_source_url = $${softParams.length}`;
      } else if (announcementId) {
        softParams.push(announcementId);
        softWhere += ` AND idx_announcement_id = $${softParams.length}`;
      }
      const { rows: softRows } = await pool.query<{
        id: string;
        status: string;
        storage_path: string;
      }>(
        `SELECT id, status, storage_path
         FROM documents
         WHERE ${softWhere}
         ORDER BY created_at DESC
         LIMIT 1`,
        softParams
      );
      const soft = softRows[0];
      if (soft) {
        await pool.query(
          `UPDATE documents
           SET deleted_at = NULL,
               file_name = $2,
               created_at = COALESCE($3::timestamptz, created_at),
               error_message = NULL,
               idx_source_url = COALESCE($4, idx_source_url),
               idx_announcement_id = COALESCE($5, idx_announcement_id)
           WHERE id = $1::uuid`,
          [soft.id, fileName, idxDateIso, sourceUrlKey || null, announcementId || null]
        );
        if (soft.status === "ready") {
          importedCount += 1;
        } else {
          await processDocument({
            documentId: soft.id,
            filePath: soft.storage_path,
            mimeType: "application/pdf",
            fileName,
          });
          importedCount += 1;
        }
        processed += 1;
        if (args.onProgress) {
          await args.onProgress({
            total,
            processed,
            importedCount,
            skippedCount,
            failedCount,
            duplicateReadyCount,
            skipDuplicateProjectCount,
            skipNoFileCount,
            skipUnsupportedCount,
            currentFile: fileName,
            action: "restored_soft_deleted_sha256",
          });
        }
        continue;
      }

      const { rows: cacheRows } = await pool.query<{ status: string | null }>(
        `SELECT status FROM embedding_cache_sets WHERE sha256 = $1`,
        [sha256]
      );
      const cacheReady = cacheRows[0]?.status === "ready";
      if (cacheReady) {
        duplicateReadyCount += 1;
        if (args.onProgress) {
          await args.onProgress({
            total,
            processed,
            importedCount,
            skippedCount,
            failedCount,
            duplicateReadyCount,
            skipDuplicateProjectCount,
            skipNoFileCount,
            skipUnsupportedCount,
            currentFile: fileName,
            action: "reuse_embedding_cache",
          });
        }
      }

      const documentId = randomUUID();
      const safeName = sanitizeFileName(fileName);
      const dir = join(root, documentId);
      await mkdir(dir, { recursive: true });
      const storagePath = join(dir, safeName);
      await writeFile(storagePath, buffer);
      await pool.query(
        `INSERT INTO documents (id, project_id, file_name, mime_type, storage_path, status, sha256, created_at, idx_source_url, idx_announcement_id)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5, 'pending', $6, COALESCE($7::timestamptz, now()), $8, $9)`,
        [
          documentId,
          args.projectId,
          fileName,
          "application/pdf",
          storagePath,
          sha256,
          idxDateIso,
          sourceUrlKey || null,
          announcementId || null,
        ]
      );
      if (args.onProgress) {
        await args.onProgress({
          total,
          processed,
          importedCount,
          skippedCount,
          failedCount,
          duplicateReadyCount,
          skipDuplicateProjectCount,
          skipNoFileCount,
          skipUnsupportedCount,
          currentFile: fileName,
          action: cacheReady ? "indexing_document_cache_ready" : "embedding_document",
        });
      }
      await processDocument({
        documentId,
        filePath: storagePath,
        mimeType: "application/pdf",
        fileName,
      });
      importedCount += 1;
    } catch {
      failedCount += 1;
    }
    processed += 1;
    if (args.onProgress) {
      await args.onProgress({
        total,
        processed,
        importedCount,
        skippedCount,
        failedCount,
        duplicateReadyCount,
        skipDuplicateProjectCount,
        skipNoFileCount,
        skipUnsupportedCount,
        currentFile: fileName,
        action: failedCount > 0 ? "failed_processing" : "processed",
      });
    }
  }

  return {
    importedCount,
    skippedCount,
    failedCount,
    total,
    duplicateReadyCount,
    skipDuplicateProjectCount,
    skipNoFileCount,
    skipUnsupportedCount,
  };
}

async function runOneQueuedJob(): Promise<void> {
  if (pollerBusy) return;
  pollerBusy = true;
  const pool = getPool();
  try {
    const client = await pool.connect();
    let job:
      | { id: string; project_id: string; ticker_symbol: string }
      | undefined;
    try {
      await client.query("BEGIN");
      const { rows } = await client.query<{
        id: string;
        project_id: string;
        ticker_symbol: string;
      }>(
        `SELECT id, project_id, ticker_symbol
         FROM emiten_ingest_jobs
         WHERE status = 'queued'
         ORDER BY created_at ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED`
      );
      job = rows[0];
      if (!job) {
        await client.query("COMMIT");
        return;
      }
      await client.query(
        `UPDATE emiten_ingest_jobs
         SET status = 'running', started_at = now(), updated_at = now(), error_message = NULL,
             metrics_json = $2::jsonb
         WHERE id = $1::uuid`,
        [job.id, JSON.stringify({ stage: "Memulai job ingest" })]
      );
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
    if (!job) return;

    const jobDir = buildJobDir(job.id);
    await mkdir(jobDir, { recursive: true });
    const outputDir = join(jobDir, "downloads");
    const jsonOut = join(jobDir, "result.json");
    const idxSkipState = await loadImportedIdxSkipState(job.project_id);
    const skipPayload: string[] = [];
    for (const u of idxSkipState.urls) skipPayload.push(u);
    for (const aid of idxSkipState.legacyAnnouncementIds) skipPayload.push(`id:${aid}`);
    const skipAnnPath = join(jobDir, "known_announcement_ids.json");
    await writeFile(skipAnnPath, JSON.stringify(skipPayload), "utf-8");

    let parsed: PythonRunOutput = {};
    let runStdoutPreview = "";
    let runStderrPreview = "";
    let parsedSource: "cache" | "python" = "cache";

    const cached = await loadCachedIdxResult(job.ticker_symbol);
    if (cached) {
      parsed = cached;
      await updateJobStatus({
        jobId: job.id,
        status: "running",
        metrics: { stage: "Menggunakan data IDX tersimpan (cache lokal)" },
      });
    } else {
      await updateJobStatus({
        jobId: job.id,
        status: "running",
        metrics: { stage: "Menarik dokumen IDX (python)" },
      });
      const run = await runPythonIdxJob({
        tickerSymbol: job.ticker_symbol,
        outputDir,
        jsonOut,
        skipAnnouncementIdsFile: skipAnnPath,
        onStdoutLine: (line) => {
          const m = line.match(/^DOWNLOAD_FILE:\s*(.+)$/i);
          if (!m) return;
          const downloadingFile = m[1].trim();
          void updateJobStatus({
            jobId: job!.id,
            status: "running",
            metrics: {
              stage: "Menarik dokumen IDX (python)",
              downloadingFile,
            },
          });
        },
      });
      runStdoutPreview = run.stdout.slice(0, 1000);
      runStderrPreview = run.stderr.slice(0, 1000);
      if (run.exitCode !== 0) {
        await updateJobStatus({
          jobId: job.id,
          status: "failed",
          errorMessage: `python_exit_${run.exitCode}: ${run.stderr.slice(0, 1200)}`,
          metrics: {
            ranAt: nowIso(),
            source: "python",
            stdoutPreview: runStdoutPreview,
            stderrPreview: runStderrPreview,
          },
          finished: true,
        });
        return;
      }
      try {
        const raw = await readFile(jsonOut, "utf-8");
        parsed = JSON.parse(raw) as PythonRunOutput;
        parsedSource = "python";
        await saveCachedIdxResult(job.ticker_symbol, parsed);
      } catch (e) {
        await updateJobStatus({
          jobId: job.id,
          status: "failed",
          errorMessage: `invalid_json_output: ${e instanceof Error ? e.message : String(e)}`,
          metrics: {
            ranAt: nowIso(),
            source: "python",
            stdoutPreview: runStdoutPreview,
            stderrPreview: runStderrPreview,
          },
          finished: true,
        });
        return;
      }
    }

    await syncIdxFileNamesFromPayload(job.project_id, parsed);
    parsed = filterSelectedDocsAlreadyImported(parsed, idxSkipState);

    const imported = await importDownloadedDocs({
      projectId: job.project_id,
      outputDir,
      parsed,
      onProgress: async (p) => {
        await updateJobStatus({
          jobId: job!.id,
          status: "running",
          metrics: {
            stage: "Import + embedding dokumen",
            source: parsedSource,
            totalCandidates: p.total,
            processedCandidates: p.processed,
            importedCount: p.importedCount,
            skippedCount: p.skippedCount,
            failedCount: p.failedCount,
            duplicateReadyCount: p.duplicateReadyCount,
            skipDuplicateProjectCount: p.skipDuplicateProjectCount,
            skipNoFileCount: p.skipNoFileCount,
            skipUnsupportedCount: p.skipUnsupportedCount,
            embeddingFile: p.action === "embedding_document" ? p.currentFile || "" : undefined,
            lastAction: p.action || "",
            lastFile: p.currentFile || "",
          },
        });
      },
    });

    if (imported.total > 0 && imported.importedCount === 0 && imported.skipNoFileCount === imported.total) {
      await updateJobStatus({
        jobId: job.id,
        status: "failed",
        errorMessage:
          "Semua kandidat PDF tidak ditemukan di folder job/fallback. Cek jalur download browser.",
        metrics: {
          ranAt: nowIso(),
          stage: "Gagal",
          source: parsedSource,
          totalCandidates: imported.total,
          importedCount: imported.importedCount,
          skippedCount: imported.skippedCount,
          failedCount: imported.failedCount,
          duplicateReadyCount: imported.duplicateReadyCount,
          skipDuplicateProjectCount: imported.skipDuplicateProjectCount,
          skipNoFileCount: imported.skipNoFileCount,
          skipUnsupportedCount: imported.skipUnsupportedCount,
        },
        finished: true,
      });
      return;
    }

    await updateJobStatus({
      jobId: job.id,
      status: "completed",
      errorMessage: null,
      metrics: {
        ranAt: nowIso(),
        stage: "Selesai",
        source: parsedSource,
        totalCandidates: imported.total,
        importedCount: imported.importedCount,
        skippedCount: imported.skippedCount,
        failedCount: imported.failedCount,
        duplicateReadyCount: imported.duplicateReadyCount,
        skipDuplicateProjectCount: imported.skipDuplicateProjectCount,
        skipNoFileCount: imported.skipNoFileCount,
        skipUnsupportedCount: imported.skipUnsupportedCount,
      },
      finished: true,
    });
  } catch (e) {
    console.error("[INGEST_JOB] runOneQueuedJob failed:", e);
  } finally {
    pollerBusy = false;
  }
}

export function ensureEmitenIngestPollerStarted() {
  if (pollerStarted) return;
  pollerStarted = true;
  setInterval(() => {
    void runOneQueuedJob();
  }, 8_000);
}

export async function enqueueEmitenIngestJob(args: {
  projectId: string;
  tickerSymbol: string;
  force?: boolean;
}): Promise<{ jobId: string | null; skipped: boolean }> {
  ensureEmitenIngestPollerStarted();
  const out = await enqueueEmitenIngestJobInternal(args);
  void runOneQueuedJob();
  return out;
}

export async function getLatestEmitenIngestJobsByProject(projectIds: string[]): Promise<
  Map<
    string,
    {
      id: string;
      status: IngestJobStatus;
      error_message: string | null;
      metrics_json: Record<string, unknown> | null;
      created_at: string;
      updated_at: string;
    }
  >
> {
  const m = new Map<
    string,
    {
      id: string;
      status: IngestJobStatus;
      error_message: string | null;
      metrics_json: Record<string, unknown> | null;
      created_at: string;
      updated_at: string;
    }
  >();
  if (projectIds.length === 0) return m;
  const pool = getPool();
  const { rows } = await pool.query<{
    project_id: string;
    id: string;
    status: IngestJobStatus;
    error_message: string | null;
    metrics_json: Record<string, unknown> | null;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT DISTINCT ON (project_id)
        project_id, id, status, error_message, metrics_json, created_at, updated_at
     FROM emiten_ingest_jobs
     WHERE project_id = ANY($1::uuid[])
     ORDER BY project_id, created_at DESC`,
    [projectIds]
  );
  for (const r of rows) {
    m.set(r.project_id, {
      id: r.id,
      status: r.status,
      error_message: r.error_message,
      metrics_json: r.metrics_json,
      created_at: r.created_at,
      updated_at: r.updated_at,
    });
  }
  return m;
}

