const { readFileSync, existsSync, readdirSync } = require("node:fs");
const { join } = require("node:path");
const pg = require("pg");

function loadDotEnv() {
  const p = join(__dirname, "..", ".env");
  if (!existsSync(p)) return;
  const raw = readFileSync(p, "utf8");
  for (let line of raw.split("\n")) {
    line = line.replace(/\r$/, "");
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

loadDotEnv();

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required (set it in .env in the project root).");
  process.exit(1);
}

function getMigrationFiles() {
  const dir = join(__dirname, "../db/migrations");
  return readdirSync(dir)
    .filter((name) => /^\d+_.*\.sql$/.test(name))
    .sort((a, b) => a.localeCompare(b));
}

async function main() {
  const client = new pg.Client({ connectionString: url });
  await client.connect();

  const files = getMigrationFiles();
  for (const file of files) {
    const sql = readFileSync(join(__dirname, "../db/migrations", file), "utf8");
    await client.query(sql);
    console.log(`Applied ${file}`);
  }

  await client.end();
  console.log("All migrations applied.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
