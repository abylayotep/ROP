import path from 'node:path';
import { defineConfig } from 'vitest/config';

/**
 * Отдельно от `vite.config.ts`, а не поверх него.
 *
 * Здесь проверяются чистые функции — те, что решают, какое число и какую фразу печатать, —
 * без DOM и без JSX. Плагин React, прокси на бэкенд и чтение `.env` для этого не нужны и
 * только сыпали бы предупреждениями сборщика в вывод тестов. Из конфига сборки нужен ровно
 * один псевдоним: `@`.
 */
export default defineConfig({
  resolve: { alias: { '@': path.resolve(import.meta.dirname, 'src') } },
  test: { include: ['src/**/*.test.ts'] },
});
