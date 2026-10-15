import { expect, it } from "vitest";
import { jsonSchemaSubset } from "../src/json-schema-subset.js";
import { jsonSchemaToZod } from "../src/app-api.js";

it.each([
  "pattern",
  "patternProperties",
  "$ref",
  "$dynamicRef",
  "$recursiveRef",
  "$defs",
  "definitions",
])("refuses %s through the shared schema boundary", (keyword) => {
  expect(
    jsonSchemaSubset().safeParse({ type: "object", [keyword]: "remote" })
      .success,
  ).toBe(false);
});

it.each(["__proto__", "constructor", "prototype"])(
  "refuses the real JSON property %s",
  (name) => {
    const source: unknown = JSON.parse(
      `{"type":"object","properties":{"${name}":{"type":"string"}}}`,
    );
    expect(jsonSchemaSubset().safeParse(source).success).toBe(false);
    expect(
      jsonSchemaSubset().safeParse({ type: "object", required: [name] })
        .success,
    ).toBe(false);
  },
);

it("preserves compilation of supported nested schemas", () => {
  const schema = jsonSchemaSubset().parse({
    type: "object",
    properties: {
      names: { type: "array", items: { type: "string", minLength: 1 } },
    },
    required: ["names"],
    additionalProperties: false,
  });
  const compiled = jsonSchemaToZod(schema);
  expect(compiled.safeParse({ names: ["Proof"] }).success).toBe(true);
  expect(compiled.safeParse({ names: [""] }).success).toBe(false);
  expect(compiled.safeParse({}).success).toBe(false);
});

it("keeps nullable confined to the existing OpenAPI 3.0 intake", () => {
  const source = { type: "string", nullable: true };
  expect(jsonSchemaSubset().safeParse(source).success).toBe(false);
  expect(jsonSchemaSubset(true).safeParse(source).success).toBe(true);
});

type NestedItems = boolean | { items: NestedItems };
function nestedItems(depth: number): NestedItems {
  let value: NestedItems = true;
  for (let index = 0; index < depth; index++) value = { items: value };
  return value;
}

it("bounds depth before recursive decoding and returns a refusal", () => {
  expect(jsonSchemaSubset().safeParse(nestedItems(32)).success).toBe(true);
  expect(jsonSchemaSubset().safeParse(nestedItems(33)).success).toBe(false);
});

it.each(["__proto__", "constructor", "prototype"])(
  "refuses reserved key %s in all JSON value positions",
  (name) => {
    const value: unknown = JSON.parse(`{"${name}":{"x":1}}`);
    for (const schema of [
      { const: value },
      { enum: [value] },
      { default: value },
      { example: value },
      { examples: [value] },
    ])
      expect(jsonSchemaSubset().safeParse(schema).success).toBe(false);
  },
);

it("refuses a top-level own prototype key before records drop it", () => {
  const value: unknown = JSON.parse('{"__proto__":{},"type":"string"}');
  expect(jsonSchemaSubset().safeParse(value).success).toBe(false);
});

it("bounds expanded nodes before decoding shared schema branches", () => {
  type Branch = boolean | { anyOf: Branch[] };
  let branch: Branch = true;
  for (let index = 0; index < 7; index++)
    branch = { anyOf: Array.from({ length: 10 }, () => branch) };
  expect(jsonSchemaSubset().safeParse(branch).success).toBe(false);
});

it("accepts 50,000 expanded nodes and refuses the next node", () => {
  expect(
    jsonSchemaSubset().safeParse({ const: Array(49998).fill(false) }).success,
  ).toBe(true);
  expect(
    jsonSchemaSubset().safeParse({ const: Array(49999).fill(false) }).success,
  ).toBe(false);
});

it.each([1000, 10000])("bounds depth %i before Zod can overflow", (depth) => {
  expect(jsonSchemaSubset().safeParse(nestedItems(depth)).success).toBe(false);
  expect(
    jsonSchemaSubset().safeParse({ const: nestedItems(depth) }).success,
  ).toBe(false);
});
