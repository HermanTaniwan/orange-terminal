CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO projects (id, name, description)
VALUES (
  '00000000-0000-0000-0000-000000000001'::uuid,
  'Default Project',
  'Auto-generated default project for pre-existing data'
)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE documents ADD COLUMN IF NOT EXISTS project_id UUID;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS project_id UUID;

UPDATE documents
SET project_id = '00000000-0000-0000-0000-000000000001'::uuid
WHERE project_id IS NULL;

UPDATE conversations
SET project_id = '00000000-0000-0000-0000-000000000001'::uuid
WHERE project_id IS NULL;

ALTER TABLE documents ALTER COLUMN project_id SET NOT NULL;
ALTER TABLE conversations ALTER COLUMN project_id SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'documents_project_id_fkey'
  ) THEN
    ALTER TABLE documents
      ADD CONSTRAINT documents_project_id_fkey
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'conversations_project_id_fkey'
  ) THEN
    ALTER TABLE conversations
      ADD CONSTRAINT conversations_project_id_fkey
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS documents_project_created_idx
  ON documents (project_id, created_at DESC);

CREATE INDEX IF NOT EXISTS conversations_project_created_idx
  ON conversations (project_id, created_at DESC);
