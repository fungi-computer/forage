import {
  describeOutputSchema,
  forageDescribeInput,
  forageSearchInput,
  searchOutputSchema,
  forageListInput,
  listOutputSchema,
} from "./schemas.js";

/** Structural operation definition consumed by a capability composer. */
export type ForageDefinition = Readonly<{
  /** Pure catalog lookup; the enclosing Mycelium execute program is still unsafe. */
  replay: "safe";
  path: string;
  description: string;
  input:
    | typeof forageSearchInput
    | typeof forageDescribeInput
    | typeof forageListInput;
  output:
    | typeof searchOutputSchema
    | typeof describeOutputSchema
    | typeof listOutputSchema;
}>;

/** The search operation has schema metadata only; it has no host behavior. */
export const forageSearchDefinition: ForageDefinition = Object.freeze({
  replay: "safe",
  path: "forage.search",
  description:
    "Search operation names and descriptions with short keywords, such as read or shell. If no results match, retry with one relevant keyword. Describe known operation paths directly with forage.describe.",
  input: forageSearchInput,
  output: searchOutputSchema,
});

/** The description operation has schema metadata only; it has no host behavior. */
export const forageDescribeDefinition: ForageDefinition = Object.freeze({
  replay: "safe",
  path: "forage.describe",
  description: "Describe a capability",
  input: forageDescribeInput,
  output: describeOutputSchema,
});

/** Pure exhaustive catalog listing; no execution or authority is granted. */
export const forageListDefinition: ForageDefinition = Object.freeze({
  replay: "safe",
  path: "forage.list",
  description:
    "List every available operation in stable namespace then path order (UTF-16 code units). Use limit (1–50) and nextCursor to page without duplicates, optionally filtering by exact namespace. total counts all operations in that filter; summaries match search, with score 0 and no peer merging. A cursor belongs to this catalog and filter; describe paths before calling them.",
  input: forageListInput,
  output: listOutputSchema,
});
