/** Public, bounded errors for PDF work. Messages are shown to the owner; codes are stable for the host. */
export class PdfError extends Error {
  constructor(public readonly code: string, message: string, public readonly statusCode = 400) {
    super(message);
    this.name = 'PdfError';
  }
}
