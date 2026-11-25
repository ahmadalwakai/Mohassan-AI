const passiveReadHeaders = new Set(['accept', 'accept-encoding', 'accept-language', 'origin', 'range', 'user-agent']);

/** Manual redirects cross Chromium's credential and custom-header boundary. */
export function crossOriginReadHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => passiveReadHeaders.has(name.toLowerCase())));
}
