import { z } from "zod";
import type { Operation } from "./schemas.js";

export const jsonValueSchema = z.json();
const jsonPrimitiveSchema = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean()]),
);

export type JsonValue = z.output<typeof jsonValueSchema>;
/** A JSON object level within an already-parsed {@link JsonValue}. */
export type JsonObject = Readonly<Record<string, JsonValue>>;

/**
 * Narrow an already-parsed JSON value to its object case. The value was
 * validated once at its boundary, so each nested level is told apart by its
 * shape here instead of re-validating the whole subtree at every level, which
 * made walking a large schema quadratic.
 */
export function isJsonObject(value: JsonValue): value is JsonObject {
  return (
    value !== null &&
    !Array.isArray(value) &&
    !jsonPrimitiveSchema.safeParse(value).success
  );
}

export function compareCodeUnits(left: string, right: string): number {
  if (left === right) return 0;
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = left.charCodeAt(index) - right.charCodeAt(index);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

export function normalizeQuery(query: string): string {
  return query
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[_./:-]/g, " ")
    .toLowerCase()
    .trim();
}

export function tokenize(text: string): string[] {
  return text.split(/[^a-zA-Z0-9]+/).filter((token) => token.length > 0);
}

const stopwords = new Set([
  "the",
  "a",
  "an",
  "for",
  "to",
  "of",
  "that",
  "this",
  "with",
  "in",
  "on",
]);

export function isStopword(token: string): boolean {
  return stopwords.has(token);
}

export function stemVariants(token: string): string[] {
  const variants: string[] = [];
  const add = (variant: string): void => {
    if (
      variant !== token &&
      variant.length >= 3 &&
      !variants.includes(variant)
    ) {
      variants.push(variant);
    }
  };
  if (token.endsWith("ing") && token.length > 4) add(token.slice(0, -3));
  if (token.endsWith("ed") && token.length > 3) add(token.slice(0, -2));
  if (token.endsWith("ies") && token.length > 4) {
    add(token.slice(0, -3));
    add(`${token.slice(0, -3)}y`);
  }
  if (token.endsWith("es") && token.length > 3) add(token.slice(0, -2));
  if (token.endsWith("s") && !token.endsWith("ss") && token.length > 3) {
    add(token.slice(0, -1));
  }
  return variants;
}

export function canonicalStringify(value: JsonValue): string {
  if (value === null) return "null";
  const primitive = jsonPrimitiveSchema.safeParse(value);
  if (primitive.success) {
    return JSON.stringify(primitive.data);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalStringify(item)).join(",")}]`;
  }
  if (!isJsonObject(value)) return "null";
  const entries = Object.entries(value).sort(([left], [right]) =>
    compareCodeUnits(left, right),
  );
  return `{${entries
    .map(
      ([key, entry]) => `${JSON.stringify(key)}:${canonicalStringify(entry)}`,
    )
    .join(",")}}`;
}

export function hashString64(value: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = (1n << 64n) - 1n;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, "0");
}

export function operationMethod(path: Operation["path"]): string {
  return path.slice(path.indexOf(".") + 1);
}

export function operationNamespace(path: Operation["path"]): string {
  return path.slice(0, path.indexOf("."));
}
