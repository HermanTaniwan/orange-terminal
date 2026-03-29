ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS sha256 TEXT;

CREATE INDEX IF NOT EXISTS documents_sha256_idx
  ON documents (sha256);

CREATE TABLE IF NOT EXISTS embedding_cache_sets (
  sha256 TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'processing',
  char_count INTEGER,
  source_file_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT embedding_cache_sets_status_check
    CHECK (status IN ('processing', 'ready', 'failed'))
);

CREATE TABLE IF NOT EXISTS embedding_cache_chunks (
  sha256 TEXT NOT NULL REFERENCES embedding_cache_sets (sha256) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  embedding vector(1536) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (sha256, chunk_index)
);

CREATE INDEX IF NOT EXISTS embedding_cache_chunks_sha_idx
  ON embedding_cache_chunks (sha256, chunk_index);
