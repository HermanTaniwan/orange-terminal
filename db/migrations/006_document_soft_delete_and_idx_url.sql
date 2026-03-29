ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS idx_source_url TEXT;

CREATE INDEX IF NOT EXISTS documents_idx_source_url_idx
  ON documents (idx_source_url)
  WHERE idx_source_url IS NOT NULL;

CREATE INDEX IF NOT EXISTS documents_project_deleted_idx
  ON documents (project_id, deleted_at)
  WHERE deleted_at IS NULL;
