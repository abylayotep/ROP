import { buildServer } from './api/server.js';
import { createDb } from './db/client.js';
import { loadEnv } from './env.js';

// Local convenience only. In production Compose supplies the environment and there is
// no .env in the image, so the absence of the file is the normal case, not an error.
if (process.env.NODE_ENV !== 'production') {
  try {
    process.loadEnvFile();
  } catch {
    // No .env — fall back to whatever is already in the environment.
  }
}

const env = loadEnv();
const db = createDb(env.DATABASE_URL);
const app = buildServer(env, db);

await app.listen({ port: env.PORT, host: '0.0.0.0' });
