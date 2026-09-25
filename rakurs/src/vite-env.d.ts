/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Базовый адрес API. По умолчанию /api — тот же origin, что и статика. */
  readonly VITE_API_URL?: string;
  /** Куда dev-сервер проксирует /api. Только для разработки. */
  readonly VITE_API_PROXY?: string;
  /** Ставится сборкой одного файла: маршрутизация через хэш вместо путей. */
  readonly VITE_HASH_ROUTER?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
