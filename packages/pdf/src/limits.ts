/** Hard limits for every PDF operation. Callers can tighten them, never enlarge them. */
export const PDF_LIMITS = Object.freeze({
  /** One existing PDF given to an edit, in bytes. */
  inputBytes: 20_000_000,
  /** PDFs merged or stamped in one operation. */
  inputFiles: 12,
  /** The result of a render or an edit, in bytes. */
  outputBytes: 40_000_000,
  /** Pages in any input or output. */
  pages: 400,
  /** Characters of text in one document specification. */
  textChars: 60_000,
  /** Blocks in one document specification. */
  blocks: 600,
  renderTimeoutMs: 30_000,
  editTimeoutMs: 30_000,
  /** Parallel edit workers and parallel renders. */
  workers: 2,
});
