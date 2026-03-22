const required = (name: string): string => {
  const v = process.env[name];
  if (!v?.trim()) throw new Error(`Missing required env: ${name}`);
  return v.trim();
};

export function getServerEnv() {
  return {
    openRouterApiKey: required("OPENROUTER_API_KEY"),
    databaseUrl: required("DATABASE_URL"),
    embeddingModel:
      process.env.EMBEDDING_MODEL?.trim() ||
      "openai/text-embedding-3-small",
    chatModel:
      process.env.CHAT_MODEL?.trim() || "openai/gpt-4o-mini",
    uploadDir: process.env.UPLOAD_DIR?.trim() || "./uploads",
    maxUploadMb: Number(process.env.MAX_UPLOAD_MB || "25") || 25,
  };
}
