import { z } from "zod";

const pathPattern = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/;
const maximumCatalogOperations = 1_000;
const maximumScore = 221;
export const maximumDescriptionTypes = 20_000;
export const maximumSampleEntries = 100;
export const maximumSampleBytes = 4_000;
export const maximumSampleDepth = 16;

type JsonValue = z.output<z.ZodJSONSchema>;

function jsonDepth(value: JsonValue, depth: number): number {
  if (depth > maximumSampleDepth) return depth;
  if (Array.isArray(value)) {
    let maximum = depth;
    for (const item of value) {
      maximum = Math.max(maximum, jsonDepth(item, depth + 1));
    }
    return maximum;
  }
  if (value === null) return depth;
  const record = z.record(z.string(), z.json()).safeParse(value);
  if (!record.success) return depth;
  let maximum = depth;
  for (const item of Object.values(record.data)) {
    maximum = Math.max(maximum, jsonDepth(item, depth + 1));
  }
  return maximum;
}

const sampleSchema = z
  .record(z.string(), z.json())
  .superRefine((value, context) => {
    if (Object.keys(value).length > maximumSampleEntries) {
      context.addIssue({
        code: "custom",
        message: "Sample exceeds the entry bound",
      });
    }
    if (JSON.stringify(value).length > maximumSampleBytes) {
      context.addIssue({
        code: "custom",
        message: "Sample exceeds the byte bound",
      });
    }
    if (jsonDepth(value, 0) > maximumSampleDepth) {
      context.addIssue({
        code: "custom",
        message: "Sample exceeds the depth bound",
      });
    }
  });

/** Input accepted by the pure catalog search seam. */
export const forageSearchInput = z.object({
  query: z.string().max(200),
  maxResults: z.number().int().min(1).max(50).default(50),
});

/** Input accepted by the pure catalog description seam. */
export const forageDescribeInput = z.object({
  path: z.string().max(160),
  detail: z.enum(["index", "full"]).default("full"),
  methods: z.array(z.string().max(80)).max(50).optional(),
});

/** Exhaustive listing request; cursor is scoped to one immutable catalog and filter. */
export const forageListInput = z.object({
  cursor: z.string().max(400).optional(),
  limit: z.number().int().min(1).max(50).default(50),
  namespace: z
    .string()
    .min(1)
    .max(160)
    .regex(/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*$/)
    .optional(),
});

const peerSchema = z.object({
  path: z.string().max(160),
  capabilityNotes: z.string().max(500).optional(),
});

/** One ranked operation in a search response. */
export const searchResultSchema = z.object({
  path: z.string().max(160),
  description: z.string().max(1000).optional(),
  score: z.number().min(0).max(maximumScore),
  matchReason: z.string().max(500).optional(),
  sample: sampleSchema.optional(),
  capabilityNotes: z.string().max(500).optional(),
  peers: z.array(peerSchema).max(1000).optional(),
});

/** Bounded search response envelope. */
export const searchOutputSchema = z.object({
  results: z.array(searchResultSchema).max(50),
  total: z.number().int().min(0).max(maximumCatalogOperations),
  truncated: z.boolean(),
  topScore: z.number().min(0).max(maximumScore),
  margin: z.number().min(0).max(maximumScore),
  catalogStamp: z
    .string()
    .length(16)
    .regex(/^[0-9a-f]{16}$/),
});

/** One exhaustive page, using the exact search operation summary schema. */
export const listOutputSchema = z.object({
  results: z.array(searchResultSchema).max(50),
  total: z.number().int().min(0).max(maximumCatalogOperations),
  nextCursor: z.string().max(400).nullable(),
  catalogStamp: z
    .string()
    .length(16)
    .regex(/^[0-9a-f]{16}$/),
});

/** Deterministic description response. */
export const describeOutputSchema = z.object({
  path: z.string().max(160),
  description: z.string().max(1000).optional(),
  types: z.string().max(20000),
  inputSchema: z
    .json()
    .refine(
      (value) =>
        JSON.stringify(value).length <= maximumDescriptionTypes &&
        jsonDepth(value, 0) <= maximumSampleDepth,
      "Input schema exceeds the description bounds",
    )
    .optional(),
  kind: z.enum(["module", "operation"]),
  usage: z.string().max(300).optional(),
});

/** Closed failure vocabulary for malformed or absent catalog requests. */
export const forageFailureSchema = z.object({
  code: z.enum([
    "empty_query",
    "empty_catalog",
    "unknown_target",
    "duplicate_operation",
    "invalid_input",
  ]),
  message: z.string().max(1000),
});

/** Options Forage passes when it asks a schema for its JSON Schema. */
export type JsonSchemaTarget = Readonly<{ target: "draft-2020-12" }>;

/**
 * Any schema that describes itself through Standard JSON Schema: Zod 4
 * schemas natively, and Effect schemas through Mycelium. Forage only renders
 * descriptions; validation stays with the schema's owner.
 */
export type JsonSchemaSource = Readonly<{
  "~standard": Readonly<{
    jsonSchema: Readonly<{
      /** JSON Schema of the value the operation accepts. */
      input: (options: JsonSchemaTarget) => object;
      /** JSON Schema of the value the operation returns. */
      output: (options: JsonSchemaTarget) => object;
    }>;
  }>;
}>;

const jsonSchemaDescriber = z.object({
  "~standard": z.object({
    jsonSchema: z.object({
      input: z.instanceof(Function),
      output: z.instanceof(Function),
    }),
  }),
});
const jsonSchemaSource = z.custom<JsonSchemaSource>(
  (value) => jsonSchemaDescriber.safeParse(value).success,
  "Expected a Standard JSON Schema",
);

/** A secret-free, callback-free operation descriptor. */
export const operationSchema = z.object({
  path: z.string().min(3).max(160).regex(pathPattern),
  description: z.string().max(1000).optional(),
  input: jsonSchemaSource,
  output: jsonSchemaSource.optional(),
  capabilityNotes: z.string().max(500).optional(),
  instructions: z.string().max(1000).optional(),
});

/** Input used to construct one immutable catalog revision. */
export const catalogInputSchema = z.object({
  revision: z.string().min(1).max(160),
  operations: z.array(operationSchema).max(maximumCatalogOperations),
});

/** Parsed search request type. */
export type ForageSearchInput = z.input<typeof forageSearchInput>;
/** Exhaustive listing request type. */
export type ForageListInput = z.input<typeof forageListInput>;
/** Exhaustive page response type. */
export type ListOutput = z.infer<typeof listOutputSchema>;
/** Parsed description request type. */
export type ForageDescribeInput = z.input<typeof forageDescribeInput>;
/** One ranked search result type. */
export type SearchResult = z.infer<typeof searchResultSchema>;
/** Search response envelope type. */
export type SearchOutput = z.infer<typeof searchOutputSchema>;
/** Description response type. */
export type DescribeOutput = z.infer<typeof describeOutputSchema>;
/** Typed failure value type. */
export type ForageFailure = z.infer<typeof forageFailureSchema>;
/** Catalog operation descriptor type. */
export type Operation = z.infer<typeof operationSchema>;
/** Catalog construction input type. */
export type CatalogInput = z.input<typeof catalogInputSchema>;
