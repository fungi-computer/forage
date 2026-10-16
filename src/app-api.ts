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
const jsonSchema = z.lazy(() =>
  z.union([z.record(z.string(), z.json()), z.boolean()]),
);

/** The shared JSON-Schema compiler for App methods and OpenAPI operations. */
export function jsonSchemaToZod(
  source: unknown,
  defaultTarget: "draft-2020-12" | "openapi-3.0" = "draft-2020-12",
) {
  return z.fromJSONSchema(jsonSchema.parse(source), { defaultTarget });
}

/** Validate JSON with Zod; describe the declaration without the redundant JSON guard. */
function appMethodSchema(
  source: AppApi["methods"][string]["input"],
): Pick<
  z.ZodType<z.output<z.ZodJSONSchema>>,
  "parse" | "safeParse" | "~standard"
> {
  const declared = jsonSchemaToZod(source);
  const validator = z.intersection(declared, z.json());
  return {
    parse: (value, options) => validator.parse(value, options),
    safeParse: (value, options) => validator.safeParse(value, options),
    "~standard": {
      ...validator["~standard"],
      jsonSchema: declared["~standard"].jsonSchema,
    },
  };
}

/** Compile App validators and their Standard JSON Schema descriptions.
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
            input: appMethodSchema(declaration.input),
            output: appMethodSchema(declaration.output),
          },
        ] as const,
    ),
  );
}

/** Compile discoverable App methods only; direct RPC validation uses appMethodSchemas. */
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
    appMethodSchema(list.output).parse(reply),
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
            input: appMethodSchema(row.input),
            output: appMethodSchema(row.output),
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
