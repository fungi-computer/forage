import * as z from "zod";

export const schemaDepthLimit = 32;
export const schemaNodeLimit = 50_000;
const unsafePropertyNames = new Set(["__proto__", "constructor", "prototype"]);
export const isUnsafeSchemaPropertyName = (name: string) =>
  unsafePropertyNames.has(name);
export const parameterName = z.lazy(() =>
  z
    .string()
    .min(1)
    .max(128)
    .refine((name) => !unsafePropertyNames.has(name)),
);
export const thirdPartyText = (limit: number) =>
  z.string().max(limit).brand<"ThirdPartyText">();

// Maintained decoding of one container level avoids expanding ref-parser's DAG
// or recursively decoding remote JSON before the domain budget is checked.
export const jsonSchemaContainer = z.lazy(() =>
  z.union([z.array(z.unknown()), z.record(z.string(), z.unknown())]),
);
export function jsonSchemaValueInspection(
  budget: { nodes: number } = { nodes: 0 },
) {
  return z
    .unknown()
    .transform(
      (source): "nodes_limit" | "depth_limit" | "unsafe_name" | null => {
        const pending: { value: unknown; depth: number; field: string }[] = [
          { value: source, depth: 0, field: "" },
        ];
        while (pending.length) {
          const next = pending.pop();
          if (!next) break;
          if (++budget.nodes > schemaNodeLimit) return "nodes_limit";
          if (next.depth > schemaDepthLimit) return "depth_limit";
          const decoded = jsonSchemaContainer.safeParse(next.value);
          if (!decoded.success) {
            if (
              ["name", "required"].includes(next.field) &&
              isUnsafeSchemaPropertyName(
                z.string().safeParse(next.value).data ?? "",
              )
            )
              return "unsafe_name";
            continue;
          }
          // Zod records discard __proto__: inspect the original keys before consuming
          // their decoded children, including keys in const/enum/default/example data.
          if (
            Object.getOwnPropertyNames(next.value).some(
              isUnsafeSchemaPropertyName,
            )
          )
            return "unsafe_name";
          for (const [field, child] of Object.entries(decoded.data)) {
            if (pending.length + budget.nodes >= schemaNodeLimit)
              return "nodes_limit";
            pending.push({
              value: child,
              depth: next.depth + 1,
              field: Array.isArray(decoded.data) ? next.field : field,
            });
          }
        }
        return null;
      },
    );
}
