import { jsonSchemaSubset } from "@fungi.computer/forage/json-schema-subset";
import {
  normalizeOpenApi,
  parseOpenApiTable,
} from "@fungi.computer/forage/openapi";
import {
  Forage,
  jsonSchemaToZod,
  appToolSchemas,
  appToolFamilySchemas,
  appMethodSchemas,
  appApiOperations,
} from "@fungi.computer/forage";
import { z } from "zod";

const catalog = Forage.createCatalog({
  revision: "stranger",
  operations: [
    {
      path: "files.read",
      description: "Read a file",
      input: z.object({ path: z.string() }),
    },
  ],
});

const hiddenApi = {
  methods: {
    rebuild: {
      description: "Rebuild internal copies",
      effect: "read",
      requires: [],
      hidden: true,
      input: { type: "object" },
      output: { type: "string" },
    },
  },
};
if (
  Object.keys(appToolSchemas(hiddenApi)).length !== 0 ||
  appApiOperations("APP", hiddenApi).length !== 0 ||
  !appMethodSchemas(hiddenApi).rebuild.output.safeParse("rebuilt").success
)
  throw new Error(
    "Packed hidden discovery or direct validation contract drifted",
  );

const search = catalog.search({ query: "read" });
const description = catalog.describe({ path: "files.read" });

if (
  search.results[0]?.path !== "files.read" ||
  description.kind !== "operation"
) {
  throw new Error(
    "Forage stranger import did not preserve its public contract",
  );
}

const preview = await normalizeOpenApi(
  JSON.stringify({
    openapi: "3.1.0",
    info: { title: "Packed Petstore", version: "1" },
    paths: {
      "/pets": {
        get: {
          operationId: "listPets",
          responses: { 200: { description: "OK" } },
        },
      },
    },
  }),
);
const selected = await parseOpenApiTable(preview.operations);
if (
  selected.operations[0]?.name !== "listPets" ||
  !jsonSchemaToZod(selected.operations[0].input).safeParse({}).success
) {
  throw new Error("Packed OpenAPI intake or shared compiler is unavailable");
}

if (
  jsonSchemaSubset().safeParse({ type: "string", pattern: "^(a|a)+$" }).success
) {
  throw new Error("Packed shared subset admitted a forbidden regex");
}
if (
  !jsonSchemaSubset().safeParse({
    type: "object",
    properties: { name: { type: "string" } },
  }).success
) {
  throw new Error("Packed shared subset did not preserve supported schemas");
}

if (appToolFamilySchemas(hiddenApi, { kind: "unindexed" }) !== null)
  throw new Error("Packed optional family projection changed ordinary APIs");
