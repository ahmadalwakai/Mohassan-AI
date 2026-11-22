/** FNV-1a 32-bit hash: small, dependency-free and stable across runs and machines. */
export function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** The seed of a site: its name and kind. Editing a phone number or a colour never reshuffles the copy. */
export const seedOf = (name: string, kind: string) => fnv1a(`${name.trim().toLocaleLowerCase()}|${kind}`);

/**
 * Stable choice among options for a named slot. Each slot hashes on its own key, so adding a new
 * slot elsewhere in a template does not change the choices already made for the other slots.
 */
export function pick<T>(seed: number, key: string, options: readonly T[]): T {
  if (!options.length) throw new Error(`pick: no options for ${key}`);
  return options[fnv1a(`${seed.toString(16)}:${key}`) % options.length]!;
}

/** Stable index in [0, count). */
export const pickIndex = (seed: number, key: string, count: number) => (count <= 0 ? 0 : fnv1a(`${seed.toString(16)}:${key}`) % count);
