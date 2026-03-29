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
  /** Soft-deleted: hidden from UI; file & chunks kept for reuse on re-ingest. */
  deleted_at?: string | null;
  idx_source_url?: string | null;
  /** IDX GetAnnouncement pengumuman.Id2 */
  idx_announcement_id?: string | null;
};

export type DocumentInsights = {
  importantInfo: string[];
  redFlags: string[];
  keyMetrics: { label: string; value: string }[];
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
  project_type: "emiten" | "non_emiten";
  ticker_symbol: string | null;
  exchange: string | null;
  industry_topic: string | null;
  ingest_status?: "queued" | "running" | "completed" | "failed" | null;
  ingest_error?: string | null;
  ingest_metrics?: Record<string, unknown> | null;
  ingest_updated_at?: string | null;
  created_at: string;
};

export type ConversationRow = {
  id: string;
  project_id: string;
  title: string | null;
  created_at: string;
  last_preview?: string | null;
};

export type IdxLargestAttachment = {
  title: string;
  publishedAt: string;
  fileName: string;
  url: string;
  sizeBytes: number;
};

/** Satu pengumuman: satu PDF terpilih (terbesar di dalam pengumuman itu). */
export type IdxAnnouncementPdfPick = {
  title: string;
  publishedAt: string;
  selected: IdxLargestAttachment | null;
  candidatesInAnnouncement: number;
  sizedCount: number;
  failedCount: number;
  /** Blok teks {Pengumuman / Date / Output PDF} untuk tampilan */
  outputBlock?: string;
};

export type IdxExcludedAnnouncement = {
  title: string;
  publishedAt: string;
  matchedExclude: string;
};

export type IdxLargestAttachmentResponse = {
  announcements: IdxAnnouncementPdfPick[];
  candidatesCount: number;
  /** Pengumuman yang dilewati karena judul cocok daftar pengecualian */
  excludedAnnouncementsCount?: number;
  /** Detail pengumuman yang diabaikan (filter judul) */
  excludedAnnouncements?: IdxExcludedAnnouncement[];
  sizedCount: number;
  failedCount: number;
  error?: string;
};
