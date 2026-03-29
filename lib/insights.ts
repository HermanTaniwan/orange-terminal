import { getPool } from "./db";
import { chatCompletionJson } from "./openrouter";
import type { DocumentInsights } from "./types";

const INSIGHTS_MODEL = "minimax/minimax-m1";

function stripJsonFence(s: string): string {
  let t = s.trim();
  if (t.startsWith("```")) {
    t = t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  }
  return t.trim();
}

export async function generateInsightsFromText(
  textSample: string
): Promise<DocumentInsights> {
  const system = `Kamu adalah analis value investing yang skeptis. Output HANYA valid JSON dengan bentuk persis ini (tanpa markdown). Semua teks di dalam JSON harus berbahasa Indonesia:
{"importantInfo":["string"],"redFlags":["string"],"keyMetrics":[{"label":"string","value":"string"}]}
Rules:
- Aturan auditor/opini audit:
  - Jangan jadikan auditor/opini audit sebagai poin insight default.
  - Jika opini audit normal "Wajar Tanpa Pengecualian (WTP)", JANGAN sebut sama sekali di Important info maupun Red flags.
  - HANYA boleh disebut jika opini audit bukan WTP / ada modifikasi opini (qualified, adverse, disclaimer, atau emphasis of matter yang material).
  - Prioritas utama tetap analisis bisnis dan nilai intrinsik dari POV value investor, bukan kepatuhan audit rutin.
- importantInfo: 3-5 poin paling material dari POV value investor. Prioritaskan:
  1) kualitas bisnis/moat (pricing power, switching cost, posisi kompetitif),
  2) kualitas manajemen & capital allocation (buyback/dividen/M&A/capex disiplin),
  3) kualitas laba & arus kas (recurring vs one-off, cash conversion),
  4) neraca dan struktur modal (utang, likuiditas, refinancing/covenant),
  5) katalis jangka panjang dan risiko downside permanen,
  6) growth story yang kredibel (sumber pertumbuhan, durasi runway, unit economics, kebutuhan modal, dan risiko eksekusi).
  Gaya Important info: netral, faktual, non-sensasional, tetapi memberi efek "aha" (informasi yang investor biasanya luput).
  Setiap poin harus terasa useful untuk pengambilan keputusan investasi.
  Pilih hanya poin yang benar-benar insightful; jangan dipaksa. Jika sinyal kuat minim, boleh <3 atau bahkan [].
  Jangan buat ringkasan generik; tulis poin yang bisa dipakai untuk keputusan investasi.
- redFlags: 3-5 risiko paling material dari POV value investor. Fokus pada potensi permanent loss of capital:
  - leverage berlebihan / mismatch arus kas untuk bayar utang,
  - kualitas laba rendah (one-off, akrual agresif, arus kas lemah),
  - governance lemah (RPT bermasalah, konflik kepentingan, dilusi merugikan),
  - moat melemah / tekanan kompetitif struktural,
  - capital allocation buruk (capex/M&A tidak disiplin),
  - valuasi/ekspektasi yang menuntut pertumbuhan tidak realistis.
  Gaya Red flags: warning yang tegas untuk investor, dengan arah "hal ini wajib dicek lebih dalam".
  Pilih hanya risiko yang benar-benar material; jangan dipaksa. Jika tidak ada red flag kuat, gunakan [].
  Hindari risiko yang terlalu generik; setiap poin harus terkait fakta di teks.
- keyMetrics: hanya metrik yang disebut eksplisit atau bisa disimpulkan secara jelas; jika tidak ada metrik kuantitatif, gunakan item kualitatif yang singkat.
Format ringkas:
- importantInfo dan redFlags: tiap poin maksimal 10 kata.
- keyMetrics: angka-angka saja (rasio, pertumbuhan, margin, nominal, persentase, tanggal/tenor).
- keyMetrics.label: sangat singkat (1-3 kata).
- keyMetrics.value: format numerik ringkas, tanpa narasi/deskripsi.
Jika cuplikan tidak cukup, tetap berikan hasil terbaik: boleh array kosong atau item yang hati-hati.`;

  const user = `Document excerpt:\n\n${textSample}`;

  const raw = await chatCompletionJson({
    system,
    user,
    temperature: 0.2,
    model: INSIGHTS_MODEL,
  });
  const parsed = JSON.parse(stripJsonFence(raw)) as DocumentInsights;
  if (!Array.isArray(parsed.importantInfo)) parsed.importantInfo = [];
  if (!Array.isArray(parsed.redFlags)) parsed.redFlags = [];
  if (!Array.isArray(parsed.keyMetrics)) parsed.keyMetrics = [];
  return parsed;
}

/**
 * Reuse insights without calling the LLM: cache by sha256, then peer documents, then backfill cache from this doc.
 */
export async function resolveInsightsWithoutLLM(args: {
  documentId: string;
  sha256: string;
}): Promise<boolean> {
  const pool = getPool();
  const { documentId, sha256 } = args;

  const { rows: cacheRows } = await pool.query<{ insights_json: unknown }>(
    `SELECT insights_json
     FROM embedding_cache_sets
     WHERE sha256 = $1 AND insights_json IS NOT NULL`,
    [sha256]
  );
  const fromCache = cacheRows[0]?.insights_json ?? null;
  if (fromCache != null) {
    await pool.query(`UPDATE documents SET insights_json = $2::jsonb WHERE id = $1::uuid`, [
      documentId,
      JSON.stringify(fromCache),
    ]);
    return true;
  }

  const { rows: peerRows } = await pool.query<{ insights_json: unknown }>(
    `SELECT insights_json
     FROM documents
     WHERE sha256 = $1
       AND id <> $2::uuid
       AND status = 'ready'
       AND deleted_at IS NULL
       AND insights_json IS NOT NULL
     ORDER BY created_at DESC
     LIMIT 1`,
    [sha256, documentId]
  );
  const fromPeer = peerRows[0]?.insights_json ?? null;
  if (fromPeer != null) {
    const serialized = JSON.stringify(fromPeer);
    await pool.query(`UPDATE documents SET insights_json = $2::jsonb WHERE id = $1::uuid`, [
      documentId,
      serialized,
    ]);
    await pool.query(
      `UPDATE embedding_cache_sets
       SET insights_json = $2::jsonb, updated_at = now()
       WHERE sha256 = $1`,
      [sha256, serialized]
    );
    return true;
  }

  const { rows: selfRows } = await pool.query<{ insights_json: unknown }>(
    `SELECT insights_json FROM documents WHERE id = $1::uuid`,
    [documentId]
  );
  if (selfRows[0]?.insights_json != null) {
    await pool.query(
      `UPDATE embedding_cache_sets ecs
       SET insights_json = d.insights_json, updated_at = now()
       FROM documents d
       WHERE ecs.sha256 = $1
         AND d.id = $2::uuid
         AND d.insights_json IS NOT NULL`,
      [sha256, documentId]
    );
    return true;
  }

  return false;
}

export async function generateAndStoreInsights(args: {
  documentId: string;
  textSample: string;
  /** When set, also stores on embedding_cache_sets so all docs with this hash share insights. */
  sha256?: string | null;
}): Promise<DocumentInsights> {
  const insights = await generateInsightsFromText(args.textSample);
  const pool = getPool();
  const serialized = JSON.stringify(insights);
  await pool.query(`UPDATE documents SET insights_json = $2::jsonb WHERE id = $1::uuid`, [
    args.documentId,
    serialized,
  ]);
  const sha = args.sha256?.trim();
  if (sha) {
    await pool.query(
      `UPDATE embedding_cache_sets
       SET insights_json = $2::jsonb, updated_at = now()
       WHERE sha256 = $1`,
      [sha, serialized]
    );
  }
  return insights;
}
