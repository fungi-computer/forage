export {
  catalogInputSchema,
  describeOutputSchema,
  forageDescribeInput,
  forageFailureSchema,
  forageSearchInput,
  operationSchema,
  searchOutputSchema,
  searchResultSchema,
  forageListInput,
  listOutputSchema,
} from "./schemas.js";
export type {
  CatalogInput,
  DescribeOutput,
  ForageDescribeInput,
  ForageFailure,
  ForageSearchInput,
  JsonSchemaSource,
  JsonSchemaTarget,
  Operation,
  SearchOutput,
  SearchResult,
  ForageListInput,
  ListOutput,
} from "./schemas.js";
export type { ForageDefinition } from "./definitions.js";
export { ForageError } from "./errors.js";
export { createCatalog } from "./catalog.js";
export {
  appApiOperations,
  appMethodSchemas,
  appToolSchemas,
  appToolFamilySchemas,
  jsonSchemaToZod,
} from "./app-api.js";
export { listOperations } from "./list.js";
export type { ForageCatalog } from "./catalog.js";
export {
  forageDescribeDefinition,
  forageSearchDefinition,
  forageListDefinition,
} from "./definitions.js";

import { createCatalog } from "./catalog.js";
import {
  forageDescribeDefinition,
  forageSearchDefinition,
  forageListDefinition,
} from "./definitions.js";

/** Public convenience namespace contract. */
export type ForageApi = {
  /** Construct one immutable catalog revision. */
  createCatalog: typeof createCatalog;
  /** Structural search operation definition. */
  forageSearchDefinition: typeof forageSearchDefinition;
  /** Structural description operation definition. */
  forageDescribeDefinition: typeof forageDescribeDefinition;
  /** Structural exhaustive listing definition. */
  forageListDefinition: typeof forageListDefinition;
};

/** Narrow convenience namespace for the package's public seams. */
export const Forage: ForageApi = Object.freeze({
  createCatalog,
  forageSearchDefinition,
  forageDescribeDefinition,
  forageListDefinition,
});

export default Forage;
