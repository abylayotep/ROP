import { buildServer } from './api/server.js';
import { loadEnv } from './env.js';

const env = loadEnv();
const app = buildServer(env);

await app.listen({ port: env.PORT, host: '0.0.0.0' });
