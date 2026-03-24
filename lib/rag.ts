import { getPool } from "./db";
import { chatCompletionJson, embedTexts } from "./openrouter";
import type { ChatSource } from "./types";
import { toVectorParam } from "./vector";

export type RetrievedChunk = {
  ref: number;
  chunkId: string;
  documentId: string;
  fileName: string;
  content: string;
};

function stripJsonFence(s: string): string {
  let t = s.trim();
  if (t.startsWith("```")) {
    t = t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  }
  return t.trim();
}

export async function retrieveChunks(args: {
  query: string;
  projectId: string;
  documentIds?: string[] | null;
  limit?: number;
}): Promise<RetrievedChunk[]> {
  const limit = args.limit ?? 10;
  const [qEmb] = await embedTexts([args.query]);
  const vec = toVectorParam(qEmb);
  const pool = getPool();

  const params: unknown[] = [vec, args.projectId];
  let docFilter = "";

  if (args.documentIds && args.documentIds.length > 0) {
    params.push(args.documentIds);
    docFilter = `AND c.document_id = ANY($3::uuid[])`;
  }

  const { rows } = await pool.query<{
    chunk_id: string;
    document_id: string;
    file_name: string;
    content: string;
  }>(
    `SELECT c.id AS chunk_id, c.document_id, d.file_name, c.content
     FROM chunks c
     JOIN documents d ON d.id = c.document_id
     WHERE d.status = 'ready'
       AND d.project_id = $2::uuid
       ${docFilter}
     ORDER BY c.embedding <=> $1::vector
     LIMIT ${limit}`,
    params
  );

  return rows.map((r, i) => ({
    ref: i + 1,
    chunkId: r.chunk_id,
    documentId: r.document_id,
    fileName: r.file_name,
    content: r.content,
  }));
}

export function buildContextBlock(chunks: RetrievedChunk[]): string {
  return chunks
    .map(
      (c) =>
        `[${c.ref}] file: ${c.fileName}\n${c.content}`
    )
    .join("\n\n---\n\n");
}

export async function answerWithRag(args: {
  userMessage: string;
  chunks: RetrievedChunk[];
}): Promise<{ answerMarkdown: string; sources: ChatSource[] }> {
  if (args.chunks.length === 0) {
    return {
      answerMarkdown:
        "No indexed documents are available yet. Upload a PDF or Excel file and wait until it shows as ready, then ask again.",
      sources: [],
    };
  }

  const ctx = buildContextBlock(args.chunks);
  const system = `You are a value investing research assistant. Use ONLY the numbered context blocks. 
Respond with valid JSON only (no markdown fences), shape:
{"answer_markdown":"string","citations":[{"ref":number,"quote":"short verbatim quote from that block"}]}
Every material claim must have at least one citation with a ref index matching a context block. 
If the context does not support an answer, say so in answer_markdown and use minimal citations.`;

  const user = `Context:\n\n${ctx}\n\nQuestion: ${args.userMessage}`;

  const raw = await chatCompletionJson({ system, user, temperature: 0.2 });
  let parsed: {
    answer_markdown?: string;
    citations?: { ref: number; quote?: string }[];
  };
  try {
    parsed = JSON.parse(stripJsonFence(raw));
  } catch {
    parsed = { answer_markdown: raw, citations: [] };
  }

  const answerMarkdown =
    typeof parsed.answer_markdown === "string"
      ? parsed.answer_markdown
      : "Could not parse model response.";
  const citations = Array.isArray(parsed.citations) ? parsed.citations : [];

  const byRef = new Map(args.chunks.map((c) => [c.ref, c]));
  const sources: ChatSource[] = [];
  const seen = new Set<string>();

  for (const cit of citations) {
    const ref = Number(cit.ref);
    const ch = byRef.get(ref);
    if (!ch) continue;
    const key = ch.chunkId;
    if (seen.has(key)) continue;
    seen.add(key);
    const quote =
      typeof cit.quote === "string" && cit.quote.trim()
        ? cit.quote.trim().slice(0, 400)
        : ch.content.slice(0, 400);
    sources.push({
      documentId: ch.documentId,
      fileName: ch.fileName,
      snippet: quote,
      chunkId: ch.chunkId,
    });
  }

  if (sources.length === 0) {
    for (const ch of args.chunks.slice(0, 3)) {
      sources.push({
        documentId: ch.documentId,
        fileName: ch.fileName,
        snippet: ch.content.slice(0, 400),
        chunkId: ch.chunkId,
      });
    }
  }

  return { answerMarkdown, sources };
}
