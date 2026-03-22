import { Pool } from "pg";

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    const { DATABASE_URL } = process.env;
    if (!DATABASE_URL) throw new Error("DATABASE_URL is not set");
    pool = new Pool({ connectionString: DATABASE_URL, max: 10 });
  }
  return pool;
}
