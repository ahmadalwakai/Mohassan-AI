/** Only accounts with full access can attach images for the reader. */
export function imageReadingAvailable(fullAccess: boolean, reader?: { readonly available: boolean }): boolean {
  return fullAccess && Boolean(reader?.available);
}
