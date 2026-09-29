import { z } from '@hono/zod-openapi';

export const ErrorSchema = z
  .object({
    error: z.object({
      code: z.string().openapi({ example: 'validation_error' }),
      message: z.string(),
      details: z.unknown().optional(),
    }),
  })
  .openapi('Error');

export const errorResponses = (...codes: number[]) =>
  Object.fromEntries(
    codes.map((code) => [
      code,
      { description: `Error ${code}`, content: { 'application/json': { schema: ErrorSchema } } },
    ]),
  );

export const AddressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, 'must be a 0x-prefixed 20-byte hex address')
  .openapi({ example: '0x9fB29AAc15b9A4B7F17c3385939b007540f4d791' });

export const HexSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]*$/, 'must be 0x-prefixed hex')
  .max(20_000);

export const KeyNameSchema = z.string().trim().min(1).max(64);

export const ApiKeyInfoSchema = z
  .object({
    id: z.string().openapi({ example: 'key_4Wq…' }),
    prefix: z.string().openapi({ example: 't2l_AbCd1234' }),
    name: z.string(),
    createdAt: z.iso.datetime(),
    lastUsedAt: z.iso.datetime().nullable(),
  })
  .openapi('ApiKeyInfo');

export const NewApiKeySchema = ApiKeyInfoSchema.extend({
  key: z.string().openapi({ description: 'The secret key. Shown only once; store it securely.' }),
}).openapi('NewApiKey');

export const idParam = (prefix: string) =>
  z.object({
    id: z
      .string()
      .regex(new RegExp(`^${prefix}_[0-9A-Za-z]{22}$`))
      .openapi({ param: { name: 'id', in: 'path' } }),
  });
