import { ForageError } from "./errors.js";
import {
  catalogInputSchema,
  forageDescribeInput,
  forageSearchInput,
  maximumDescriptionTypes,
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
import {
  renderNamespaceIndex,
  renderOperationTypes,
  schemaProjectionSize,
} from "./rendering.js";

const maximumCatalogProjectionBytes = 1_000_000;

type ParsedCatalog = {
  revision: string;
  operations: PreparedOperation[];
};

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
  let projectionBytes = 0;
  for (const operation of operations) {
    if (paths.has(operation.path)) {
      throw new ForageError(
        "duplicate_operation",
        `Duplicate operation path: ${operation.path}`,
      );
    }
    paths.add(operation.path);
    const inputProjection = schemaProjectionSize(operation.input, "input");
    if (inputProjection === undefined) {
      throw new ForageError(
        "invalid_input",
        `Schema projection is too large: ${operation.path}`,
      );
    }
    const outputProjection = operation.output
      ? schemaProjectionSize(operation.output, "output")
      : 0;
    if (outputProjection === undefined) {
      throw new ForageError(
        "invalid_input",
        `Schema output projection is too large: ${operation.path}`,
      );
    }
    projectionBytes +=
      inputProjection + outputProjection + operation.path.length;
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
  const preparedOperations = operations.map((operation) =>
    prepareOperation(operation),
  );
  const namespaces = new Map<string, PreparedOperation[]>();
  for (const operation of preparedOperations) {
    const namespace = operation.path.slice(0, operation.path.lastIndexOf("."));
    const group = namespaces.get(namespace) ?? [];
    group.push(operation);
    namespaces.set(namespace, group);
  }
  for (const [namespace, group] of namespaces) {
    const rendered = group.map((operation) => operation.rendered);
    const index = renderNamespaceIndex(rendered);
    const full = renderOperationTypes(rendered);
    if (
      index.length > maximumDescriptionTypes ||
      full.length > maximumDescriptionTypes
    ) {
      throw new ForageError(
        "invalid_input",
        `Namespace description exceeds the bounded output: ${namespace}`,
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
