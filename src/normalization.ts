import { z } from "zod";
import type { Operation } from "./schemas.js";

export const jsonValueSchema = z.json();

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
  return value !== null && !Array.isArray(value) && typeof value === "object";
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
  if (token.endsWith("ation") && token.length > 6) {
    add(`${token.slice(0, -3)}e`);
  }
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

export function hashString64(value: string): string {
  let word0 = 0x2325;
  let word1 = 0x8422;
  let word2 = 0x9ce4;
  let word3 = 0xcbf2;
  for (let index = 0; index < value.length; index += 1) {
    const low = word0 ^ value.charCodeAt(index);
    // The prime is 2^40 + 435. Four 16-bit limbs preserve modulo 2^64;
    // every intermediate stays below 2^26, including before V8 optimizes
    // this loop. Unsigned 32-bit limbs allocated boxed numbers when cold.
    const product0 = low * 435;
    const product1 = word1 * 435 + (product0 >>> 16);
    const product2 = word2 * 435 + (product1 >>> 16) + (low << 8);
    const product3 = word3 * 435 + (product2 >>> 16) + (word1 << 8);
    word0 = product0 & 0xffff;
    word1 = product1 & 0xffff;
    word2 = product2 & 0xffff;
    word3 = product3 & 0xffff;
  }
  return (
    word3.toString(16).padStart(4, "0") +
    word2.toString(16).padStart(4, "0") +
    word1.toString(16).padStart(4, "0") +
    word0.toString(16).padStart(4, "0")
  );
}

export function operationMethod(path: Operation["path"]): string {
  return path.slice(path.indexOf(".") + 1);
}

export function operationNamespace(path: Operation["path"]): string {
  return path.slice(0, path.indexOf("."));
}
