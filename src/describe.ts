import {
  describeOutputSchema,
  maximumDescriptionTypes,
  type DescribeOutput,
  type ForageDescribeInput,
} from "./schemas.js";
import { compareCodeUnits } from "./normalization.js";
import { renderNamespaceIndex, renderOperationTypes } from "./rendering.js";
import { ForageError } from "./errors.js";
import type { PreparedOperation } from "./search.js";

function boundedDescription(value: string | undefined): string | undefined {
  return value && value.length > 0 ? value : undefined;
}

function checkedDescription(output: DescribeOutput): DescribeOutput {
  const parsed = describeOutputSchema.safeParse(output);
  if (!parsed.success) {
    throw new ForageError(
      "invalid_input",
      "Description output exceeded its bounds",
    );
  }
  return parsed.data;
}

/** Pure deterministic description of an operation or its namespace. */
export function describeCatalog(
  operations: readonly PreparedOperation[],
  rawInput: ForageDescribeInput,
): DescribeOutput {
  const operation = operations.find(
    (candidate) => candidate.path === rawInput.path,
  );
  if (operation) {
    const callPath = `env.${operation.path}`;
    const output = {
      path: operation.path,
      description: boundedDescription(operation.description),
      types: renderOperationTypes([operation.rendered]),
      kind: "operation",
      inputSchema: operation.inputSchema,
      usage: `await ${callPath}({ ... })`,
    } as const;
    if (output.types.length > maximumDescriptionTypes) {
      throw new ForageError(
        "invalid_input",
        "Description types exceed the bounded output",
      );
    }
    return checkedDescription(output);
  }

  const prefix = `${rawInput.path}.`;
  const namespaceOperations = operations
    .filter((candidate) => candidate.path.startsWith(prefix))
    .sort((left, right) => compareCodeUnits(left.path, right.path));
  if (namespaceOperations.length === 0) {
    throw new ForageError("unknown_target", `Unknown target: ${rawInput.path}`);
  }
  const first = namespaceOperations[0];
  if (!first) {
    throw new ForageError("unknown_target", `Unknown target: ${rawInput.path}`);
  }
  const selected = rawInput.methods?.length
    ? namespaceOperations.filter((candidate) =>
        rawInput.methods?.includes(candidate.path.slice(prefix.length)),
      )
    : namespaceOperations;

  let types: string;
  if (rawInput.detail === "index") {
    types = renderNamespaceIndex(
      namespaceOperations.map((operation) => operation.rendered),
    );
  } else if (rawInput.methods?.length && selected.length === 0) {
    types = renderNamespaceIndex(
      namespaceOperations.map((operation) => operation.rendered),
    );
  } else {
    types = renderOperationTypes(
      (selected.length > 0 ? selected : namespaceOperations).map(
        (operation) => operation.rendered,
      ),
    );
  }

  if (types.length > maximumDescriptionTypes) {
    throw new ForageError(
      "invalid_input",
      "Description types exceed the bounded output",
    );
  }
  return checkedDescription({
    path: rawInput.path,
    description: boundedDescription(first.instructions),
    types,
    kind: "module",
  });
}
