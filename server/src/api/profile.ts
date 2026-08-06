import type { Profile } from '@rakurs/contract';
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { Db } from '../db/client.js';
import { getSettings } from '../lib/settings.js';

export function registerProfileRoutes(
  app: FastifyInstance,
  db: Db,
  guard: preHandlerHookHandler,
): void {
  // The Promise<Profile> annotation is the contract test: the compiler rejects any
  // field the frontend does not expect, and any field it does.
  app.get('/api/profile', { preHandler: guard }, async (req): Promise<Profile> => {
    const s = await getSettings(db);
    return {
      projectName: s.projectName,
      planLine: s.planLine,
      currency: s.currency,
      // Plan 2 replaces this with the age of the last Meta sync, which is what the
      // header actually means by "updated". Until then it is the settings row's age.
      updatedMinutesAgo: Math.floor((Date.now() - s.updatedAt.getTime()) / 60_000),
      usdRate: Number(s.usdRate), // numeric columns come back from Postgres as strings
      user: { initials: req.user!.initials },
    };
  });
}
