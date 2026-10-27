/** Serialized size of a tool result, as the text block carries it. */
export function jsonLength(value: unknown): number {
  return JSON.stringify(value).length;
}

/** Largest `n` in [0, length] for which `fits(n)` holds, assuming fitting is
 * monotonic (a shorter prefix never grows). Binary search, so a 100-item page
 * costs about seven serializations. */
export function largestFittingCount(
  length: number,
  fits: (n: number) => boolean
): number {
  let lo = 0;
  let hi = length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(mid)) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return lo;
}
