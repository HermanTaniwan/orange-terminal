export function toVectorParam(embedding: number[]): string {
  return `[${embedding.map((n) => Number(n.toFixed(8))).join(",")}]`;
}
