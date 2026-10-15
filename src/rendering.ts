import { z } from "zod";
import { ForageError } from "./errors.js";
import {
  canonicalStringify,
  compareCodeUnits,
  isJsonObject,
  jsonValueSchema,
} from "./normalization.js";
import type { JsonValue } from "./normalization.js";
import {
  type JsonSchemaSource,
  maximumSampleBytes,
  maximumSampleDepth,
  maximumSampleEntries,
} from "./schemas.js";

/** Installation-time TypeScript projections for one catalog operation. */
export type RenderedOperation = Readonly<{
  types: string;
  environment: string;
  indexEnvironment: string;
}>;

/** The JSON Schema subset Forage reads when it renders and samples a schema. */
type SchemaNode =
  | boolean
  | Readonly<{
      $ref?: string | undefined;
      $defs?: Readonly<Record<string, SchemaNode>> | undefined;
      definitions?: Readonly<Record<string, SchemaNode>> | undefined;
      const?: unknown;
      enum?: readonly unknown[] | undefined;
      oneOf?: readonly SchemaNode[] | undefined;
      anyOf?: readonly SchemaNode[] | undefined;
      allOf?: readonly SchemaNode[] | undefined;
      type?: string | readonly string[] | undefined;
      properties?: Readonly<Record<string, SchemaNode>> | undefined;
      additionalProperties?: SchemaNode | undefined;
      required?: readonly string[] | undefined;
      prefixItems?: readonly SchemaNode[] | undefined;
      items?: SchemaNode | readonly SchemaNode[] | undefined;
      examples?: readonly unknown[] | undefined;
      default?: unknown;
    }>;

const schemaNode: z.ZodType<SchemaNode> = z.lazy(() =>
  z.union([
    z.boolean(),
    z.looseObject({
      $ref: z.string().optional(),
      $defs: z.record(z.string(), schemaNode).optional(),
      definitions: z.record(z.string(), schemaNode).optional(),
      const: z.unknown().optional(),
      enum: z.array(z.unknown()).optional(),
      oneOf: z.array(schemaNode).optional(),
      anyOf: z.array(schemaNode).optional(),
      allOf: z.array(schemaNode).optional(),
      type: z.union([z.string(), z.array(z.string())]).optional(),
      properties: z.record(z.string(), schemaNode).optional(),
      additionalProperties: schemaNode.optional(),
      required: z.array(z.string()).optional(),
      prefixItems: z.array(schemaNode).optional(),
      items: z.union([schemaNode, z.array(schemaNode)]).optional(),
      examples: z.array(z.unknown()).optional(),
      default: z.unknown().optional(),
    }),
  ]),
);

/** What one schema projects to in one direction, computed at most once. */
type SchemaFacts = {
  readonly node: SchemaNode;
  readonly json: JsonValue | undefined;
  fingerprint?: string;
  size?: Readonly<{ bytes: number | undefined }>;
};

/**
 * Facts already derived, per schema object and direction. A Standard JSON
 * Schema describes an immutable schema, so its projection is a pure function
 * of the object: compiling a catalog asks for the same projection several
 * times per operation (size, fingerprint, sample, rendering), and a host that
 * recompiles a catalog over the same installed schemas asks again on every
 * compile. Projecting, validating, fingerprinting and sizing once per schema
 * keeps catalog compilation proportional to what actually changed.
 */
const schemaFacts = new WeakMap<
  JsonSchemaSource,
  Partial<Record<"input" | "output", SchemaFacts>>
>();

function factsFor(
  schema: JsonSchemaSource,
  io: "input" | "output",
): SchemaFacts {
  let entry = schemaFacts.get(schema);
  const cached = entry?.[io];
  if (cached !== undefined) return cached;
  let node: SchemaNode;
  try {
    node = schemaNode.parse(
      schema["~standard"].jsonSchema[io]({ target: "draft-2020-12" }),
    );
  } catch {
    throw new ForageError(
      "invalid_input",
      "Schema cannot be projected to JSON Schema",
    );
  }
  const json = jsonValueSchema.safeParse(node);
  const facts: SchemaFacts = {
    node,
    json: json.success ? json.data : undefined,
  };
  if (entry === undefined) {
    entry = {};
    schemaFacts.set(schema, entry);
  }
  entry[io] = facts;
  return facts;
}

function schemaFor(
  schema: JsonSchemaSource,
  io: "input" | "output",
): SchemaNode {
  return factsFor(schema, io).node;
}

function isNodeList(
  value: SchemaNode | readonly SchemaNode[],
): value is readonly SchemaNode[] {
  return Array.isArray(value);
}

/** Local definitions a schema may reference, and the ones being expanded. */
type DefinitionScope = Readonly<{
  definitions: Readonly<Record<string, SchemaNode>>;
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
  return renderNode(target, depth, {
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
      rendersUnion(target, {
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
  node: SchemaNode | undefined,
  depth: number,
  refs: DefinitionScope,
): string {
  if (node === undefined || node === true || node === false || depth > 12) {
    return "unknown";
  }
  if (node.$ref) return renderReference(node.$ref, depth, refs);
  if (node.const !== undefined) return JSON.stringify(node.const);
  if (node.enum)
    return node.enum.map((value) => JSON.stringify(value)).join(" | ");
  if (node.oneOf) {
    return node.oneOf
      .map((value) => renderNode(value, depth + 1, refs))
      .join(" | ");
  }
  if (node.anyOf) {
    return node.anyOf
      .map((value) => renderNode(value, depth + 1, refs))
      .join(" | ");
  }
  if (node.allOf) {
    return node.allOf
      .map((value) => {
        const member = renderNode(value, depth + 1, refs);
        // `&` binds tighter than `|`: keep a union member whole.
        return rendersUnion(value, refs) ? `(${member})` : member;
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
        return `Record<string, ${renderNode(additional, depth + 1, refs)}>`;
      }
      return "Record<string, unknown>";
    }
    const required = new Set(node.required ?? []);
    const lines = properties.map(([key, value]) => {
      const child = renderNode(value, depth + 1, refs);
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
        renderNode(value, depth + 1, refs),
      );
      if (items !== undefined && items !== true && !isNodeList(items)) {
        tuple.push(`...${renderNode(items, depth + 1, refs)}[]`);
      }
      return `[${tuple.join(", ")}]`;
    }
    if (items !== undefined && isNodeList(items))
      return `[${items.map((value) => renderNode(value, depth + 1, refs)).join(", ")}][]`;
    const item = renderNode(items, depth + 1, refs);
    const compoundItem =
      items !== undefined &&
      items !== true &&
      items !== false &&
      (items.oneOf !== undefined ||
        items.anyOf !== undefined ||
        items.allOf !== undefined);
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
  const root = schemaFor(schema, io);
  const definitions =
    root === true || root === false
      ? {}
      : { ...root.definitions, ...root.$defs };
  return renderNode(root, 0, {
    definitions,
    expanding: new Set(),
    budget: { expansions: 0 },
  });
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

/** Prepare all TypeScript descriptions for one operation at installation. */
export function renderOperation(operation: {
  path: string;
  input: JsonSchemaSource;
  output?: JsonSchemaSource | undefined;
}): RenderedOperation {
  const name = safeTypeName(operation.path.replace(/\./g, "$"));
  const input = renderSchemaType(operation.input, "input");
  const output = operation.output
    ? renderSchemaType(operation.output, "output")
    : "unknown";
  return Object.freeze({
    indexEnvironment: renderEnvironment(operation.path, input, output),
    environment: renderEnvironment(
      operation.path,
      `${name}_Input`,
      `${name}_Output`,
    ),
    types: `export type ${name}_Input = ${input};\nexport type ${name}_Output = ${output};`,
  });
}

/** Derive sample arguments solely from input-schema examples and defaults. */
export function deriveSample(
  schema: JsonSchemaSource,
): Record<string, JsonValue> | undefined {
  const node = schemaFor(schema, "input");
  if (node === true || node === false || !node.properties) {
    return undefined;
  }
  const properties: Readonly<Record<string, SchemaNode>> = node.properties;
  const sample: Record<string, JsonValue> = {};
  let found = false;
  const entries = Object.entries(properties).sort(([left], [right]) =>
    compareCodeUnits(left, right),
  );
  for (const [key, value] of entries) {
    if (value === true || value === false) continue;
    const property = value;
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

/** Preserve validator constraints in the operation's Standard JSON Schema. */
export function inputSchemaProjection(schema: JsonSchemaSource): JsonValue {
  const projection = factsFor(schema, "input").json;
  if (projection === undefined) {
    throw new ForageError(
      "invalid_input",
      "Schema cannot be projected to JSON Schema",
    );
  }
  return projection;
}

/** Produce a canonical schema representation used in peer identity and stamps. */
export function schemaFingerprint(
  schema: JsonSchemaSource,
  io: "input" | "output" = "input",
): string {
  const facts = factsFor(schema, io);
  facts.fingerprint ??= canonicalStringify(facts.json ?? null);
  return facts.fingerprint;
}

function schemaDepth(value: JsonValue, depth: number): number {
  if (depth > maximumSampleDepth) return depth;
  if (Array.isArray(value)) {
    let maximum = depth;
    for (const item of value) {
      maximum = Math.max(maximum, schemaDepth(item, depth + 1));
    }
    return maximum;
  }
  if (!isJsonObject(value)) return depth;
  let maximum = depth;
  for (const entry of Object.values(value)) {
    maximum = Math.max(maximum, schemaDepth(entry, depth + 1));
  }
  return maximum;
}

/** Validate the bounded JSON projection before a catalog is installed. */
export function schemaProjectionSize(
  schema: JsonSchemaSource,
  io: "input" | "output",
): number | undefined {
  const facts = factsFor(schema, io);
  facts.size ??= { bytes: measureProjection(schema, io, facts.json) };
  return facts.size.bytes;
}

function measureProjection(
  schema: JsonSchemaSource,
  io: "input" | "output",
  projection: JsonValue | undefined,
): number | undefined {
  if (!projection) return undefined;
  const encoded = JSON.stringify(projection);
  if (
    encoded.length > 20_000 ||
    schemaDepth(projection, 0) > maximumSampleDepth
  ) {
    return undefined;
  }
  if (io === "output") return encoded.length;
  const sample = deriveSample(schema);
  if (!sample) return encoded.length;
  if (
    Object.keys(sample).length > maximumSampleEntries ||
    schemaDepth(sample, 0) > maximumSampleDepth
  ) {
    return undefined;
  }
  let sampleText: string | undefined;
  try {
    sampleText = JSON.stringify(sample);
  } catch {
    throw new ForageError(
      "invalid_input",
      "Derived schema sample cannot be serialized",
    );
  }
  if (!sampleText || sampleText.length > maximumSampleBytes) return undefined;
  return encoded.length + sampleText.length;
}
