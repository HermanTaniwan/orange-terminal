import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { answerWithRag, retrieveChunks } from "@/lib/rag";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      projectId?: string | null;
      conversationId?: string | null;
      message?: string;
      selectedDocumentIds?: string[] | null;
    };
    const projectId = body.projectId?.trim();
    if (!projectId) {
      return NextResponse.json({ error: "projectId is required" }, { status: 400 });
    }
    const text = body.message?.trim();
    if (!text) {
      return NextResponse.json({ error: "message is required" }, { status: 400 });
    }

    const pool = getPool();
    let conversationId = body.conversationId?.trim() || null;

    if (!conversationId) {
      const title = text.slice(0, 80);
      const { rows } = await pool.query(
        `INSERT INTO conversations (project_id, title)
         VALUES ($1::uuid, $2)
         RETURNING id`,
        [projectId, title]
      );
      conversationId = rows[0].id as string;
    } else {
      const { rows } = await pool.query(
        `SELECT id
         FROM conversations
         WHERE id = $1::uuid AND project_id = $2::uuid`,
        [conversationId, projectId]
      );
      if (!rows[0]) {
        return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
      }
    }

    await pool.query(
      `INSERT INTO messages (conversation_id, role, content) VALUES ($1::uuid, 'user', $2)`,
      [conversationId, text]
    );

    const chunks = await retrieveChunks({
      query: text,
      projectId,
      documentIds:
        body.selectedDocumentIds?.filter((id) => typeof id === "string") || [],
      limit: 10,
    });

    const { answerMarkdown, sources } = await answerWithRag({
      userMessage: text,
      chunks,
    });

    await pool.query(
      `INSERT INTO messages (conversation_id, role, content, sources_json)
       VALUES ($1::uuid, 'assistant', $2, $3::jsonb)`,
      [conversationId, answerMarkdown, JSON.stringify(sources)]
    );

    return NextResponse.json({
      conversationId,
      reply: {
        role: "assistant" as const,
        content: answerMarkdown,
        sources,
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Chat failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
