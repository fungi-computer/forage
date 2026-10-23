import { expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { jsonSchemaToZod } from "../src/index.js";
import * as discovery from "../src/index.js";
import { normalizeOpenApi, parseOpenApiTable } from "../src/openapi.js";

const petstore = {
  openapi: "3.0.3",
  info: { title: "Petstore", version: "1.0" },
  servers: [{ url: "https://pets.example/v1" }],
  paths: {
    "/pets/{petId}": {
      get: {
        operationId: "getPet",
        parameters: [
          {
            name: "petId",
            in: "path",
            required: true,
            schema: { type: "integer" },
          },
        ],
        responses: {
          "200": {
            description: "One pet",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { name: { type: "string" } },
                  required: ["name"],
                  additionalProperties: false,
                },
              },
            },
          },
        },
      },
    },
  },
};

it("normalizes an owner-supplied Petstore operation for discovery and typed calls", async () => {
  const document = await normalizeOpenApi(JSON.stringify(petstore));
  expect(document.title).toBe("Petstore");
  expect(document.operations).toHaveLength(1);
  const operation = document.operations[0];
  expect(operation).toMatchObject({
    status: "supported",
    name: "getPet",
    method: "GET",
    path: "/pets/{petId}",
    effect: "read",
    parameters: [{ name: "petId", in: "path", required: true }],
  });
  if (operation?.status !== "supported")
    throw new Error("Petstore operation unavailable");
  expect(jsonSchemaToZod(operation.input).safeParse({ petId: 4 }).success).toBe(
    true,
  );
  expect(
    jsonSchemaToZod(operation.input).safeParse({ petId: "wrong" }).success,
  ).toBe(false);
  expect(
    jsonSchemaToZod(operation.output).safeParse({ name: "Rex" }).success,
  ).toBe(true);
  expect(jsonSchemaToZod(operation.output).safeParse({ name: 7 }).success).toBe(
    false,
  );
  expect(document.tableDigest).toMatch(/^[a-f0-9]{64}$/u);
});

it("resolves local schema references and lists a recursive operation without admitting it", async () => {
  const spec = {
    ...petstore,
    components: {
      schemas: {
        Pet: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
        },
        Node: {
          type: "object",
          properties: { next: { $ref: "#/components/schemas/Node" } },
        },
      },
    },
    paths: {
      "/pets": {
        get: {
          operationId: "listPets",
          responses: {
            "200": {
              description: "Pet",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Pet" },
                },
              },
            },
          },
        },
      },
      "/recursive": {
        get: {
          operationId: "readNode",
          responses: {
            "200": {
              description: "Node",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Node" },
                },
              },
            },
          },
        },
      },
    },
  };
  const document = await normalizeOpenApi(JSON.stringify(spec));
  expect(
    document.operations.find((op) => op.name === "listPets"),
  ).toMatchObject({
    status: "supported",
    output: { properties: { name: { type: "string" } } },
  });
  expect(
    document.operations.find((op) => op.name === "readNode"),
  ).toMatchObject({ status: "unsupported", reason: "recursive_schema" });
});

it("refuses non-OpenAPI, oversized text, YAML aliases and external references at intake", async () => {
  await expect(
    normalizeOpenApi(JSON.stringify({ swagger: "2.0", paths: {} })),
  ).rejects.toMatchObject({ code: "not_openapi3" });
  await expect(
    normalizeOpenApi(" ".repeat(2 * 1024 * 1024 + 1)),
  ).rejects.toMatchObject({ code: "too_large" });
  await expect(
    normalizeOpenApi(
      "openapi: 3.1.0\ninfo: &a [x,x,x,x]\nx: &b [*a,*a,*a,*a]\ny: [*b,*b,*b,*b]\n",
    ),
  ).rejects.toMatchObject({ code: "alias_limit" });
  const external = JSON.stringify(petstore).replace(
    '"type":"integer"',
    '"$ref":"https://private.example/schema.json"',
  );
  await expect(normalizeOpenApi(external)).rejects.toMatchObject({
    code: "external_reference",
  });
});

it("accepts JSON and YAML 3.0/3.1 with sanitized, collision-free names and nullable schemas", async () => {
  const { stringify } = await import("yaml");
  for (const version of ["3.0.3", "3.1.0"]) {
    const spec = {
      ...petstore,
      openapi: version,
      paths: {
        "/a": {
          get: {
            operationId: "search",
            parameters: [
              {
                name: "name",
                in: "query",
                schema:
                  version === "3.0.3"
                    ? { type: "string", nullable: true }
                    : { type: ["string", "null"] },
              },
            ],
            responses: { "200": { description: "OK" } },
          },
        },
        "/b": {
          post: {
            operationId: "get-pet",
            responses: { "204": { description: "OK" } },
          },
        },
        "/c": {
          get: {
            operationId: "get pet",
            responses: { "200": { description: "OK" } },
          },
        },
      },
    };
    const json = await normalizeOpenApi(JSON.stringify(spec));
    const yaml = await normalizeOpenApi(stringify(spec));
    expect(json.operations).toEqual(yaml.operations);
    expect(json.operations.map((op) => op.name)).toEqual([
      "search_2",
      "get_pet",
      "get_pet_2",
    ]);
    const nullable = json.operations[0];
    if (nullable?.status !== "supported")
      throw new Error("Nullable operation unavailable");
    expect(
      jsonSchemaToZod(nullable.input).safeParse({ name: null }).success,
    ).toBe(true);
    expect(json.operations[1]).toMatchObject({ effect: "write" });
  }
});

it("does not silently widen unsupported schema constraints or flatten credential/header collisions", async () => {
  const response = { "200": { description: "OK" } };
  const spec = {
    ...petstore,
    paths: {
      "/unique": {
        post: {
          operationId: "uniquePets",
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  items: { type: "string" },
                  uniqueItems: true,
                },
              },
            },
          },
          responses: response,
        },
      },
      "/headers": {
        get: {
          operationId: "readAuth",
          parameters: [
            { name: "Authorization", in: "header", schema: { type: "string" } },
          ],
          responses: response,
        },
      },
      "/collision": {
        get: {
          operationId: "collision",
          parameters: [
            { name: "id", in: "query", schema: { type: "string" } },
            { name: "id", in: "header", schema: { type: "integer" } },
          ],
          responses: response,
        },
      },
    },
  };
  const document = await normalizeOpenApi(JSON.stringify(spec));
  expect(document.operations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: "uniquePets",
        status: "unsupported",
        reason: "unsupported_schema",
      }),
      expect.objectContaining({
        name: "readAuth",
        status: "unsupported",
        reason: "unsafe_header",
      }),
      expect.objectContaining({
        name: "collision",
        status: "unsupported",
        reason: "parameter_collision",
      }),
    ]),
  );
});

it("keeps operation overrides, alternative success responses and auth names out of guest parameters", async () => {
  const spec = {
    ...petstore,
    components: {
      securitySchemes: {
        key: { type: "apiKey", in: "header", name: "X-API-Key" },
      },
    },
    paths: {
      "/pets": {
        parameters: [
          { name: "limit", in: "query", schema: { type: "integer" } },
        ],
        get: {
          operationId: "listPets",
          parameters: [
            {
              name: "limit",
              in: "query",
              schema: { type: "integer", maximum: 10 },
            },
          ],
          responses: {
            "200": {
              description: "Name",
              content: { "application/json": { schema: { type: "string" } } },
            },
            "201": {
              description: "Id",
              content: { "application/json": { schema: { type: "integer" } } },
            },
          },
        },
      },
      "/key": {
        get: {
          operationId: "readKey",
          parameters: [
            { name: "X-API-Key", in: "header", schema: { type: "string" } },
          ],
          responses: { "200": { description: "OK" } },
        },
      },
    },
  };
  const document = await normalizeOpenApi(JSON.stringify(spec));
  const list = document.operations.find((op) => op.name === "listPets");
  if (list?.status !== "supported")
    throw new Error("Parameter override unavailable");
  expect(jsonSchemaToZod(list.input).safeParse({ limit: 11 }).success).toBe(
    false,
  );
  expect(jsonSchemaToZod(list.output).safeParse(12).success).toBe(true);
  expect(jsonSchemaToZod(list.output).safeParse("Rex").success).toBe(true);
  expect(document.operations.find((op) => op.name === "readKey")).toMatchObject(
    { status: "unsupported", reason: "unsafe_auth_parameter" },
  );
  expect(document.authHints).toContainEqual({
    scheme: "key",
    kind: "api_key_header",
    name: "X-API-Key",
  });
});

it("refuses wire shapes it cannot faithfully serialize instead of discarding them", async () => {
  const responses = { "200": { description: "OK" } };
  const spec = {
    ...petstore,
    paths: {
      "/form": {
        post: {
          requestBody: {
            content: {
              "application/x-www-form-urlencoded": {
                schema: { type: "object" },
              },
            },
          },
          responses,
        },
      },
      "/deep": {
        get: {
          parameters: [
            {
              name: "filter",
              in: "query",
              style: "deepObject",
              schema: { type: "object" },
            },
          ],
          responses,
        },
      },
      "/missing/{id}": { get: { responses } },
      "/trace": { trace: { responses } },
    },
  };
  const document = await normalizeOpenApi(JSON.stringify(spec));
  expect(document.operations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        path: "/form",
        status: "unsupported",
        reason: "unsupported_media",
      }),
      expect.objectContaining({
        path: "/deep",
        status: "unsupported",
        reason: "unsupported_parameter",
      }),
      expect.objectContaining({
        path: "/missing/{id}",
        status: "unsupported",
        reason: "invalid_operation",
      }),
      expect.objectContaining({
        path: "/trace",
        status: "unsupported",
        reason: "unsupported_method",
      }),
    ]),
  );
});

it("decodes a selected table with unique methods, at most 64 operations and a stable digest", async () => {
  const preview = await normalizeOpenApi(JSON.stringify(petstore));
  const selected = preview.operations.filter((op) => op.status === "supported");
  const table = await parseOpenApiTable(selected);
  expect(table.operations).toEqual(selected);
  expect(table.digest).toMatch(/^[a-f0-9]{64}$/u);
  await expect(
    parseOpenApiTable([...selected, ...selected]),
  ).rejects.toMatchObject({ code: "invalid_table" });
  await expect(
    parseOpenApiTable(
      Array.from({ length: 65 }, (_, i) => ({
        ...selected[0],
        name: `op${String(i)}`,
      })),
    ),
  ).rejects.toMatchObject({ code: "invalid_table" });
  await expect(
    parseOpenApiTable(
      Array.from({ length: 40 }, (_, i) => ({
        ...selected[0],
        name: `op${String(i)}`,
        input: { const: "x".repeat(16 * 1024) },
      })),
    ),
  ).rejects.toMatchObject({ code: "table_too_large" });
  await expect(
    parseOpenApiTable([{ status: "unsupported", name: "bad" }]),
  ).rejects.toMatchObject({ code: "invalid_table" });
});

it("lists referenced Path Items explicitly instead of silently losing their operations", async () => {
  const spec = {
    ...petstore,
    components: { pathItems: { pets: petstore.paths["/pets/{petId}"] } },
    paths: { "/pets/{petId}": { $ref: "#/components/pathItems/pets" } },
  };
  const preview = await normalizeOpenApi(JSON.stringify(spec));
  expect(preview.operations).toContainEqual(
    expect.objectContaining({
      path: "/pets/{petId}",
      status: "unsupported",
      reason: "unsupported_path_item",
    }),
  );
});

it("bounds real serialized document depth, node count and operation count", async () => {
  type NestedSchema =
    | { type: "string" }
    | { type: "object"; properties: { child: NestedSchema } };
  let nested: NestedSchema = { type: "string" };
  for (let i = 0; i < 34; i++)
    nested = { type: "object", properties: { child: nested } };
  await expect(
    normalizeOpenApi(
      JSON.stringify({ ...petstore, components: { schemas: { nested } } }),
    ),
  ).rejects.toMatchObject({ code: "depth_limit" });
  await expect(
    normalizeOpenApi(
      JSON.stringify({
        ...petstore,
        "x-data": Array.from({ length: 50_001 }, () => false),
      }),
    ),
  ).rejects.toMatchObject({ code: "nodes_limit" });
  const paths = Object.fromEntries(
    Array.from({ length: 501 }, (_, i) => [
      `/pets${String(i)}`,
      { get: { responses: { "200": { description: "OK" } } } },
    ]),
  );
  await expect(
    normalizeOpenApi(JSON.stringify({ ...petstore, paths })),
  ).rejects.toMatchObject({ code: "operations_limit" });
});

it.each([
  {
    kind: "TRACE",
    item: { trace: { responses: { "200": { description: "OK" } } } },
    reason: "unsupported_method",
  },
  {
    kind: "referenced Path Item",
    item: { $ref: "#/components/pathItems/pet" },
    reason: "unsupported_path_item",
  },
])(
  "counts $kind entries, not metadata-only paths, toward the operation limit",
  async ({ item, reason }) => {
    const paths = Object.fromEntries(
      Array.from({ length: 500 }, (_, index) => [`/p${String(index)}`, item]),
    );
    const spec = {
      ...petstore,
      components: { pathItems: { pet: petstore.paths["/pets/{petId}"] } },
      paths: { ...paths, "/zz-metadata": { summary: "No operation" } },
    };
    const preview = await normalizeOpenApi(JSON.stringify(spec));
    expect(preview.operations).toHaveLength(500);
    expect(preview.operations[0]).toMatchObject({
      status: "unsupported",
      reason,
    });
    await expect(
      normalizeOpenApi(
        JSON.stringify({ ...spec, paths: { ...spec.paths, "/extra": item } }),
      ),
    ).rejects.toMatchObject({ code: "operations_limit" });
  },
);

it("counts multiple methods on each path toward the operation limit", async () => {
  const response = { responses: { "200": { description: "OK" } } };
  const item = Object.fromEntries(
    ["get", "head", "options", "post", "put", "patch", "delete", "trace"].map(
      (method) => [method, response],
    ),
  );
  await expect(
    normalizeOpenApi(
      JSON.stringify({
        ...petstore,
        paths: Object.fromEntries(
          Array.from({ length: 63 }, (_, index) => [
            `/p${String(index)}`,
            item,
          ]),
        ),
      }),
    ),
  ).rejects.toMatchObject({ code: "operations_limit" });
});

it.each([
  { width: 10, depth: 7 },
  { width: 2000, depth: 2 },
])(
  "refuses reference fan-out $width by $depth before materializing a shared graph",
  ({ width, depth }) => {
    type FanoutSchema =
      | { type: "string" }
      | { type: "object"; properties: Record<string, { $ref: string }> };
    const schemas: Record<string, FanoutSchema> = {};
    schemas.S0 = { type: "string" };
    for (let level = 1; level <= depth; level++) {
      schemas[`S${String(level)}`] = {
        type: "object",
        properties: Object.fromEntries(
          Array.from({ length: width }, (_, i) => [
            `p${String(i)}`,
            { $ref: `#/components/schemas/S${String(level - 1)}` },
          ]),
        ),
      };
    }
    const source = JSON.stringify({
      ...petstore,
      components: { schemas },
      paths: {
        "/fanout": {
          get: {
            responses: {
              "200": {
                description: "OK",
                content: {
                  "application/json": {
                    schema: { $ref: `#/components/schemas/S${String(depth)}` },
                  },
                },
              },
            },
          },
        },
      },
    });
    const child = spawnSync(
      process.execPath,
      [
        "--max-old-space-size=128",
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `
    import { readFileSync } from "node:fs";
    import { normalizeOpenApi } from "./src/openapi.ts";
    try { await normalizeOpenApi(readFileSync(0, "utf8")); throw new Error("fan-out admitted"); }
    catch (cause) { if (cause.code !== "nodes_limit") throw cause; process.stdout.write(cause.code); }
  `,
      ],
      {
        cwd: new URL("..", import.meta.url),
        input: source,
        encoding: "utf8",
        timeout: 5000,
        maxBuffer: 128 * 1024,
      },
    );
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr.slice(-1000)).toBe(0);
    expect(child.stdout).toBe("nodes_limit");
  },
  10_000,
);

it("refuses regex and unknown schema constraints before compilation", async () => {
  for (const schema of [
    { type: "string", pattern: "^(a|a)+$" },
    { type: "object", patternProperties: { "^(a+)+$": { type: "string" } } },
    { type: "object", unevaluatedProperties: false },
  ]) {
    const source = {
      ...petstore,
      paths: {
        "/regex": {
          post: {
            requestBody: { content: { "application/json": { schema } } },
            responses: { "200": { description: "OK" } },
          },
        },
      },
    };
    expect(
      (await normalizeOpenApi(JSON.stringify(source))).operations[0],
    ).toMatchObject({ status: "unsupported", reason: "unsupported_schema" });
  }
});

it("refuses forged stored operations at the same admission boundary as intake", async () => {
  const preview = await normalizeOpenApi(JSON.stringify(petstore));
  const op = preview.operations[0];
  if (op?.status !== "supported") throw new Error("Petstore unavailable");
  for (const tampered of [
    { ...op, method: "POST", effect: "read" },
    { ...op, path: "//evil.example/steal" },
    {
      ...op,
      parameters: [
        ...op.parameters,
        {
          name: "Authorization",
          in: "header",
          required: true,
          schema: { type: "string" },
        },
      ],
    },
    { ...op, input: { type: "string", pattern: "^(a|a)+$" } },
    { ...op, output: { type: "object", unevaluatedProperties: false } },
    { ...op, name: "then" },
  ])
    await expect(parseOpenApiTable([tampered])).rejects.toMatchObject({
      code: "invalid_table",
    });
});

it("refuses prototype names before any decoder can drop their fields", async () => {
  for (const name of ["__proto__", "constructor", "prototype"]) {
    const body = {
      type: "object",
      properties: Object.fromEntries([[name, { type: "string" }]]),
      required: [name],
    };
    const spec = {
      ...petstore,
      paths: {
        "/body": {
          post: {
            requestBody: { content: { "application/json": { schema: body } } },
            responses: { "200": { description: "OK" } },
          },
        },
      },
    };
    await expect(normalizeOpenApi(JSON.stringify(spec))).rejects.toMatchObject({
      code: "unsafe_name",
    });
    const good = (await normalizeOpenApi(JSON.stringify(petstore)))
      .operations[0];
    await expect(
      parseOpenApiTable([{ ...good, input: body }]),
    ).rejects.toMatchObject({ code: "unsafe_name" });
  }
});

it("bounds third-party descriptions, tags, titles and schema annotations", async () => {
  await expect(
    normalizeOpenApi(
      JSON.stringify({
        ...petstore,
        info: { title: "x".repeat(201), version: "1" },
      }),
    ),
  ).rejects.toMatchObject({ code: "invalid_spec" });
  for (const extra of [
    { description: "x".repeat(2049) },
    { summary: "x".repeat(2049) },
    { tags: ["x".repeat(65)] },
    { tags: Array.from({ length: 17 }, () => "tag") },
  ]) {
    const source = {
      ...petstore,
      paths: {
        "/text": {
          get: { ...extra, responses: { "200": { description: "OK" } } },
        },
      },
    };
    expect(
      (await normalizeOpenApi(JSON.stringify(source))).operations[0],
    ).toMatchObject({ status: "unsupported" });
  }
  const source = {
    ...petstore,
    paths: {
      "/text": {
        get: {
          description: "Provider-owned text",
          responses: { "200": { description: "OK" } },
        },
      },
    },
  };
  expect(
    (await normalizeOpenApi(JSON.stringify(source))).operations[0],
  ).toMatchObject({
    description: "Provider-owned text",
    textSource: "third_party",
  });
});

it("keeps Node-oriented intake off the discovery root", () => {
  expect(discovery).not.toHaveProperty("normalizeOpenApi");
  expect(discovery).not.toHaveProperty("parseOpenApiTable");
});

it("accepts relative server hints and refuses non-HTTPS or credential-bearing URLs", async () => {
  for (const url of ["/v1", "../api", "https://pets.example:443/v1"]) {
    expect(
      (
        await normalizeOpenApi(
          JSON.stringify({ ...petstore, servers: [{ url }] }),
        )
      ).operations[0],
    ).toMatchObject({ status: "supported" });
  }
  for (const url of [
    "javascript:alert(1)",
    "file:///tmp/spec",
    "http://pets.example",
    "https://user:password@pets.example",
    "//evil.example/api",
  ]) {
    await expect(
      normalizeOpenApi(JSON.stringify({ ...petstore, servers: [{ url }] })),
    ).rejects.toMatchObject({ code: "invalid_spec" });
  }
});

it("refuses unsupported formats and OpenAPI 3.1 nullable instead of dropping semantics", async () => {
  for (const schema of [
    { type: "string", format: "custom" },
    { type: "string", format: "email" },
    { type: "string", nullable: true },
  ]) {
    const spec = {
      ...petstore,
      openapi: "3.1.0",
      paths: {
        "/schema": {
          post: {
            requestBody: { content: { "application/json": { schema } } },
            responses: { "200": { description: "OK" } },
          },
        },
      },
    };
    expect(
      (await normalizeOpenApi(JSON.stringify(spec))).operations[0],
    ).toMatchObject({ status: "unsupported", reason: "unsupported_schema" });
  }
});

it("refuses unsafe path templates and reserved transport headers at intake", async () => {
  for (const path of [
    "//evil.example/x",
    "/../admin",
    "/x?query=1",
    "/x#fragment",
    "/x\\y",
    "/x%2fadmin",
    "/x%25admin",
  ]) {
    const spec = {
      ...petstore,
      paths: {
        [path]: { get: { responses: { "200": { description: "OK" } } } },
      },
    };
    expect(
      (await normalizeOpenApi(JSON.stringify(spec))).operations[0],
    ).toMatchObject({ status: "unsupported", reason: "unsafe_path" });
  }
  for (const name of [
    "Bad\r\nHeader",
    "Transfer-Encoding",
    "Connection",
    "TE",
    "Upgrade",
    "Content-Type",
    "Set-Cookie",
    "Forwarded",
    "X-Real-IP",
    "CF-Connecting-IP",
    "X-HTTP-Method-Override",
  ]) {
    const spec = {
      ...petstore,
      paths: {
        "/headers": {
          get: {
            parameters: [{ name, in: "header", schema: { type: "string" } }],
            responses: { "200": { description: "OK" } },
          },
        },
      },
    };
    expect(
      (await normalizeOpenApi(JSON.stringify(spec))).operations[0],
    ).toMatchObject({ status: "unsupported", reason: "unsafe_header" });
  }
});

it("keeps serialized depth below 64 when enforcing the depth-32 boundary", async () => {
  type NestedItems = boolean | { items: NestedItems };
  let nested: NestedItems = false;
  for (let index = 0; index < 33; index++) nested = { items: nested };
  await expect(
    normalizeOpenApi(JSON.stringify({ ...petstore, "x-data": nested })),
  ).rejects.toMatchObject({ code: "depth_limit" });
});
