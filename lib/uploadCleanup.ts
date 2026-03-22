import { rm } from "node:fs/promises";

export async function removeUploadDirectory(dirPath: string): Promise<void> {
  try {
    await rm(dirPath, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}
