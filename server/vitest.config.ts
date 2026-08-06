import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    /**
     * Test files share one Postgres and `withDb()` truncates between tests, so files
     * must not run concurrently: a parallel file's truncate deletes another file's
     * fixtures mid-test and the failure looks like a foreign key bug.
     *
     * The whole suite runs in well under a second, so there is nothing to gain here.
     */
    fileParallelism: false,
  },
});
