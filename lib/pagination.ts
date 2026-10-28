/** Page numbers to render, with "ellipsis" markers where pages are skipped. */
export function getPageNumbers(
  current: number,
  total: number
): Array<number | "ellipsis"> {
  if (total <= 7) {
    return Array.from({ length: total }, (_, i) => i + 1);
  }

  const pages = new Set<number>([1, total, current]);
  if (current > 1) {
    pages.add(current - 1);
  }
  if (current < total) {
    pages.add(current + 1);
  }
  if (current <= 3) {
    pages.add(2);
    pages.add(3);
    pages.add(4);
  }
  if (current >= total - 2) {
    pages.add(total - 1);
    pages.add(total - 2);
    pages.add(total - 3);
  }

  const sorted = Array.from(pages)
    .filter((p) => p >= 1 && p <= total)
    .sort((a, b) => a - b);

  const result: Array<number | "ellipsis"> = [];
  let prev = 0;
  for (const p of sorted) {
    if (prev && p - prev > 1) {
      result.push("ellipsis");
    }
    result.push(p);
    prev = p;
  }
  return result;
}
