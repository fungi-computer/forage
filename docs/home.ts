import { Forage } from "@fungi.computer/forage";
import { z } from "zod";

const catalog = Forage.createCatalog({
  revision: "run-1",
  operations: [
    {
      path: "files.read",
      description: "Read a file",
      input: z.object({ path: z.string() }),
    },
  ],
});
const matches = catalog.search({ query: "read" });
const description = catalog.describe({ path: "files.read" });
console.log(matches.results[0]?.path, description.kind); // "files.read" "operation"
