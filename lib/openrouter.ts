import { getServerEnv } from "./env";

const BASE = "https://openrouter.ai/api/v1";

export async function embedTexts(inputs: string[]): Promise<number[][]> {
  const { openRouterApiKey, embeddingModel } = getServerEnv();
  const res = await fetch(`${BASE}/embeddings`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openRouterApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: embeddingModel, input: inputs }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`OpenRouter embeddings failed: ${res.status} ${t}`);
  }
  const data = (await res.json()) as {
    data: { embedding: number[]; index: number }[];
  };
  const sorted = [...data.data].sort((a, b) => a.index - b.index);
  return sorted.map((d) => d.embedding);
}

export async function chatCompletionJson(args: {
  system: string;
  user: string;
  temperature?: number;
}): Promise<string> {
  const { openRouterApiKey, chatModel } = getServerEnv();
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openRouterApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: chatModel,
      temperature: args.temperature ?? 0.2,
      messages: [
        { role: "system", content: args.system },
        { role: "user", content: args.user },
      ],
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`OpenRouter chat failed: ${res.status} ${t}`);
  }
  const data = (await res.json()) as {
    choices: { message: { content: string | null } }[];
  };
  const content = data.choices[0]?.message?.content;
  if (!content) throw new Error("Empty completion from OpenRouter");
  return content;
}
