import { expect, it } from "vitest";
import {
  compareCodeUnits,
  hashString64,
  isJsonObject,
  jsonValueSchema,
  type JsonValue,
} from "../src/normalization.js";
import { describeOutputSchema } from "../src/schemas.js";

it.each([
  { label: "empty", value: "" },
  { label: "single unit", value: "a" },
  { label: "ASCII", value: "hello" },
  { label: "long metadata", value: "schema".repeat(2000) },
  { label: "Unicode", value: "🍄\u0000\ud800" },
  { label: "JSON", value: '{"10":"ten","2":"two","schema":{"type":"object"}}' },
])("preserves the 64-bit UTF-16 stamp for $label", ({ value }) => {
  const expected = value
    .split("")
    .reduce(
      (hash, unit) =>
        BigInt.asUintN(
          64,
          (hash ^ BigInt(unit.charCodeAt(0))) * 0x100000001b3n,
        ),
      0xcbf29ce484222325n,
    );
  expect(hashString64(value)).toBe(expected.toString(16).padStart(16, "0"));
});

it.each([
  [null, false],
  [true, false],
  [false, false],
  [0, false],
  ["record", false],
  [[], false],
  [{}, true],
  [{ nested: [null, false, { text: "value" }] }, true],
])(
  "distinguishes decoded JSON objects from other JSON values (%j)",
  (input, object) => {
    expect(isJsonObject(jsonValueSchema.parse(input))).toBe(object);
  },
);

it("orders metadata by UTF-16 code units rather than locale or numeric order", () => {
  expect(["z", "2", "10", "b", "A"].sort(compareCodeUnits)).toEqual([
    "10",
    "2",
    "A",
    "b",
    "z",
  ]);
});

it.each(["objects", "arrays"])(
  "preserves the description depth bound through %s",
  (containers) => {
    let value: JsonValue = null;
    for (let depth = 0; depth < 15; depth++)
      value = containers === "objects" ? { child: value } : [value];
    const response = {
      path: "notes.save",
      types: "type Input = unknown;",
      kind: "operation",
      inputSchema: { default: value },
    };
    expect(describeOutputSchema.safeParse(response).success).toBe(true);
    expect(
      describeOutputSchema.safeParse({
        ...response,
        inputSchema: { default: { child: value } },
      }).success,
    ).toBe(false);
  },
);
