/** URL parsing errors can retain the full input, including database credentials. */
export function databaseConnectionUrl(connectionString: string): URL {
  try {
    return new URL(connectionString);
  } catch {
    throw new Error('DATABASE_URL is not a valid URL.');
  }
}
