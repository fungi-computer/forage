import {
  describeOutputSchema,
  maximumDescriptionTypes,
  type DescribeOutput,
  type ForageDescribeInput,
} from "./schemas.js";
import { compareCodeUnits, jsonValueSchema } from "./normalization.js";
import {
  rawSchema,
  renderOperation,
  renderNamespaceIndex,
  renderOperationTypes,
} from "./rendering.js";
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

function oneLine(value: string | undefined): string {
  const first = (value ?? "").trim().split("\n")[0] ?? "";
  return first.length > 120 ? `${first.slice(0, 119)}…` : first;
}

/**
 * A namespace too large to describe in full still gets an answer: its method
 * names with one-line descriptions, cut at the bound with a count of what is
 * left, and how to reach each method's types or page the rest.
 */
function tailFor(path: string, rest: number): string {
  return `\n// ${String(rest)} more ${rest === 1 ? "method" : "methods"} not shown; page them with list({ namespace: "${path}" }).`;
}

function methodIndex(
  path: string,
  prefix: string,
  operations: readonly PreparedOperation[],
): string {
  const header = `// ${path}: ${String(operations.length)} ${operations.length === 1 ? "method" : "methods"}; their full types exceed the output bound.\n// Describe ${path}.<method> for one method's types, or pass methods: [...] for several.\n`;
  const lines = operations.map((operation) => {
    const description = oneLine(operation.description);
    const name = operation.path.slice(prefix.length);
    return description.length > 0
      ? `//   ${name} - ${description}`
      : `//   ${name}`;
  });
  // The longest tail names every method left, so it bounds any real tail.
  let used = header.length + tailFor(path, lines.length).length;
  const kept: string[] = [];
  for (const line of lines) {
    if (used + line.length + 1 > maximumDescriptionTypes) break;
    kept.push(line);
    used += line.length + 1;
  }
  const rest = lines.length - kept.length;
  return `${header}${kept.join("\n")}${rest > 0 ? tailFor(path, rest) : ""}`;
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
    const inputSchema = jsonValueSchema.safeParse(
      rawSchema(operation.input, "input"),
    );
    if (!inputSchema.success)
      throw new ForageError(
        "invalid_input",
        "Schema cannot be projected to JSON Schema",
      );
    const output = {
      path: operation.path,
      description: boundedDescription(operation.description),
      types: renderOperationTypes([renderOperation(operation)]),
      kind: "operation",
      inputSchema: inputSchema.data,
      usage: `await ${callPath}({ ... })`,
    } as const;
    if (output.types.length > maximumDescriptionTypes) {
      throw new ForageError(
        "invalid_input",
        "Operation description exceeds the bounded output",
      );
    }
    return checkedDescription(output);
  }

  const prefix = `${rawInput.path}.`;
  const namespaceOperations = operations
    .filter((candidate) => candidate.path.startsWith(prefix))
    .sort((left, right) => compareCodeUnits(left.path, right.path));
  if (namespaceOperations.length === 0) {
    throw new ForageError(
      "unknown_target",
      `Unknown target: ${rawInput.path}. Use forage.search to find available paths.`,
    );
  }
  const first = namespaceOperations[0];
  if (!first) {
    throw new ForageError(
      "unknown_target",
      `Unknown target: ${rawInput.path}. Use forage.search to find available paths.`,
    );
  }
  const selected = rawInput.methods?.length
    ? namespaceOperations.filter((candidate) =>
        rawInput.methods?.includes(candidate.path.slice(prefix.length)),
      )
    : namespaceOperations;

  let types: string;
  if (rawInput.detail === "index") {
    types = renderNamespaceIndex(namespaceOperations.map(renderOperation));
  } else if (rawInput.methods?.length && selected.length === 0) {
    types = renderNamespaceIndex(namespaceOperations.map(renderOperation));
  } else {
    types = renderOperationTypes(
      (selected.length > 0 ? selected : namespaceOperations).map(
        renderOperation,
      ),
    );
  }

  if (types.length > maximumDescriptionTypes)
    types = methodIndex(
      rawInput.path,
      prefix,
      selected.length > 0 && rawInput.methods?.length
        ? selected
        : namespaceOperations,
    );
  return checkedDescription({
    path: rawInput.path,
    description: boundedDescription(first.instructions),
    types,
    kind: "module",
  });
}
