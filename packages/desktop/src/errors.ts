/**
 * One error shape for the desktop engine. `code` and `statusCode` are what the
 * server's generic error handler already reads, so routes need no extra mapping.
 */
export class DesktopError extends Error {
  readonly code: string;
  readonly statusCode: number;
  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = 'DesktopError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export const isDesktopError = (value: unknown): value is DesktopError => value instanceof DesktopError;
