const DEFAULT_SIZE = 1200;
const DEFAULT_OVERLAP = 200;

export function splitIntoChunks(
  text: string,
  size = DEFAULT_SIZE,
  overlap = DEFAULT_OVERLAP
): string[] {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];

  const paragraphs = normalized.split(/\n\s*\n/);
  const chunks: string[] = [];
  let buf = "";

  const flush = () => {
    const t = buf.trim();
    if (t) chunks.push(t);
    buf = "";
  };

  const pushSlice = (s: string) => {
    if (buf.length + s.length + 1 <= size) {
      buf = buf ? `${buf}\n${s}` : s;
      return;
    }
    if (buf) flush();
    if (s.length <= size) {
      buf = s;
      return;
    }
    for (let i = 0; i < s.length; i += size - overlap) {
      chunks.push(s.slice(i, i + size).trim());
    }
  };

  for (const p of paragraphs) {
    const lines = p.split("\n").map((l) => l.trim()).filter(Boolean);
    const block = lines.join("\n");
    if (!block) continue;
    if (block.length > size) {
      flush();
      pushSlice(block);
      flush();
    } else {
      pushSlice(block);
    }
  }
  flush();

  if (chunks.length === 0 && normalized) return [normalized.slice(0, size)];
  return chunks;
}
