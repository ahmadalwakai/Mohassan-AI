/** Manual completion can intentionally change the page. Values sent for autofill still require the original hash. */
export function completeBrowserLiveInput(
  state: { authAttempts: number; securePageHash?: string | null },
  action: 'submit' | 'done' | 'skip',
): void {
  if (action !== 'done') return;
  state.authAttempts = 0;
  state.securePageHash = null;
}
