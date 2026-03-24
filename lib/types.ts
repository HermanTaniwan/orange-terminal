export type DocumentRow = {
  id: string;
  project_id: string;
  file_name: string;
  mime_type: string;
  status: string;
  error_message: string | null;
  char_count: number | null;
  insights_json: DocumentInsights | null;
  created_at: string;
};

export type DocumentInsights = {
  redFlags: string[];
  keyMetrics: { label: string; value: string }[];
  businessQualitySummary: string;
};

export type ChatSource = {
  documentId: string;
  fileName: string;
  snippet: string;
  chunkId: string;
};

export type MessageRow = {
  id: string;
  conversation_id: string;
  role: "user" | "assistant";
  content: string;
  sources_json: ChatSource[] | null;
  created_at: string;
};

export type ProjectRow = {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
};

export type ConversationRow = {
  id: string;
  project_id: string;
  title: string | null;
  created_at: string;
  last_preview?: string | null;
};
