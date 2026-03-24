# Orange Terminal

Full-stack Next.js app for **value-investor** workflows: upload PDF and Excel research files, index with OpenRouter embeddings in PostgreSQL + pgvector, and chat with **cited sources** (file name + excerpt). Each indexed document gets an **Insights** pass (red flags, key metrics, business quality).

## Prerequisites

- Node.js 20+
- **PostgreSQL 16+ with the `pgvector` extension** — see options below.

## Database options

### A. Docker (simplest if Docker is installed)

From the project root:

```bash
docker compose up -d
```

Use `DATABASE_URL` from [`.env.example`](.env.example) (port **5433** on the host).

### B. `docker` not recognized (typical on Windows)

PowerShell reports *The term 'docker' is not recognized* when the Docker CLI is missing or not on your `PATH`. Pick one:

1. **Install [Docker Desktop for Windows](https://docs.docker.com/desktop/setup/install/windows-install/)**, finish setup, **restart your terminal** (or sign out/in), then run `docker --version`. When it works, use option A.
2. **Skip Docker** and use **any Postgres 16+ that has `pgvector`** (local install, WSL2, or a hosted provider such as Neon or Supabase that offers pgvector). Create an empty database, set `DATABASE_URL` in `.env` to that connection string, then run `npm run db:migrate`.

For a **local Windows** Postgres install you must enable the extension yourself (e.g. after connecting with `psql`, run `CREATE EXTENSION vector;` once per database, or rely on the migration which runs `CREATE EXTENSION IF NOT EXISTS vector;` if your server ships pgvector).

### C. Docker Desktop “unable to start” / cannot pull images

If you see errors like **Docker Desktop is unable to start** or **unable to get image** while the daemon is down, Docker cannot run containers until the engine starts. Common fixes on Windows:

1. **Reboot** after installing or updating Docker Desktop.
2. **WSL 2 backend:** Install/update [WSL 2](https://learn.microsoft.com/en-us/windows/wsl/install) and a Linux distro (Ubuntu). In Docker Desktop: *Settings → General* ensure *Use the WSL 2 based engine* is enabled; under *Resources → WSL integration*, enable your distro.
3. **Virtualization:** In BIOS/UEFI, enable **Intel VT-x / AMD-V**. In Windows, ensure *Hyper-V* / *Virtual Machine Platform* / *Windows Hypervisor Platform* features match [Docker’s Windows requirements](https://docs.docker.com/desktop/setup/install/windows-install/).
4. **Quit and restart Docker Desktop** (system tray → Quit, then start again as Administrator if needed).
5. **Corporate or security software** sometimes blocks the Docker engine; check with IT or try **Reset to factory defaults** in Docker Desktop settings (last resort).

**Fastest way to keep building without fixing Docker:** use a **hosted Postgres with pgvector** (e.g. [Neon](https://neon.tech) or [Supabase](https://supabase.com) — enable pgvector in the project), copy the connection string into `DATABASE_URL` in `.env`, then run `npm run db:migrate`. No local Docker required.

## Quick start

1. Copy environment variables:

   ```bash
   cp .env.example .env
   ```

   On Windows PowerShell you can use: `Copy-Item .env.example .env`

   Set `OPENROUTER_API_KEY` in `.env`, and set `DATABASE_URL` to match how you run Postgres (Docker or other).

2. Start PostgreSQL (Docker path only — skip if you already have a reachable database):

   ```bash
   docker compose up -d
   ```

3. Run migrations (loads `DATABASE_URL` from `.env` in the project root — same folder as `package.json`):

   ```bash
   npm run db:migrate
   ```

4. Install dependencies and run the dev server:

   ```bash
   npm install
   npm run dev
   ```

   Open [http://localhost:3000](http://localhost:3000).

## Models

- **Embeddings:** Defaults to `openai/text-embedding-3-small` (1536 dimensions). If you change `EMBEDDING_MODEL`, update the `vector(1536)` column in `db/migrations/001_init.sql` and re-migrate on a fresh database.
- **Chat:** Defaults to `openai/gpt-4o-mini`. Override with `CHAT_MODEL` for stronger reasoning.

Browse models and dimensions on [OpenRouter](https://openrouter.ai/models).

## API overview

| Method | Path | Purpose |
|--------|------|---------|
| `GET` / `POST` | `/api/documents` | List / upload (multipart field `file`) |
| `DELETE` | `/api/documents/[id]` | Remove document, chunks, and files |
| `POST` | `/api/documents/[id]/insights` | Regenerate insights JSON |
| `POST` | `/api/chat` | RAG chat; body: `projectId`, `message`, optional `conversationId`, `selectedDocumentIds[]` |
| `GET` / `POST` | `/api/projects` | List / create projects |
| `PATCH` / `DELETE` | `/api/projects/[id]` | Rename or delete a project (cascade docs/chats) |
| `GET` / `POST` | `/api/conversations` | List / create conversations |
| `GET` | `/api/conversations/[id]` | Messages for a conversation |

## Production notes

- Run `npm run build` then `npm start` behind a reverse proxy.
- Keep `OPENROUTER_API_KEY` server-side only (never expose to the client).
- Tune `MAX_UPLOAD_MB` and use a managed Postgres with pgvector for production.
- Uploaded files live under `UPLOAD_DIR` (default `./uploads`); back up this directory with your database.

## License

Private / use as you wish.
