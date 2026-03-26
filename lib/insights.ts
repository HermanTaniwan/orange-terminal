import { getPool } from "./db";
import { chatCompletionJson } from "./openrouter";
import type { DocumentInsights } from "./types";

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
{"redFlags":["string"],"keyMetrics":[{"label":"string","value":"string"}],"businessQualitySummary":"string"}
Rules:
- redFlags: butir risiko yang spesifik dan berdasar pada teks; gunakan array kosong jika tidak ada.
- keyMetrics: hanya metrik yang disebut eksplisit atau bisa disimpulkan secara jelas; jika tidak ada metrik kuantitatif, gunakan item kualitatif yang singkat.
- businessQualitySummary: 2-4 kalimat tentang moat, intensitas modal, dan kualitas laba berdasarkan teks.
Jika cuplikan tidak cukup, tetap berikan hasil terbaik: boleh array kosong atau item yang hati-hati.`;

  const user = `Document excerpt:\n\n${textSample}`;

  const raw = await chatCompletionJson({ system, user, temperature: 0.2 });
  const parsed = JSON.parse(stripJsonFence(raw)) as DocumentInsights;
  if (!Array.isArray(parsed.redFlags)) parsed.redFlags = [];
  if (!Array.isArray(parsed.keyMetrics)) parsed.keyMetrics = [];
  if (typeof parsed.businessQualitySummary !== "string") {
    parsed.businessQualitySummary = "";
  }
  return parsed;
}

export async function generateAndStoreInsights(args: {
  documentId: string;
  textSample: string;
}): Promise<DocumentInsights> {
  const insights = await generateInsightsFromText(args.textSample);
  const pool = getPool();
  await pool.query(
    `UPDATE documents SET insights_json = $2::jsonb WHERE id = $1`,
    [args.documentId, JSON.stringify(insights)]
  );
  return insights;
}
