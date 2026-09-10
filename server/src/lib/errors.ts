/**
 * An error whose message is meant for the user.
 *
 * The frontend renders the `message` field of an error response as-is, so these
 * strings are product copy and follow the audience — Russian.
 */
export class ApiError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Whether an error is Postgres reporting a unique-constraint violation.
 *
 * Drizzle wraps the driver error in its own `DrizzleQueryError`, so the code sits on
 * `.cause`, not on the error itself. Shared rather than reimplemented per caller: a draft's
 * `note_create` op can land on a path another note already took (`api/drafts.ts`) the same
 * way a plain note create can (`api/knowledge.ts`), and both need to turn the same raw `23505`
 * into the same kind of readable refusal rather than a bare 500.
 */
export function isDuplicate(error: unknown): boolean {
  const cause = error instanceof Error ? error.cause : undefined;
  return typeof cause === 'object' && cause !== null && (cause as { code?: string }).code === '23505';
}
