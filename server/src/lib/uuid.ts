/**
 * The shape Postgres accepts for a uuid column.
 *
 * Every identifier that reaches a query from a URL or a cookie is checked with this first:
 * comparing text that is not a uuid against a uuid column makes Postgres raise, which turns
 * a typo into a 500 instead of the 404 the route means.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (value: string): boolean => UUID.test(value);
