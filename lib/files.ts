import { basename } from "node:path";

const ALLOWED_EXT = new Set([".pdf", ".xlsx", ".xls"]);

export function sanitizeFileName(name: string): string {
  const base = basename(name).replace(/[^a-zA-Z0-9._-]+/g, "_");
  return base.slice(0, 180) || "upload";
}

export function allowedUpload(name: string): boolean {
  const n = name.toLowerCase();
  for (const ext of ALLOWED_EXT) {
    if (n.endsWith(ext)) return true;
  }
  return false;
}
