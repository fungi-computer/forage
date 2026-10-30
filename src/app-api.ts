import { z } from "zod";
import type { AppApi } from "@fungi.computer/puffball";
import type { Operation } from "./schemas.js";

const bindingName = z.lazy(() =>
  z
    .string()
    .min(1)
    .max(75)
    .regex(/^[A-Za-z][A-Za-z0-9_]*$/),
);
const jsonSchemaDocument = z.lazy(() => z.record(z.string(), z.json()));
const jsonSchema = z.lazy(() => z.union([jsonSchemaDocument, z.boolean()]));

/** The shared JSON-Schema compiler for App methods and OpenAPI operations. */
export function jsonSchemaToZod(
  source: unknown,
  defaultTarget: "draft-2020-12" | "openapi-3.0" = "draft-2020-12",
) {
  return z.fromJSONSchema(jsonSchema.parse(source), { defaultTarget });
}

type StandardJsonSchema = z.ZodType["~standard"]["jsonSchema"];
type JsonSchemaDescription = ReturnType<StandardJsonSchema["input"]>;

/**
 * One decoded, immutable App declaration as a JSON-only Standard Schema.
 * Release and family-listing decoders own its JSON boundary. A catalog
 * describes every installed method on each capture but a turn validates only
 * the few it calls. Compiling every method eagerly exhausted an Agent Durable
 * Object's isolate. A draft 2020-12 description is the declaration itself;
 * validators compile for the call in hand and are never kept on the surface.
 */
export function appJsonSchema(
  declaration: AppApi["methods"][string]["input"] | boolean,
): Pick<
  z.ZodType<z.output<z.ZodJSONSchema>>,
  "parse" | "safeParse" | "~standard"
> {
  const build = () => jsonSchemaToZod(declaration);
  const validate = () => z.intersection(build(), z.json());
  const describe = (
    io: "input" | "output",
    options: Parameters<StandardJsonSchema["input"]>[0],
  ): JsonSchemaDescription => {
    if (
      options.target === "draft-2020-12" &&
      declaration !== true &&
      declaration !== false
    )
      return declaration;
    return build()["~standard"].jsonSchema[io](options);
  };
  return {
    parse: (value, options) => validate().parse(value, options),
    safeParse: (value, options) => validate().safeParse(value, options),
    "~standard": {
      version: 1,
      vendor: "zod",
      validate: (value, options) =>
        validate()["~standard"].validate(value, options),
      jsonSchema: {
        input: (options) => describe("input", options),
        output: (options) => describe("output", options),
      },
    },
  };
}

/** Describe App methods with call-scoped JSON validators.
 * Validation enforces both the declaration and JSON-only values; discovery
 * describes the declaration without adding JSON guard nesting.
 * Agar's emitted output already includes Pending for opted-in methods. */
export function appMethodSchemas(api: AppApi) {
  return Object.fromEntries(
    Object.entries(api.methods).map(
      ([method, declaration]) =>
        [
          method,
          {
            description: declaration.description,
            effect: declaration.effect,
            requires: declaration.requires,
            pending: declaration.pending,
            input: appJsonSchema(declaration.input),
            output: appJsonSchema(declaration.output),
          },
        ] as const,
    ),
  );
}

/** Describe discoverable App methods only; direct RPC validation uses appMethodSchemas. */
export function appToolSchemas(api: AppApi) {
  return appMethodSchemas({
    ...api,
    methods: Object.fromEntries(
      Object.entries(api.methods).filter(
        ([, method]) => method.hidden !== true,
      ),
    ),
  });
}

const familyRow = z.lazy(() =>
  z
    .object({
      tool: bindingName,
      title: z.string().max(120),
      description: z.string().max(1000),
      input: z.record(z.string(), z.json()),
      output: z.record(z.string(), z.json()),
      // Opaque extra arguments the declaring App wants merged with the
      // caller's own `input` when a host dispatches to the family's `call`
      // method (e.g. which of its own resources this row identifies, and any
      // App-to-App bindings only the declaring App can resolve). Required, so
      // a row that needs none still says so with `{}`. A host spreads this
      // verbatim; it never reads into or defaults any of it.
      call: z.record(z.string(), z.json()),
    })
    .catchall(z.json()),
);
const familyInventory = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("unindexed") }),
    z.strictObject({
      kind: z.literal("ready"),
      tools: z
        .array(familyRow)
        .max(100)
        .refine(
          (rows) => new Set(rows.map((row) => row.tool)).size === rows.length,
          { message: "Tool family names must be distinct" },
        ),
    }),
  ]),
);

/** Decode the signed listing before compiling dynamic discovery schemas.
 * Rows retain App-owned selectors as data. Hosts supply call admission and
 * invocation arguments; this projection supplies neither defaults nor handlers. */
export function appToolFamilySchemas(api: AppApi, reply: unknown) {
  const family = api.toolFamily;
  if (family === undefined) return null;
  const list = api.methods[family.list];
  const call = api.methods[family.call];
  if (list === undefined || call === undefined)
    throw new Error("Tool family references undeclared methods");
  const inventory = familyInventory.parse(
    appJsonSchema(list.output).parse(reply),
  );
  return {
    name: family.name,
    call: family.call,
    effect: call.effect,
    requires: call.requires,
    kind: inventory.kind,
    tools:
      inventory.kind === "unindexed"
        ? []
        : inventory.tools.map((row) => ({
            row,
            description: [row.title, row.description]
              .filter((text) => text.length > 0)
              .join("\n"),
            input: appJsonSchema(row.input),
            output: appJsonSchema(row.output),
          })),
  };
}

/**
 * Project an already decoded Release API into discovery data with the same
 * paths the Agent catalog uses (`PRINTS.generate`, called as
 * `env.PRINTS.generate()`). The introduction owner supplies the installation's
 * binding name; this function grants no access and supplies no execution
 * handler. Role aliases can project the same API.
 */
export function appApiOperations(
  name: string,
  api: AppApi,
): readonly Operation[] {
  const binding = bindingName.parse(name);
  return Object.entries(appToolSchemas(api)).map(([method, declaration]) => ({
    path: `${binding}.${method}`,
    description: declaration.description,
    input: declaration.input,
    output: declaration.output,
    capabilityNotes: `effect: ${declaration.effect}; requires: ${declaration.requires.join(", ") || "none"}`,
  }));
}
