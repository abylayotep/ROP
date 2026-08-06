import { buildServer } from './api/server.js';
import { createDb } from './db/client.js';
import { loadEnv } from './env.js';

const env = loadEnv();
const db = createDb(env.DATABASE_URL);
const app = buildServer(env, db);

await app.listen({ port: env.PORT, host: '0.0.0.0' });
