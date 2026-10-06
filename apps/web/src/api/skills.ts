import { z } from 'zod';

const skillFields = {
  id: z.string().min(1),
  name: z.string(),
  description: z.string(),
  updatedAt: z.string(),
};

export const skillProvenanceSchema = z.object({
  sourceId: z.string(),
  provider: z.string(),
  externalId: z.string(),
  slug: z.string(),
  url: z.string(),
  importedAt: z.string(),
  contentHash: z.string(),
});

export const skillSchema = z.object({
  ...skillFields,
  body: z.string(),
  files: z.array(z.object({ path: z.string(), content: z.string() })),
  source: skillProvenanceSchema.nullish(),
  createdAt: z.string(),
});

export const skillListSchema = z.object({
  items: z.array(
    z.object({
      ...skillFields,
      fileCount: z.number().int().nonnegative(),
      sourceProvider: z.string().nullish(),
    }),
  ),
});
