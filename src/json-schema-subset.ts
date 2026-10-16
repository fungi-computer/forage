import * as z from "zod";

import {
  jsonSchemaValueInspection,
  parameterName,
  thirdPartyText,
} from "./json-schema-boundary.js";

const jsonSchema = z.lazy(() =>
  z.union([z.record(z.string(), z.json()), z.boolean()]),
);
/** Decode the supported schema subset before using the shared Zod compiler.
 * Refuse depth over 32, more than 50,000 expanded nodes and reserved keys
 * before recursive decoding. Callers bound transport bytes separately.
 */
export function jsonSchemaSubset(allowNullable = false) {
  const schema: z.ZodType<z.output<typeof jsonSchema>> = z.lazy(() => {
    const objectSchema = z.strictObject({
      $schema: z.string().optional(),
      title: thirdPartyText(200).optional(),
      description: thirdPartyText(2048).optional(),
      type: z
        .union([
          z.enum([
            "null",
            "boolean",
            "object",
            "array",
            "number",
            "integer",
            "string",
          ]),
          z.array(
            z.enum([
              "null",
              "boolean",
              "object",
              "array",
              "number",
              "integer",
              "string",
            ]),
          ),
        ])
        .optional(),
      enum: z.array(z.json()).min(1).optional(),
      const: z.json().optional(),
      properties: z.record(parameterName, schema).optional(),
      required: z.array(parameterName).optional(),
      additionalProperties: schema.optional(),
      propertyNames: schema.optional(),
      items: schema.optional(),
      prefixItems: z.array(schema).optional(),
      minItems: z.number().int().nonnegative().optional(),
      maxItems: z.number().int().nonnegative().optional(),
      uniqueItems: z.literal(false).optional(),
      minLength: z.number().int().nonnegative().optional(),
      maxLength: z.number().int().nonnegative().optional(),

      minimum: z.number().optional(),
      maximum: z.number().optional(),
      exclusiveMinimum: z.union([z.number(), z.boolean()]).optional(),
      exclusiveMaximum: z.union([z.number(), z.boolean()]).optional(),
      multipleOf: z.number().positive().optional(),
      allOf: z.array(schema).optional(),
      anyOf: z.array(schema).optional(),
      oneOf: z.array(schema).optional(),

      readOnly: z.boolean().optional(),
      writeOnly: z.boolean().optional(),
      default: z.json().optional(),
      example: z.json().optional(),
      examples: z.array(z.json()).optional(),
      deprecated: z.boolean().optional(),
    });
    const versioned = allowNullable
      ? objectSchema.extend({ nullable: z.boolean().optional() })
      : objectSchema;
    return z.union([z.boolean(), versioned]).pipe(jsonSchema);
  });
  return z
    .unknown()
    .superRefine((value, context) => {
      const refusal = jsonSchemaValueInspection().parse(value);
      if (refusal) context.addIssue({ code: "custom", message: refusal });
    })
    .pipe(schema);
}
