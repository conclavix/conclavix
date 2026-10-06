import { ObjectId } from 'mongodb';
import type { z } from 'zod';
import { notFound } from './errors.js';

/** Parse unknown input with the supplied schema, propagating Zod validation errors. */
export function parse<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  return schema.parse(value);
}

/** Convert a lowercase 24-character hexadecimal ID, raising 404 for malformed resource IDs. */
export function toObjectId(id: string, what: string): ObjectId {
  if (!ObjectId.isValid(id) || !/^[a-f0-9]{24}$/.test(id)) {
    throw notFound(what);
  }
  return new ObjectId(id);
}

export type Defined<T> = { [K in keyof T]?: Exclude<T[K], undefined> };

/** Copy defined own enumerable properties so partial updates preserve omitted fields. */
export function definedOnly<T extends object>(value: T): Defined<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Defined<T>;
}
