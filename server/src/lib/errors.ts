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
