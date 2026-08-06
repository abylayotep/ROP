import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');

  return {
    plugins: [react()],
    resolve: {
      alias: { '@': path.resolve(__dirname, 'src') },
    },
    server: {
      port: 5173,
      host: true,
      /**
       * В разработке /api уходит на бэкенд с VITE_API_PROXY — так фронт и апи
       * лежат на одном origin и не нужен CORS. Если бэк на VPS, укажите там его
       * адрес; если поднят локально — http://localhost:3000.
       */
      proxy: env.VITE_API_PROXY
        ? {
            '/api': {
              target: env.VITE_API_PROXY,
              changeOrigin: true,
              secure: true,
            },
          }
        : undefined,
    },
  };
});
