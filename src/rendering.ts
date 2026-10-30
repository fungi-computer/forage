import { z } from "zod";
import { ForageError } from "./errors.js";
import { compareCodeUnits, jsonValueSchema } from "./normalization.js";
import type { JsonValue } from "./normalization.js";
import type { JsonSchemaSource, Operation } from "./schemas.js";

/** Requested TypeScript projections for one catalog operation. */
export type RenderedOperation = Readonly<{
  types: string;
  environment: string;
  indexEnvironment: string;
}>;

/** The JSON Schema subset Forage reads when it renders and samples a schema. */
const schemaNode = z.union([
  z.looseObject({
    $ref: z.string().optional(),
    $defs: z.record(z.string(), z.unknown()).optional(),
    definitions: z.record(z.string(), z.unknown()).optional(),
    const: z.unknown().optional(),
    enum: z.array(z.unknown()).optional(),
    oneOf: z.array(z.unknown()).optional(),
    anyOf: z.array(z.unknown()).optional(),
    allOf: z.array(z.unknown()).optional(),
    type: z.union([z.string(), z.array(z.string())]).optional(),
    properties: z.record(z.string(), z.unknown()).optional(),
    additionalProperties: z.unknown().optional(),
    required: z.array(z.string()).optional(),
    prefixItems: z.array(z.unknown()).optional(),
    items: z.unknown().optional(),
    examples: z.array(z.unknown()).optional(),
    default: z.unknown().optional(),
  }),
  z.boolean(),
]);
type SchemaNode = z.output<typeof schemaNode>;

type Projection = {
  readonly raw: object;
  text?: string;
};

/** Standard JSON Schema projections are immutable, per source and direction. */
const projections = new WeakMap<
  JsonSchemaSource,
  Partial<Record<"input" | "output", Projection>>
>();

function projectionFor(
  schema: JsonSchemaSource,
  io: "input" | "output",
): Projection {
  let entry = projections.get(schema);
  const cached = entry?.[io];
  if (cached !== undefined) return cached;
  let raw: object;
  try {
    raw = schema["~standard"].jsonSchema[io]({ target: "draft-2020-12" });
  } catch {
    throw new ForageError(
      "invalid_input",
      "Schema cannot be projected to JSON Schema",
    );
  }
  decodeNode(raw);
  const projection: Projection = { raw };
  if (entry === undefined) {
    entry = {};
    projections.set(schema, entry);
  }
  entry[io] = projection;
  return projection;
}

/** The producer's document, without a recursive projection decode or copy. */
export function rawSchema(
  schema: JsonSchemaSource,
  io: "input" | "output",
): object {
  return projectionFor(schema, io).raw;
}

/** Native serialization owns the document's text representation and failures. */
export function schemaText(
  schema: JsonSchemaSource,
  io: "input" | "output",
): string {
  const projection = projectionFor(schema, io);
  try {
    projection.text ??= JSON.stringify(projection.raw);
    return projection.text;
  } catch {
    throw new ForageError(
      "invalid_input",
      "Schema cannot be projected to JSON Schema",
    );
  }
}

function decodeNode(value: unknown): SchemaNode {
  const parsed = schemaNode.safeParse(value);
  if (!parsed.success)
    throw new ForageError(
      "invalid_input",
      "Schema cannot be projected to JSON Schema",
    );
  return parsed.data;
}

/** Local definitions a schema may reference, and the ones being expanded. */
type DefinitionScope = Readonly<{
  definitions: NonNullable<Exclude<SchemaNode, boolean>["$defs"]>;
  expanding: ReadonlySet<string>;
  /** Shared across one rendering; each `$ref` expansion spends one. */
  budget: { expansions: number };
}>;

/** Bounds the work and size of expanding shared `$defs` in one description. */
const maximumReferenceExpansions = 256;

const localReference = /^#\/(?:\$defs|definitions)\/([^/]+)$/u;

/** Expand a local `$ref` in place; a recursive reference renders `unknown`. */
function renderReference(
  reference: string,
  depth: number,
  refs: DefinitionScope,
): string {
  const name = localReference.exec(reference)?.[1];
  if (name === undefined || refs.expanding.has(name)) return "unknown";
  const target = refs.definitions[name];
  if (target === undefined) return "unknown";
  refs.budget.expansions += 1;
  if (refs.budget.expansions > maximumReferenceExpansions)
    throw new ForageError(
      "invalid_input",
      `Schema references expand more than ${String(maximumReferenceExpansions)} times; flatten its shared definitions`,
    );
  return renderNode(decodeNode(target), depth, {
    definitions: refs.definitions,
    expanding: new Set([...refs.expanding, name]),
    budget: refs.budget,
  });
}

/** Whether a node renders as a top-level TypeScript union. */
function rendersUnion(node: SchemaNode, refs: DefinitionScope): boolean {
  if (node === true || node === false) return false;
  if (node.$ref !== undefined) {
    const name = localReference.exec(node.$ref)?.[1];
    const target =
      name === undefined || refs.expanding.has(name)
        ? undefined
        : refs.definitions[name];
    return (
      name !== undefined &&
      target !== undefined &&
      rendersUnion(decodeNode(target), {
        definitions: refs.definitions,
        expanding: new Set([...refs.expanding, name]),
        budget: refs.budget,
      })
    );
  }
  if (node.const !== undefined) return false;
  return (
    (node.enum !== undefined && node.enum.length > 1) ||
    (node.oneOf !== undefined && node.oneOf.length > 1) ||
    (node.anyOf !== undefined && node.anyOf.length > 1)
  );
}

function renderNode(
  node: SchemaNode,
  depth: number,
  scope?: DefinitionScope,
): string {
  if (depth > 12) {
    return "unknown";
  }
  if (node === true || node === false) return "unknown";
  const refs = scope ?? {
    definitions: { ...node.definitions, ...node.$defs },
    expanding: new Set<string>(),
    budget: { expansions: 0 },
  };
  if (node.$ref) return renderReference(node.$ref, depth, refs);
  if (node.const !== undefined) return JSON.stringify(node.const);
  if (node.enum)
    return node.enum.map((value) => JSON.stringify(value)).join(" | ");
  if (node.oneOf) {
    return node.oneOf
      .map((value) => renderNode(decodeNode(value), depth + 1, refs))
      .join(" | ");
  }
  if (node.anyOf) {
    return node.anyOf
      .map((value) => renderNode(decodeNode(value), depth + 1, refs))
      .join(" | ");
  }
  if (node.allOf) {
    return node.allOf
      .map((value) => {
        const child = decodeNode(value);
        const member = renderNode(child, depth + 1, refs);
        // `&` binds tighter than `|`: keep a union member whole.
        return rendersUnion(child, refs) ? `(${member})` : member;
      })
      .join(" & ");
  }
  if (node.type === "object" || node.properties) {
    const properties = Object.entries(node.properties ?? {}).sort(
      ([left], [right]) => compareCodeUnits(left, right),
    );
    if (properties.length === 0) {
      const additional = node.additionalProperties;
      if (additional === false) return "Record<string, never>";
      if (additional && additional !== true) {
        return `Record<string, ${renderNode(decodeNode(additional), depth + 1, refs)}>`;
      }
      return "Record<string, unknown>";
    }
    const required = new Set(node.required ?? []);
    const lines = properties.map(([key, value]) => {
      const child = renderNode(decodeNode(value), depth + 1, refs);
      const optional = required.has(key) ? "" : "?";
      const safeKey = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)
        ? key
        : JSON.stringify(key);
      return `${"  ".repeat(depth + 1)}${safeKey}${optional}: ${child};`;
    });
    return `{
${lines.join("\n")}
${"  ".repeat(depth)}}`;
  }
  if (node.type === "array") {
    const items = node.items;
    if (node.prefixItems && node.prefixItems.length > 0) {
      const tuple = node.prefixItems.map((value) =>
        renderNode(decodeNode(value), depth + 1, refs),
      );
      if (items !== undefined && items !== true && !Array.isArray(items)) {
        tuple.push(`...${renderNode(decodeNode(items), depth + 1, refs)}[]`);
      }
      return `[${tuple.join(", ")}]`;
    }
    if (items !== undefined && Array.isArray(items))
      return `[${items.map((value) => renderNode(decodeNode(value), depth + 1, refs)).join(", ")}][]`;
    const itemNode = items === undefined ? true : decodeNode(items);
    const item = renderNode(itemNode, depth + 1, refs);
    const compoundItem =
      itemNode !== true &&
      itemNode !== false &&
      (itemNode.oneOf !== undefined ||
        itemNode.anyOf !== undefined ||
        itemNode.allOf !== undefined);
    return `${compoundItem ? `(${item})` : item}[]`;
  }
  switch (node.type) {
    case "string":
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    default:
      return "unknown";
  }
}

/** Render one schema's JSON Schema as deterministic TypeScript type text. */
function renderSchemaType(
  schema: JsonSchemaSource,
  io: "input" | "output" = "input",
): string {
  return renderNode(decodeNode(rawSchema(schema, io)), 0);
}

function safeTypeName(name: string): string {
  return name.replace(/[^A-Za-z0-9_$]/g, "_");
}

/** A quoted property tree also supports namespace segments that are TS keywords. */
function renderEnvironment(
  path: string,
  input: string,
  output: string,
): string {
  let declaration = `(input: ${input}) => Promise<${output}>`;
  for (const segment of path.split(".").reverse())
    declaration = `{ [${JSON.stringify(segment)}]: ${declaration} }`;
  return declaration;
}

/** Render a namespace index as a callable nested environment. */
export function renderNamespaceIndex(
  operations: readonly RenderedOperation[],
): string {
  return operations.length === 0
    ? ""
    : `export declare const env: ${operations.map((operation) => operation.indexEnvironment).join(" & ")};`;
}

/** Render whole-operation schemas and their callable nested environment. */
export function renderOperationTypes(
  operations: readonly RenderedOperation[],
): string {
  const types = operations.map((operation) => operation.types).join("\n\n");
  return operations.length === 0
    ? types
    : `${types}\nexport declare const env: ${operations.map((operation) => operation.environment).join(" & ")};`;
}

const renderedOperations = new WeakMap<Operation, RenderedOperation>();

/** Render only requested operations, once per immutable prepared operation. */
export function renderOperation(operation: Operation): RenderedOperation {
  const cached = renderedOperations.get(operation);
  if (cached !== undefined) return cached;
  const name = safeTypeName(operation.path.replace(/\./g, "$"));
  const input = renderSchemaType(operation.input, "input");
  const output = operation.output
    ? renderSchemaType(operation.output, "output")
    : "unknown";
  const rendered = Object.freeze({
    indexEnvironment: renderEnvironment(operation.path, input, output),
    environment: renderEnvironment(
      operation.path,
      `${name}_Input`,
      `${name}_Output`,
    ),
    types: `export type ${name}_Input = ${input};\nexport type ${name}_Output = ${output};`,
  });
  renderedOperations.set(operation, rendered);
  return rendered;
}

/** Derive sample arguments solely from input-schema examples and defaults. */
export function deriveSample(
  schema: JsonSchemaSource,
): Record<string, JsonValue> | undefined {
  const node = decodeNode(rawSchema(schema, "input"));
  if (node === true || node === false || !node.properties) {
    return undefined;
  }
  const sample: Record<string, JsonValue> = {};
  let found = false;
  const entries = Object.entries(node.properties).sort(([left], [right]) =>
    compareCodeUnits(left, right),
  );
  for (const [key, value] of entries) {
    const property = decodeNode(value);
    if (property === true || property === false) continue;
    const examples = property.examples;
    if (examples && examples.length > 0) {
      const example = jsonValueSchema.safeParse(examples[0]);
      if (example.success) {
        sample[key] = example.data;
        found = true;
      }
    } else if (property.default !== undefined) {
      const fallback = jsonValueSchema.safeParse(property.default);
      if (fallback.success) {
        sample[key] = fallback.data;
        found = true;
      }
    }
  }
  return found ? sample : undefined;
}
