/** Keep arithmetic proposals out of the product until the owner opts into its separately gated path. */
export function arithmeticSearchEnabled(): boolean {
  return process.env.MOHASSAN_ARITHMETIC_SEARCH === '1';
}
