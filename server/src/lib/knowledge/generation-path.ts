import { z } from 'zod';

/** The one strict path contract shared by generation extraction, consolidation, and review. */
export const generationPathSchema = z
  .string()
  .min(1)
  .max(400)
  .refine((path) => path === path.trim())
  .refine((path) => !path.startsWith('/') && !path.endsWith('/'))
  .refine((path) => path.split('/').every((part) => part.trim() !== ''))
  .refine((path) => path.split('/').length <= 10);

export const isValidGenerationPath = (path: string): boolean =>
  generationPathSchema.safeParse(path).success;
