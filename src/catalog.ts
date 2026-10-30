import { z } from "zod";
import { ForageError } from "./errors.js";
import {
  catalogInputSchema,
  forageDescribeInput,
  forageSearchInput,
  maximumDescriptionTypes,
  maximumSampleBytes,
  maximumSampleDepth,
  maximumSampleEntries,
  jsonDepth,
  type CatalogInput,
  type ForageDescribeInput,
  type ForageSearchInput,
  type SearchOutput,
  type DescribeOutput,
  type ForageListInput,
  type ListOutput,
  type SearchResult,
} from "./schemas.js";
import { describeCatalog } from "./describe.js";
import {
  catalogStamp,
  prepareOperation,
  searchCatalog,
  type PreparedOperation,
} from "./search.js";
import { compareCodeUnits } from "./normalization.js";
import { listOperations } from "./list.js";
import { rawSchema, schemaText } from "./rendering.js";

const maximumCatalogProjectionBytes = 1_000_000;

type ParsedCatalog = {
  revision: string;
  operations: PreparedOperation[];
};

/**
 * A nesting bound on the raw producer document, not a second JSON decoder.
 * The ceiling bounds recursion; sibling order cannot change the maximum.
 * Indexed traversal avoids cold iterator results and heap stack entries.
 */
function schemaDepth(children: readonly unknown[], depth = 0): number {
  if (depth >= maximumSampleDepth)
    return children.length === 0 ? depth : depth + 1;
  let maximum = depth;
  for (let index = children.length - 1; index >= 0; index -= 1) {
    const child = children[index];
    let childDepth = depth + 1;
    if (Array.isArray(child)) childDepth = schemaDepth(child, childDepth);
    else if (z.util.isObject(child))
      childDepth = schemaDepth(Object.values(child), childDepth);
    maximum = Math.max(maximum, childDepth);
    if (maximum > maximumSampleDepth) return maximum;
  }
  return maximum;
}

/** Immutable public facade for one prepared catalog revision. */
export type ForageCatalog = Readonly<{
  /** Immutable revision supplied when the catalog was created. */
  revision: string;
  /** Deterministically rank provisioned operations for a bounded query. */
  search: (rawInput: ForageSearchInput) => SearchOutput;
  /** Render bounded types and operation input constraints from the validator. */
  describe: (rawInput: ForageDescribeInput) => DescribeOutput;
  /** Enumerate every operation exactly once in stable namespace/path order. */
  list: (rawInput: ForageListInput) => ListOutput;
  /** Return the stable identity stamp for this catalog revision. */
  stamp: () => string;
}>;

function parseCatalog(input: CatalogInput): ParsedCatalog {
  const parsed = catalogInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new ForageError("invalid_input", parsed.error.message);
  }
  if (parsed.data.operations.length === 0) {
    throw new ForageError("empty_catalog", "Catalog must contain an operation");
  }
  const operations = [...parsed.data.operations].sort((left, right) =>
    compareCodeUnits(left.path, right.path),
  );
  const paths = new Set<string>();
  const preparedOperations: PreparedOperation[] = [];
  let projectionBytes = 0;
  for (const operation of operations) {
    if (paths.has(operation.path)) {
      throw new ForageError(
        "duplicate_operation",
        `Duplicate operation path: ${operation.path}`,
      );
    }
    paths.add(operation.path);
    const inputProjection = schemaText(operation.input, "input").length;
    if (
      inputProjection > maximumDescriptionTypes ||
      schemaDepth(Object.values(rawSchema(operation.input, "input"))) >
        maximumSampleDepth
    ) {
      throw new ForageError(
        "invalid_input",
        `Schema projection is too large: ${operation.path}`,
      );
    }
    const outputProjection = operation.output
      ? schemaText(operation.output, "output").length
      : 0;
    if (
      outputProjection > maximumDescriptionTypes ||
      (operation.output !== undefined &&
        schemaDepth(Object.values(rawSchema(operation.output, "output"))) >
          maximumSampleDepth)
    ) {
      throw new ForageError(
        "invalid_input",
        `Schema output projection is too large: ${operation.path}`,
      );
    }
    const prepared = prepareOperation(operation);
    const sample = prepared.sample;
    const sampleBytes =
      sample === undefined ? 0 : JSON.stringify(sample).length;
    if (
      sample !== undefined &&
      (Object.keys(sample).length > maximumSampleEntries ||
        sampleBytes > maximumSampleBytes ||
        jsonDepth(sample, 0) > maximumSampleDepth)
    )
      throw new ForageError(
        "invalid_input",
        `Schema projection is too large: ${operation.path}`,
      );
    preparedOperations.push(prepared);
    projectionBytes +=
      prepared.inputBytes +
      prepared.outputBytes +
      sampleBytes +
      operation.path.length;
    projectionBytes += operation.description?.length ?? 0;
    projectionBytes += operation.capabilityNotes?.length ?? 0;
    projectionBytes += operation.instructions?.length ?? 0;
    if (projectionBytes > maximumCatalogProjectionBytes) {
      throw new ForageError(
        "invalid_input",
        "Catalog metadata exceeds the bounded projection",
      );
    }
  }
  return {
    revision: parsed.data.revision,
    operations: preparedOperations,
  };
}

/** Construct one immutable catalog revision with a narrow public facade. */
export function createCatalog(input: CatalogInput): ForageCatalog {
  const parsed = parseCatalog(input);
  const operations = Object.freeze(parsed.operations);
  const stamp = catalogStamp(operations);
  const summaries: readonly SearchResult[] = operations.map((operation) => {
    const summary: SearchResult = { path: operation.path, score: 0 };
    if (operation.description !== undefined)
      summary.description = operation.description;
    if (operation.sample !== undefined) summary.sample = operation.sample;
    if (operation.capabilityNotes !== undefined)
      summary.capabilityNotes = operation.capabilityNotes;
    return summary;
  });

  const search = (rawInput: ForageSearchInput): SearchOutput => {
    const parsed = forageSearchInput.safeParse(rawInput);
    if (!parsed.success) {
      throw new ForageError("invalid_input", parsed.error.message);
    }
    if (parsed.data.query.trim().length === 0) {
      throw new ForageError("empty_query", "Search query must not be empty");
    }
    return searchCatalog(
      operations,
      parsed.data.query,
      parsed.data.maxResults,
      stamp,
    );
  };

  const describe = (rawInput: ForageDescribeInput): DescribeOutput => {
    const parsed = forageDescribeInput.safeParse(rawInput);
    if (!parsed.success) {
      throw new ForageError("invalid_input", parsed.error.message);
    }
    if (parsed.data.path.trim().length === 0) {
      throw new ForageError(
        "empty_query",
        "Description target must not be empty",
      );
    }
    return describeCatalog(operations, parsed.data);
  };

  return Object.freeze({
    revision: parsed.revision,
    search,
    describe,
    list: (input) => listOperations(summaries, stamp, input),
    stamp: () => stamp,
  });
}
