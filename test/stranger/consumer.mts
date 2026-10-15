import { jsonSchemaSubset } from "@fungi.computer/forage/json-schema-subset";
import {
  normalizeOpenApi,
  parseOpenApiTable,
  type OpenApiOperation,
} from "@fungi.computer/forage/openapi";
import {
  Forage,
  appToolSchemas,
  appToolFamilySchemas,
  appMethodSchemas,
  type ForageCatalog,
} from "@fungi.computer/forage";
import { z } from "zod";

const catalog: ForageCatalog = Forage.createCatalog({
  revision: "stranger",
  operations: [
    {
      path: "files.read",
      input: z.object({ path: z.string() }),
    },
  ],
});

const stamp: string = catalog.stamp();
const path: string | undefined = catalog.search({ query: "read" }).results[0]
  ?.path;

void stamp;
void path;

async function intake(source: string): Promise<OpenApiOperation[]> {
  const preview = await normalizeOpenApi(source);
  const selected = await parseOpenApiTable(
    preview.operations.filter((op) => op.status === "supported"),
  );
  return selected.operations;
}
void intake;

const subset = jsonSchemaSubset().parse({ type: "object" });
void subset;

const hiddenApi = {
  methods: {
    rebuild: {
      description: "Rebuild internal copies",
      effect: "read" as const,
      requires: [],
      hidden: true as const,
      input: { type: "object" },
      output: { type: "string" },
    },
  },
};
const tools = appToolSchemas(hiddenApi);
const validators = appMethodSchemas(hiddenApi);
void tools;
void validators;

const absentFamily = appToolFamilySchemas(hiddenApi, { kind: "unindexed" });
void absentFamily;
