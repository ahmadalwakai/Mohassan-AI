interface ReadOnlyMemory {
  search(ownerId: string, input: { query: string; limit: number }, options: { readOnly: true }): Promise<{ items: readonly unknown[] }>;
}

/** Only inventory presence is shared with deliberation; contents and provenance stay with memory. */
export function createMemoryHitReader(memory: ReadOnlyMemory) {
  return async (ownerId: string, query: string): Promise<boolean> =>
    (await memory.search(ownerId, { query: query.slice(0, 500), limit: 1 }, { readOnly: true })).items.length > 0;
}
