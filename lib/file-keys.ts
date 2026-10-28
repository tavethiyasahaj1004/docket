import { createId } from "@paralleldrive/cuid2";

/** Stable React keys for lists of pending `File` objects. The index won't do —
 * removing a middle entry shifts the rest and misaligns rows — nor will a
 * name/size composite, since the picker allows the same file twice. Keying on
 * File identity solves both, and the WeakMap leaks nothing once state drops it. */
const keys = new WeakMap<File, string>();

export function fileKey(file: File): string {
  let key = keys.get(file);
  if (!key) {
    key = createId();
    keys.set(file, key);
  }
  return key;
}
