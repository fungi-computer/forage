import { jsonSchemaSubset } from "./json-schema-subset.js";
import {
  parameterName,
  thirdPartyText,
  isUnsafeSchemaPropertyName,
  jsonSchemaValueInspection,
  type jsonSchemaContainer,
  schemaDepthLimit,
  schemaNodeLimit,
} from "./json-schema-boundary.js";
import * as z from "zod";
import { isCollection, isPair, isScalar, parseDocument, visit } from "yaml";
import $RefParser from "@apidevtools/json-schema-ref-parser";
import { jsonSchemaToZod } from "./app-api.js";

const reservedNames = new Set([
  "describe",
  "search",
  "then",
  "prototype",
  ...Object.getOwnPropertyNames(Object.prototype),
]);
const operationMethods = [
  "get",
  "head",
  "options",
  "post",
  "put",
  "patch",
  "delete",
  "trace",
] as const;
const pathTemplate = z
  .string()
  .max(2048)
  .regex(
    /^\/(?:[A-Za-z0-9._~-]|%[0-9A-Fa-f]{2}|\{[A-Za-z0-9._~-]{1,128}\}|\/)*$/u,
  )
  .refine(
    (path) =>
      !path.includes("//") &&
      !path.split("/").some((part) => part === "." || part === "..") &&
      !/%(?:2e|2f|5c|25)/iu.test(path),
  );
const forbiddenHeaders = new Set([
  "authorization",
  "cookie",
  "host",
  "content-length",
  "connection",
  "transfer-encoding",
  "accept-encoding",
  "set-cookie",
  "upgrade",
  "te",
  "trailer",
  "keep-alive",
  "expect",
  "via",
  "forwarded",
  "x-real-ip",
  "max-forwards",
  "x-http-method-override",
  "x-method-override",
  "x-http-method",
  "content-type",
]);

/** Bounded provider-authored text. Hosts must frame it as data, never instructions. */
export type OpenApiThirdPartyText = string & z.BRAND<"ThirdPartyText">;
const jsonSchema = z.union([z.record(z.string(), z.json()), z.boolean()]);
const supportedSchema = jsonSchemaSubset(false);
const supportedSchema30 = jsonSchemaSubset(true);

const parameter = z.object({
  name: parameterName,
  in: z.enum(["path", "query", "header"]),
  required: z.boolean().default(false),
  schema: jsonSchema,
  style: z.string().optional(),
  explode: z.boolean().optional(),
  allowReserved: z.boolean().optional(),
});
const media = z.object({ schema: jsonSchema.optional() });
const content = z.record(z.string(), media);
const operation = z.object({
  operationId: z.string().max(128).optional(),
  summary: thirdPartyText(2048).prefault(""),
  description: thirdPartyText(2048).prefault(""),
  tags: z.array(thirdPartyText(64)).max(16).default([]),
  parameters: z.array(parameter).default([]),
  requestBody: z
    .object({ required: z.boolean().default(false), content })
    .optional(),
  responses: z.record(
    z.string(),
    z.object({
      description: thirdPartyText(2048),
      content: content.optional(),
    }),
  ),
});
const authScheme = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("apiKey"),
    in: z.enum(["header", "query"]),
    name: parameterName,
  }),
  z.object({
    type: z.literal("http"),
    scheme: z
      .string()
      .transform((scheme) => scheme.toLowerCase())
      .pipe(z.literal("bearer")),
  }),
  z.object({ type: z.literal("oauth2") }),
]);
const authHintsSchema = z.array(
  z.discriminatedUnion("kind", [
    z.object({
      scheme: z.string().max(128),
      kind: z.enum(["api_key_header", "api_key_query"]),
      name: parameterName,
    }),
    z.object({
      scheme: z.string().max(128),
      kind: z.enum(["bearer", "oauth", "unsupported"]),
    }),
  ]),
);
const intakeOptions = z.object({
  authParameter: z
    .object({ in: z.enum(["header", "query"]), name: z.string() })
    .optional(),
});
/** Optional owner-declared credential parameter excluded from guest input. */
export type OpenApiIntakeOptions = {
  authParameter?: { in: "header" | "query"; name: string };
};

// Server entries are discovery hints, never credential destinations or egress grants.
// Relative entries remain relative; only the caller knows the spec retrieval URL.
const serverHint = z
  .string()
  .min(1)
  .max(2048)
  .transform((value, ctx) => {
    try {
      const url = new URL(value, "https://relative-openapi.invalid/");
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        value.startsWith("//") ||
        /[\\\s]/u.test(value)
      ) {
        ctx.addIssue({
          code: "custom",
          message: "Server hints require HTTPS without credentials",
        });
        return z.NEVER;
      }
      return /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value) ? url.href : value;
    } catch (cause) {
      ctx.addIssue({
        code: "custom",
        message: cause instanceof Error ? cause.message : "Invalid server URL",
      });
      return z.NEVER;
    }
  });

const document = z.object({
  openapi: z.string().regex(/^3\.[01]\.\d+$/u),
  info: z.object({
    title: thirdPartyText(200).min(1),
    version: z.string().max(128),
  }),
  servers: z.array(z.object({ url: serverHint })).default([]),
  paths: z.record(
    z.string().startsWith("/").max(2048),
    z.record(z.string(), z.json()),
  ),
  components: z.record(z.string(), z.json()).default({}),
});

/** Stable intake and per-operation refusal codes. */
export type OpenApiRefusalCode =
  | "too_large"
  | "invalid_spec"
  | "not_openapi3"
  | "nodes_limit"
  | "depth_limit"
  | "alias_limit"
  | "external_reference"
  | "recursive_schema"
  | "operations_limit"
  | "invalid_operation"
  | "unsupported_schema"
  | "parameter_collision"
  | "unsafe_auth_parameter"
  | "unsafe_header"
  | "unsupported_parameter"
  | "unsupported_media"
  | "unsupported_path_item"
  | "unsupported_method"
  | "table_too_large"
  | "invalid_table"
  | "unsafe_name"
  | "unsafe_path";

/** A bounded intake refusal, distinct from a listed unsupported operation. */
export class OpenApiError extends Error {
  override readonly name = "OpenApiError";
  constructor(
    readonly code: OpenApiRefusalCode,
    message: string,
    cause?: unknown,
  ) {
    super(message, { cause });
  }
}

/** One stored operation, independent of spec-host URLs or credentials. */
export const openApiOperationSchema = z
  .strictObject({
    status: z.literal("supported"),
    name: z
      .string()
      .max(80)
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/u)
      .refine((name) => !reservedNames.has(name)),
    method: z.enum([
      "GET",
      "HEAD",
      "OPTIONS",
      "POST",
      "PUT",
      "PATCH",
      "DELETE",
    ]),
    path: pathTemplate,
    effect: z.enum(["read", "write"]),
    description: thirdPartyText(2048),
    textSource: z.literal("third_party"),
    tags: z.array(thirdPartyText(64)).max(16),
    parameters: z.array(parameter),
    input: supportedSchema,
    output: supportedSchema,
  })
  .refine(
    (op) => op.effect === operationEffect(op.method),
    "Effect must match the HTTP method",
  )
  .superRefine((op, ctx) => {
    try {
      validateParameters(op.path, op.parameters);
    } catch (cause) {
      if (cause instanceof OpenApiError || cause instanceof z.ZodError)
        ctx.addIssue({ code: "custom", message: "Unsafe OpenAPI parameters" });
      else throw cause;
    }
  });
/** Decoded normalized operation ready for selection, not an execution grant. */
export type OpenApiOperation = z.output<typeof openApiOperationSchema>;
/** An operation's supported call shape or bounded unsupported reason. */
export type OpenApiPreviewOperation =
  | OpenApiOperation
  | {
      status: "unsupported";
      name: string;
      method: string;
      path: string;
      reason: OpenApiRefusalCode;
    };

function operationEffect(method: string) {
  return ["GET", "HEAD", "OPTIONS"].includes(method) ? "read" : "write";
}
function validateParameters(
  path: string,
  parameters: z.output<typeof parameter>[],
  authHints: z.output<typeof authHintsSchema> = [],
  authParameter?: OpenApiIntakeOptions["authParameter"],
  schemaDecoder: typeof supportedSchema = supportedSchema30,
) {
  if (!pathTemplate.safeParse(path).success)
    throw new OpenApiError("unsafe_path", "Unsafe OpenAPI path template");
  const pathNames = [...path.matchAll(/\{([^{}]+)\}/gu)].map(
    (match) => match[1],
  );
  if (
    pathNames.some(
      (name) =>
        !parameters.some(
          (p) => p.in === "path" && p.name === name && p.required,
        ),
    ) ||
    parameters.some(
      (p) => p.in === "path" && (!p.required || !pathNames.includes(p.name)),
    )
  )
    throw new OpenApiError(
      "invalid_operation",
      "Path parameters must match required placeholders",
    );
  const parameterNames = new Set<string>();
  for (const p of parameters) {
    const scalar = z
      .object({
        type: z.union([
          z.enum(["string", "number", "integer", "boolean"]),
          z
            .array(z.enum(["string", "number", "integer", "boolean", "null"]))
            .min(1),
        ]),
      })
      .safeParse(p.schema);
    const style = p.in === "query" ? "form" : "simple";
    if (
      !scalar.success ||
      (p.style !== undefined && p.style !== style) ||
      (p.explode !== undefined && p.explode !== (p.in === "query")) ||
      p.allowReserved === true
    )
      throw new OpenApiError(
        "unsupported_parameter",
        "Only scalar parameters with default serialization are supported",
      );
    if (parameterNames.has(p.name))
      throw new OpenApiError(
        "parameter_collision",
        "Flattened parameter names collide",
      );
    parameterNames.add(p.name);
    if (
      authHints.some(
        (auth) =>
          "name" in auth &&
          auth.name.toLowerCase() === p.name.toLowerCase() &&
          auth.kind === `api_key_${p.in}`,
      ) ||
      (authParameter?.in === p.in &&
        authParameter.name.toLowerCase() === p.name.toLowerCase())
    )
      throw new OpenApiError(
        "unsafe_auth_parameter",
        "The credential parameter cannot be supplied by a guest",
      );
    const header = p.name.toLowerCase();
    if (
      p.in === "header" &&
      (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/u.test(p.name) ||
        forbiddenHeaders.has(header) ||
        /^(?:proxy-|x-forwarded-|nango-|cf-)/iu.test(header))
    )
      throw new OpenApiError(
        "unsafe_header",
        "A reserved or malformed header cannot be a parameter",
      );
    schemaDecoder.parse(p.schema);
  }
}

async function resolveOperation(
  spec: z.output<typeof document>,
  raw: z.output<ReturnType<typeof z.json>>,
  parameters: z.output<ReturnType<typeof z.json>>,
) {
  const parser = new $RefParser();
  return parser.dereference(
    { ...spec, operation: raw, parameters },
    {
      mutateInputSchema: false,
      resolve: { external: false, file: false, http: false },
      dereference: {
        maxDepth: schemaDepthLimit,
        circular: false,
        excludedPathMatcher: (path) =>
          path.startsWith("#/components") || path.startsWith("#/paths"),
        onCircular: () => {
          throw new OpenApiError(
            "recursive_schema",
            "Recursive operation schemas are unsupported",
          );
        },
      },
    },
  );
}

function inspectDocument(
  doc: ReturnType<typeof parseDocument>,
  budget: { nodes: number },
) {
  const countNode = (path: readonly unknown[]) => {
    if (++budget.nodes > schemaNodeLimit)
      throw new OpenApiError("nodes_limit", "The spec exceeds 50,000 nodes");
    if (path.filter(isCollection).length > schemaDepthLimit)
      throw new OpenApiError("depth_limit", "The spec exceeds depth 32");
  };
  visit(doc, {
    Node: (_key, _node, path) => {
      countNode(path);
    },
    Alias: () => {
      throw new OpenApiError("alias_limit", "YAML aliases are not supported");
    },
    Scalar: (_key, scalar, path) => {
      countNode(path);
      const owner = path.findLast(isPair);
      if (
        owner &&
        isScalar(owner.key) &&
        owner.key.value === "required" &&
        isUnsafeSchemaPropertyName(
          z.string().safeParse(scalar.value).data ?? "",
        )
      )
        throw new OpenApiError("unsafe_name", "Unsafe required property name");
    },
    Pair: (_key, pair, path) => {
      countNode(path);
      if (
        isScalar(pair.key) &&
        isUnsafeSchemaPropertyName(
          z.string().safeParse(pair.key.value).data ?? "",
        )
      )
        throw new OpenApiError("unsafe_name", "Unsafe object property name");
      if (
        isScalar(pair.key) &&
        pair.key.value === "name" &&
        isScalar(pair.value) &&
        isUnsafeSchemaPropertyName(
          z.string().safeParse(pair.value.value).data ?? "",
        )
      )
        throw new OpenApiError("unsafe_name", "Unsafe parameter name");
      if (isScalar(pair.key) && pair.key.value === "$ref") {
        const reference = z
          .string()
          .startsWith("#/")
          .safeParse(isScalar(pair.value) ? pair.value.value : null);
        if (!reference.success)
          throw new OpenApiError(
            "external_reference",
            "Only local #/ references are supported",
            reference.error,
          );
      }
    },
  });
}

function inspectExpansion(
  source: z.output<typeof jsonSchemaContainer>,
  budget: { nodes: number },
) {
  const refusal = jsonSchemaValueInspection(budget).parse(source);
  if (refusal) {
    const messages = {
      nodes_limit: "Expanded values exceed 50,000 nodes",
      depth_limit: "Expanded values exceed depth 32",
      unsafe_name: "Unsafe object property, parameter or required name",
    };
    throw new OpenApiError(refusal, messages[refusal]);
  }
}

function inspectOperationCount(paths: z.output<typeof document>["paths"]) {
  let count = 0;
  for (const item of Object.values(paths)) {
    count +=
      item.$ref !== undefined
        ? 1
        : operationMethods.filter((method) => item[method] !== undefined)
            .length;
    if (count > 500)
      throw new OpenApiError(
        "operations_limit",
        "The spec exceeds 500 operations",
      );
  }
}

/** Pure intake: the host supplies bounded spec text, never a fetch locator. */
export async function normalizeOpenApi(
  source: string,
  options: OpenApiIntakeOptions = {},
) {
  const authParameter = intakeOptions.parse(options).authParameter;
  if (
    source.length > 2 * 1024 * 1024 ||
    new TextEncoder().encode(source).byteLength > 2 * 1024 * 1024
  )
    throw new OpenApiError("too_large", "The spec exceeds 2 MiB");
  const syntax = parseDocument(source);
  if (syntax.errors.length)
    throw new OpenApiError(
      "invalid_spec",
      "Invalid JSON or YAML",
      syntax.errors[0],
    );
  inspectDocument(syntax, { nodes: 0 });
  const rawDocument: unknown = syntax.toJS({ maxAliasCount: 0 });
  const version = z
    .object({ openapi: z.string().regex(/^3\.[01]\.\d+$/u) })
    .safeParse(rawDocument);
  if (!version.success)
    throw new OpenApiError(
      "not_openapi3",
      "Not OpenAPI 3. Convert Swagger 2 to OpenAPI 3.",
    );
  const decoded = document.safeParse(rawDocument);
  if (!decoded.success)
    throw new OpenApiError(
      "invalid_spec",
      "Invalid OpenAPI 3 document",
      decoded.error,
    );
  const parsed = decoded.data;
  const intakeSchema = parsed.openapi.startsWith("3.0.")
    ? supportedSchema30
    : supportedSchema;
  const securityResult = z
    .object({ securitySchemes: z.record(parameterName, z.json()).default({}) })
    .safeParse(parsed.components);
  if (!securityResult.success)
    throw new OpenApiError(
      "invalid_spec",
      "Invalid security schemes",
      securityResult.error,
    );
  const security = securityResult.data;
  const authHints = authHintsSchema.parse(
    Object.entries(security.securitySchemes).map(([scheme, raw]) => {
      const parsed = authScheme.safeParse(raw);
      if (!parsed.success) return { scheme, kind: "unsupported" };
      const auth = parsed.data;
      if (auth.type === "apiKey")
        return {
          scheme,
          kind: auth.in === "header" ? "api_key_header" : "api_key_query",
          name: auth.name,
        };
      return { scheme, kind: auth.type === "http" ? "bearer" : "oauth" };
    }),
  );
  const budget = { nodes: 0 };
  const names = new Set(reservedNames);
  const operations: OpenApiPreviewOperation[] = [];
  // Refuse oversized catalogs before cloning or compiling individual operations.
  inspectOperationCount(parsed.paths);
  for (const [path, item] of Object.entries(parsed.paths).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    if (item.$ref !== undefined) {
      operations.push({
        status: "unsupported",
        name: `path_item_${String(operations.length)}`,
        method: "PATH_ITEM",
        path,
        reason: "unsupported_path_item",
      });
      continue;
    }
    for (const method of operationMethods) {
      const raw = item[method];
      if (raw === undefined) continue;
      const label = z
        .object({ operationId: z.string().max(128).optional() })
        .safeParse(raw);
      const preferred =
        label.success && label.data.operationId
          ? label.data.operationId
          : `${method}_${path}`;
      const cleaned = preferred.replace(/[^A-Za-z0-9_]/gu, "_").slice(0, 72);
      const base = /^[A-Za-z_]/u.test(cleaned) ? cleaned : `op_${cleaned}`;
      let name = base;
      for (let suffix = 2; names.has(name); suffix++)
        name = `${base}_${String(suffix)}`;
      names.add(name);
      try {
        if (method === "trace")
          throw new OpenApiError("unsupported_method", "TRACE is unsupported");
        const rawResolved = z
          .object({ operation: z.unknown(), parameters: z.unknown() })
          .parse(await resolveOperation(parsed, raw, item.parameters ?? []));
        inspectExpansion(
          {
            operation: rawResolved.operation,
            parameters: rawResolved.parameters,
          },
          budget,
        );
        const resolved = z
          .object({ operation, parameters: z.array(parameter) })
          .parse(rawResolved);
        const declared = resolved.operation;
        const merged = new Map<string, z.output<typeof parameter>>();
        for (const list of [resolved.parameters, declared.parameters]) {
          const seen = new Set<string>();
          for (const p of list) {
            const key = `${p.in}:${p.name}`;
            if (seen.has(key))
              throw new OpenApiError(
                "invalid_operation",
                "Duplicate parameters in one declaration",
              );
            seen.add(key);
            merged.set(key, p);
          }
        }
        const parameters = [...merged.values()];
        validateParameters(
          path,
          parameters,
          authHints,
          authParameter,
          intakeSchema,
        );
        const parameterNames = new Set(parameters.map((p) => p.name));
        const properties: Record<
          string,
          z.output<typeof jsonSchema>
        > = Object.fromEntries(
          parameters.map((parameter) => [parameter.name, parameter.schema]),
        );
        const required: string[] = [];
        for (const parameter of parameters) {
          if (parameter.required) required.push(parameter.name);
        }
        if (
          declared.requestBody &&
          declared.requestBody.content["application/json"]?.schema === undefined
        )
          throw new OpenApiError(
            "unsupported_media",
            "Request bodies require an application/json schema",
          );
        const body = declared.requestBody?.content["application/json"]?.schema;
        if (body !== undefined) {
          if (parameterNames.has("body"))
            throw new OpenApiError(
              "parameter_collision",
              "Body collides with a parameter",
            );
          properties.body = body;
          if (declared.requestBody?.required) required.push("body");
        }
        const input = {
          type: "object",
          properties,
          required,
          additionalProperties: false,
        };
        const successSchemas = Object.entries(declared.responses)
          .filter(([status]) => /^2\d\d$/u.test(status))
          .map(
            ([, response]) =>
              response.content?.["application/json"]?.schema ?? {},
          );
        const output =
          successSchemas.length > 1
            ? { anyOf: successSchemas }
            : (successSchemas[0] ?? {});
        const target = parsed.openapi.startsWith("3.0.")
          ? "openapi-3.0"
          : "draft-2020-12";
        const normalizedInput = z.toJSONSchema(
          jsonSchemaToZod(intakeSchema.parse(input), target),
          { io: "input" },
        );
        const normalizedOutput = z.toJSONSchema(
          jsonSchemaToZod(intakeSchema.parse(output), target),
          { io: "input" },
        );
        operations.push(
          openApiOperationSchema.parse({
            status: "supported",
            name,
            method: method.toUpperCase(),
            path,
            effect: operationEffect(method.toUpperCase()),
            description: declared.description || declared.summary,
            textSource: "third_party",
            tags: declared.tags,
            parameters,
            input: normalizedInput,
            output: normalizedOutput,
          }),
        );
      } catch (cause) {
        if (cause instanceof OpenApiError && cause.code === "nodes_limit")
          throw cause;
        operations.push({
          status: "unsupported",
          name,
          method: method.toUpperCase(),
          path,
          reason:
            cause instanceof OpenApiError
              ? cause.code
              : cause instanceof RangeError
                ? "depth_limit"
                : "unsupported_schema",
        });
      }
    }
  }
  const tableDigest = await digestOperations(
    operations.filter((op) => op.status === "supported"),
  );
  return {
    title: parsed.info.title,
    version: parsed.openapi,
    servers: parsed.servers.map((server) => server.url),
    authHints,
    operations,
    tableDigest,
  };
}

async function digestOperations(operations: OpenApiOperation[]) {
  const bytes = new TextEncoder().encode(JSON.stringify(operations));
  if (bytes.byteLength > 512 * 1024)
    throw new OpenApiError(
      "table_too_large",
      "The normalized table exceeds 512 KiB",
    );
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

/** Decode selected operations before persistence or execution; no authority is granted. */
export async function parseOpenApiTable(source: unknown) {
  const raw = z.array(z.unknown()).min(1).max(64).safeParse(source);
  if (!raw.success)
    throw new OpenApiError(
      "invalid_table",
      "Select 1–64 supported operations",
      raw.error,
    );
  inspectExpansion(raw.data, { nodes: 0 });
  const decoded = z
    .array(openApiOperationSchema)
    .min(1)
    .max(64)
    .safeParse(raw.data);
  if (!decoded.success)
    throw new OpenApiError(
      "invalid_table",
      "Select 1–64 supported operations",
      decoded.error,
    );
  const operations = decoded.data.sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  if (new Set(operations.map((op) => op.name)).size !== operations.length)
    throw new OpenApiError(
      "invalid_table",
      "Selected method names must be unique",
    );
  return { operations, digest: await digestOperations(operations) };
}
