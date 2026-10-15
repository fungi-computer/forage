import { z } from "zod";
import { ForageError } from "./errors.js";
import { compareCodeUnits, operationNamespace } from "./normalization.js";
import {
  forageListInput,
  listOutputSchema,
  searchResultSchema,
  type ForageListInput,
  type ListOutput,
  type SearchResult,
} from "./schemas.js";

const cursorSchema = z.strictObject({
  catalogStamp: listOutputSchema.shape.catalogStamp,
  namespace: forageListInput.shape.namespace.unwrap().nullable(),
  after: searchResultSchema.shape.path,
});

/**
 * Page a trusted immutable operation-summary view. Hosts may filter the existing
 * catalog to their bound operations before paging; this is the one cursor owner.
 * Order is namespace then full path, compared by UTF-16 code units, never locale.
 * Unlike search, no equivalent operations are merged into peers.
 */
export function listOperations(
  operations: readonly SearchResult[],
  catalogStamp: string,
  rawInput: ForageListInput,
): ListOutput {
  const parsed = forageListInput.safeParse(rawInput);
  if (!parsed.success)
    throw new ForageError("invalid_input", parsed.error.message);
  const input = parsed.data;
  const namespace = input.namespace ?? null;
  const sorted = operations
    .filter(
      (operation) =>
        namespace === null || operation.path.startsWith(`${namespace}.`),
    )
    .sort(
      (a, b) =>
        compareCodeUnits(
          operationNamespace(a.path),
          operationNamespace(b.path),
        ) || compareCodeUnits(a.path, b.path),
    );
  let start = 0;
  if (input.cursor !== undefined) {
    let cursor;
    try {
      cursor = cursorSchema.parse(JSON.parse(input.cursor));
    } catch (cause) {
      throw new ForageError("invalid_input", "Invalid listing cursor", {
        cause,
      });
    }
    if (cursor.catalogStamp !== catalogStamp || cursor.namespace !== namespace)
      throw new ForageError(
        "invalid_input",
        "Listing cursor belongs to a different catalog or namespace",
      );
    const index = sorted.findIndex(
      (operation) => operation.path === cursor.after,
    );
    if (index < 0)
      throw new ForageError(
        "invalid_input",
        "Listing cursor operation is absent from this view",
      );
    start = index + 1;
  }
  const results = sorted.slice(start, start + input.limit);
  const last = results.at(-1);
  return listOutputSchema.parse({
    results,
    total: sorted.length,
    catalogStamp,
    nextCursor:
      start + results.length < sorted.length && last !== undefined
        ? JSON.stringify({ catalogStamp, namespace, after: last.path })
        : null,
  });
}
