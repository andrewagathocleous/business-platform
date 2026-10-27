import { z } from 'zod';

/** Printable ASCII without whitespace, 1 to 200 characters. */
const PRINTNODE_KEY = /^[\x21-\x7E]{1,200}$/;

export const printNodeKeySchema = z
  .object({
    key: z.string().regex(PRINTNODE_KEY),
  })
  .strict();

export const emptyBodySchema = z.object({}).strict();

export type PrintNodeKeyPut = z.infer<typeof printNodeKeySchema>;
