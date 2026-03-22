import { readFile } from "node:fs/promises";

function isExcelMime(mime: string, fileName: string): boolean {
  const m = mime.toLowerCase();
  const n = fileName.toLowerCase();
  return (
    m.includes("spreadsheet") ||
    m.includes("excel") ||
    m.includes("ms-excel") ||
    n.endsWith(".xlsx") ||
    n.endsWith(".xls")
  );
}

export async function extractTextFromFile(
  filePath: string,
  mimeType: string,
  fileName: string
): Promise<string> {
  const lower = mimeType.toLowerCase();
  if (lower.includes("pdf") || fileName.toLowerCase().endsWith(".pdf")) {
    const { PDFParse } = await import("pdf-parse");
    const buf = await readFile(filePath);
    const parser = new PDFParse({ data: new Uint8Array(buf) });
    try {
      const result = await parser.getText();
      return result.text || "";
    } finally {
      await parser.destroy();
    }
  }
  if (isExcelMime(mimeType, fileName)) {
    const XLSX = await import("xlsx");
    const buf = await readFile(filePath);
    const wb = XLSX.read(buf, { type: "buffer" });
    const parts: string[] = [];
    for (const name of wb.SheetNames) {
      const sheet = wb.Sheets[name];
      if (!sheet) continue;
      const csv = XLSX.utils.sheet_to_csv(sheet);
      if (csv.trim()) parts.push(`## ${name}\n${csv}`);
    }
    return parts.join("\n\n");
  }
  throw new Error(`Unsupported type: ${mimeType} (${fileName})`);
}
