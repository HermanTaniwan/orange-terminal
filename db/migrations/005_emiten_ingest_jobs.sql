CREATE TABLE IF NOT EXISTS emiten_ingest_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  ticker_symbol TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  error_message TEXT,
  metrics_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT emiten_ingest_jobs_status_check
    CHECK (status IN ('queued', 'running', 'completed', 'failed'))
);

CREATE INDEX IF NOT EXISTS emiten_ingest_jobs_project_created_idx
  ON emiten_ingest_jobs (project_id, created_at DESC);

CREATE INDEX IF NOT EXISTS emiten_ingest_jobs_status_created_idx
  ON emiten_ingest_jobs (status, created_at ASC);
