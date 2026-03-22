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
  const system = `You are a skeptical value investing analyst. Output ONLY valid JSON with this exact shape (no markdown):
{"redFlags":["string"],"keyMetrics":[{"label":"string","value":"string"}],"businessQualitySummary":"string"}
Rules:
- redFlags: concrete risk items grounded in the text; use empty array if none found.
- keyMetrics: only metrics explicitly present or clearly inferable; otherwise short qualitative items.
- businessQualitySummary: 2-4 sentences on moat, capital intensity, and earnings quality based on the text.
If the excerpt is insufficient, still return best-effort empty or cautious items.`;

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
