import type { Settings } from '@rakurs/contract';
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { ApiError } from '../lib/errors.js';
import { getSettings, toApiSettings, updateSettings } from '../lib/settings.js';

const patch = z.object({
  selectedAccounts: z.array(z.string()).optional(),
  syncMode: z.string().min(1).optional(),
});

export function registerSettingsRoutes(
  app: FastifyInstance,
  db: Db,
  guard: preHandlerHookHandler,
): void {
  app.get(
    '/api/settings',
    { preHandler: guard },
    async (): Promise<Settings> => toApiSettings(await getSettings(db)),
  );

  app.patch('/api/settings', { preHandler: guard }, async (req): Promise<Settings> => {
    const parsed = patch.safeParse(req.body);
    if (!parsed.success) throw new ApiError(400, 'Не удалось разобрать настройки');
    return toApiSettings(await updateSettings(db, parsed.data));
  });
}
