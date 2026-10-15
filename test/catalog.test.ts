import { describe, expect, it } from "vitest";
import ts from "typescript";
import { z } from "zod";
import * as foragePackage from "../src/index.js";
import {
  Forage,
  ForageError,
  createCatalog,
  forageDescribeDefinition,
  forageDescribeInput,
  forageFailureSchema,
  forageSearchDefinition,
  forageSearchInput,
  operationSchema,
} from "../src/index.js";
import type { Operation } from "../src/index.js";

const textInput = () => z.object({ path: z.string() });
const searchOperation = (namespace: string, notes?: string): Operation => {
  const operation: Operation = {
    path: `${namespace}.search_files`,
    description: "Search files for a text pattern",
    input: z.object({ pattern: z.string() }),
  };
  if (notes) operation.capabilityNotes = notes;
  return operation;
};
const files: Operation[] = [
  {
    path: "files.read",
    description: "Read a text file",
    input: textInput(),
    instructions: "Read and write workspace files",
  },
  {
    path: "files.write",
    description: "Write a text file",
    input: z.object({ path: z.string(), content: z.string() }),
  },
];
const searchCatalog = (
  operations: readonly Operation[],
  query: string,
  maxResults = 50,
) =>
  Forage.createCatalog({
    revision: "test",
    operations: [...operations],
  }).search({ query, maxResults });

describe("S1 — capability peer merge", () => {
  it("clusters equivalent operations into one result with peers", () => {
    const result = searchCatalog(
      [
        searchOperation("botanical", "workspace botanical"),
        searchOperation("memory", "workspace memory"),
      ],
      "search files",
    );
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.path).toBe("botanical.search_files");
    expect(result.results[0]?.peers).toEqual([
      { path: "memory.search_files", capabilityNotes: "workspace memory" },
    ]);
  });
  it("keeps the operation with strongest path evidence as survivor", () => {
    const result = searchCatalog(
      [searchOperation("botanical"), searchOperation("memory")],
      "search memory files",
    );
    expect(result.results[0]?.path).toBe("memory.search_files");
  });
  it("does not merge operations with different input schema shapes", () => {
    const result = searchCatalog(
      [
        { ...searchOperation("a"), input: z.object({ first: z.string() }) },
        { ...searchOperation("b"), input: z.object({ second: z.string() }) },
      ],
      "search files",
    );
    expect(result.total).toBe(2);
  });
  it("does not merge operations with different normalized descriptions", () => {
    const result = searchCatalog(
      [
        searchOperation("a"),
        {
          ...searchOperation("b"),
          description: "Search documents for a text pattern",
        },
      ],
      "search files",
    );
    expect(result.total).toBe(2);
  });
  it("peer merge is deterministic across insertion order", () => {
    const first = searchCatalog(
      [searchOperation("a"), searchOperation("b")],
      "search files",
    );
    const second = searchCatalog(
      [searchOperation("b"), searchOperation("a")],
      "search files",
    );
    expect(second).toEqual(first);
  });
});

describe("S2 — morphological stemming", () => {
  it("stem variants are deterministic and suffix-driven", () => {
    const operations = [
      {
        path: "tools.search",
        description: "Search files",
        input: z.object({}),
      },
    ];
    expect(searchCatalog(operations, "searches")).toEqual(
      searchCatalog(operations, "searches"),
    );
    expect(searchCatalog(operations, "searches").results[0]?.path).toBe(
      "tools.search",
    );
  });
  it("inflected searches discover the search operation", () => {
    const result = searchCatalog([searchOperation("tools")], "searches");
    expect(result.results[0]?.path).toBe("tools.search_files");
  });
  it("inflected listing discovers a list operation", () => {
    const result = searchCatalog(
      [
        {
          path: "tools.list_files",
          description: "List files",
          input: z.object({}),
        },
      ],
      "listing",
    );
    expect(result.results[0]?.path).toBe("tools.list_files");
  });
  it("literal matches outrank matches found only through a stem", () => {
    const result = searchCatalog(
      [
        {
          path: "tools.listing",
          description: "Show the listing",
          input: z.object({}),
        },
        {
          path: "tools.listen",
          description: "Listen on a port",
          input: z.object({}),
        },
      ],
      "listing",
    );
    expect(result.results[0]?.path).toBe("tools.listing");
  });
});

describe("S3 — stopword-aware coverage", () => {
  it("stopwords-only queries return an empty bounded envelope", () => {
    const result = searchCatalog(
      [searchOperation("tools")],
      "the a an for to of",
    );
    expect(result.results).toEqual([]);
    expect(result.total).toBe(0);
    expect(result.truncated).toBe(false);
  });
  it("the flagship multi-token discovery query clears the coverage gate", () => {
    const result = searchCatalog(
      [searchOperation("botanical")],
      "find the tool that searches files for a text pattern",
    );
    expect(result.results[0]?.path).toBe("botanical.search_files");
  });
  it("stopwords do not change the effective-token score", () => {
    const plain = searchCatalog([searchOperation("tools")], "files");
    const padded = searchCatalog([searchOperation("tools")], "the files");
    expect(padded.results[0]?.score).toBe(plain.results[0]?.score);
  });
  it("stopwords remain available to the normalized phrase check", () => {
    const result = searchCatalog(
      [
        {
          path: "files.read",
          description: "Read of the file",
          input: textInput(),
        },
      ],
      "read of the file",
    );
    expect(result.results[0]?.path).toBe("files.read");
  });
});

describe("S4 — search envelope", () => {
  it("reports top score, margin, and a numeric stamp with results", () => {
    const result = searchCatalog(files, "read");
    expect(result.topScore).toBe(result.results[0]?.score);
    expect(result.margin).toBe(0);
    expect(result.catalogStamp).toMatch(/^[0-9a-f]{16}$/);
  });
  it("empty results retain topScore and margin zero", () => {
    const result = searchCatalog(files, "xyzzy");
    expect(result.topScore).toBe(0);
    expect(result.margin).toBe(0);
    expect(result.catalogStamp).toMatch(/^[0-9a-f]{16}$/);
  });
  it("reports a zero margin for a single result", () => {
    const result = searchCatalog(files, "read");
    expect(result.results).toHaveLength(1);
    expect(result.margin).toBe(0);
  });
  it("catalog search passes through the complete envelope", () => {
    const result = createCatalog({ revision: "r", operations: files }).search({
      query: "read",
    });
    expect(Object.keys(result).sort()).toEqual([
      "catalogStamp",
      "margin",
      "results",
      "topScore",
      "total",
      "truncated",
    ]);
  });
});

describe("S5 — revision stability", () => {
  it("equal content has one stamp while operation content rotates it", () => {
    const first = createCatalog({ revision: "r", operations: files });
    const equal = createCatalog({
      revision: "r",
      operations: [...files].reverse(),
    });
    const changed = createCatalog({
      revision: "r",
      operations: [
        { path: "files.read", description: "Changed", input: textInput() },
        {
          path: "files.write",
          description: "Write a text file",
          input: z.object({ path: z.string(), content: z.string() }),
        },
      ],
    });
    expect(equal.stamp()).toBe(first.stamp());
    expect(changed.stamp()).not.toBe(first.stamp());
  });
  it("schema, notes, and instructions each rotate the stamp", () => {
    const operation: Operation = {
      path: "files.read",
      description: "Read a file",
      input: z.object({ path: z.string() }),
      output: z.object({ text: z.string() }),
    };
    const stampOf = (changed: Partial<Operation>) =>
      createCatalog({
        revision: "r",
        operations: [{ ...operation, ...changed }],
      }).stamp();
    const stamps = [
      stampOf({}),
      stampOf({ input: z.object({ path: z.number() }) }),
      stampOf({ output: z.object({ text: z.number() }) }),
      stampOf({ capabilityNotes: "Different notes" }),
      stampOf({ instructions: "Different instructions" }),
    ];
    expect(stampOf({ input: z.object({ path: z.string() }) })).toBe(stamps[0]);
    expect(new Set(stamps).size).toBe(stamps.length);
  });
  it("search envelope stamp matches the immutable catalog stamp", () => {
    const catalog = createCatalog({ revision: "r", operations: files });
    expect(catalog.search({ query: "read" }).catalogStamp).toBe(
      catalog.stamp(),
    );
  });
  it("equivalent snapshots produce identical results", () => {
    const first = createCatalog({ revision: "r", operations: files });
    const second = createCatalog({
      revision: "r",
      operations: [...files].reverse(),
    });
    expect(second.search({ query: "read" })).toEqual(
      first.search({ query: "read" }),
    );
  });
  it("schema property insertion order does not change descriptions or samples", () => {
    const create = (input: z.ZodType) =>
      createCatalog({
        revision: "r",
        operations: [{ path: "files.read", description: "Read", input }],
      });
    const first = create(
      z.object({
        beta: z.string().default("b"),
        alpha: z.string().default("a"),
      }),
    );
    const second = create(
      z.object({
        alpha: z.string().default("a"),
        beta: z.string().default("b"),
      }),
    );

    expect(first.describe({ path: "files.read" })).toEqual(
      second.describe({ path: "files.read" }),
    );
    expect(first.search({ query: "read" })).toEqual(
      second.search({ query: "read" }),
    );
  });
  it("operation arrays and catalog instances are immutable snapshots", () => {
    const input = { revision: "r", operations: [...files] };
    const catalog = createCatalog(input);
    input.operations.reverse();
    expect(Object.isFrozen(catalog)).toBe(true);
    expect(catalog.search({ query: "read" }).results[0]?.path).toBe(
      "files.read",
    );
    expect(Object.keys(catalog).sort()).toEqual([
      "describe",
      "list",
      "revision",
      "search",
      "stamp",
    ]);
    expect("operations" in catalog).toBe(false);
  });
  it("search results do not expose mutable catalog sample state", () => {
    const catalog = createCatalog({
      revision: "r",
      operations: [
        {
          path: "files.read",
          input: z.object({ path: z.string().default("original.txt") }),
        },
      ],
    });
    const first = catalog.search({ query: "read" }).results[0]?.sample;
    expect(first).toEqual({ path: "original.txt" });
    if (!first) throw new Error("Expected a derived sample");
    first.path = "mutated.txt";
    expect(catalog.search({ query: "read" }).results[0]?.sample).toEqual({
      path: "original.txt",
    });
  });
  it("same bounded input has the same stamp on repeated calls", () => {
    const catalog = createCatalog({ revision: "r", operations: files });
    expect(catalog.stamp()).toBe(catalog.stamp());
  });
});

describe("S6 — description index and pagination", () => {
  it("default module description renders all complete operation declarations", () => {
    const output = createCatalog({ revision: "r", operations: files }).describe(
      { path: "files" },
    );
    expect(output.types).toContain("export type files$read_Input");
    expect(output.types).toContain("export type files$write_Input");
  });
  it("index detail renders one-line signatures", () => {
    const output = createCatalog({ revision: "r", operations: files }).describe(
      { path: "files", detail: "index" },
    );
    expect(output.types).toContain('"read"');
    expect(output.types).not.toContain("export type");
  });
  it("index and full descriptions are syntactically valid TypeScript", () => {
    const catalog = createCatalog({ revision: "r", operations: files });
    for (const detail of ["index", "full"] as const) {
      const output = catalog.describe({ path: "files", detail });
      const result = ts.transpileModule(output.types, {
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2022,
        },
        reportDiagnostics: true,
      });
      expect(result.diagnostics ?? [], detail).toEqual([]);
    }
  });
  it("method pagination renders whole selected methods", () => {
    const output = createCatalog({ revision: "r", operations: files }).describe(
      { path: "files", methods: ["write"] },
    );
    expect(output.types).toContain("files$write_Input");
    expect(output.types).not.toContain("files$read_Input");
  });
  it("unknown pagination methods fall back to the complete index", () => {
    const output = createCatalog({ revision: "r", operations: files }).describe(
      { path: "files", methods: ["missing"] },
    );
    expect(output.types).toContain('"read"');
    expect(output.types).toContain('"write"');
  });
  it("operation descriptions ignore module pagination options", () => {
    const output = createCatalog({ revision: "r", operations: files }).describe(
      { path: "files.read", detail: "index", methods: ["missing"] },
    );
    expect(output.kind).toBe("operation");
    expect(output.usage).toBe("await env.files.read({ ... })");
  });
  it("operation descriptions render valid TypeScript declarations", () => {
    const output = createCatalog({ revision: "r", operations: files }).describe(
      { path: "files.read" },
    );
    expect(output.types).toContain("export type files$read_Input =");
    expect(output.types).toContain("export type files$read_Output =");
    expect(output.types).toContain("export declare const env");
    expect(output.types).toMatch(/;\nexport declare const env:/);
  });
  it("renders tuple and record value types from their Zod schemas", () => {
    const output = createCatalog({
      revision: "r",
      operations: [
        {
          path: "files.inspect",
          input: z.object({
            coordinates: z.tuple([z.number(), z.string()]),
            labels: z.record(z.string(), z.number()),
            values: z.array(z.union([z.string(), z.number()])),
          }),
        },
      ],
    }).describe({ path: "files.inspect" });

    expect(output.types).toContain("coordinates: [number, string]");
    expect(output.types).toContain("labels: Record<string, number>");
    expect(output.types).toContain("values: (string | number)[]");
  });
});

describe("S7 — match provenance", () => {
  it("exact method hits report method provenance", () => {
    expect(searchCatalog(files, "read").results[0]?.matchReason).toContain(
      "method:",
    );
  });
  it("description-only hits report description provenance", () => {
    const result = searchCatalog(
      [
        {
          path: "files.open",
          description: "Read a text file",
          input: textInput(),
        },
      ],
      "text",
    );
    expect(result.results[0]?.matchReason).toContain("description:");
  });
  it("weak substring matches remain attributable", () => {
    const result = searchCatalog(
      [{ path: "files.open", description: "Handle text", input: textInput() }],
      "ext",
    );
    expect(result.results[0]?.matchReason).toContain("description:");
  });
  it("every ranked result carries a non-empty reason", () => {
    expect(
      searchCatalog(files, "file").results.every((entry) =>
        Boolean(entry.matchReason),
      ),
    ).toBe(true);
  });
});

describe("S8 — schema-derived samples and usage", () => {
  it("sample values come from schema examples", () => {
    const result = searchCatalog(
      [
        {
          path: "files.read",
          description: "Read",
          input: z.object({
            path: z.string().meta({ examples: ["notes.txt"] }),
          }),
        },
      ],
      "read",
    );
    expect(result.results[0]?.sample).toEqual({ path: "notes.txt" });
  });
  it("examples take precedence over defaults", () => {
    const result = searchCatalog(
      [
        {
          path: "files.read",
          description: "Read",
          input: z.object({
            path: z
              .string()
              .default("default.txt")
              .meta({ examples: ["example.txt"] }),
          }),
        },
      ],
      "read",
    );
    expect(result.results[0]?.sample).toEqual({ path: "example.txt" });
  });
  it("sample falls back to a schema default", () => {
    const result = searchCatalog(
      [
        {
          path: "files.read",
          description: "Read",
          input: z.object({ path: z.string().default("default.txt") }),
        },
      ],
      "read",
    );
    expect(result.results[0]?.sample).toEqual({ path: "default.txt" });
  });
  it("operations without examples or defaults omit sample", () => {
    const result = searchCatalog(
      [{ path: "files.read", description: "Read", input: textInput() }],
      "read",
    );
    expect(result.results[0]?.sample).toBeUndefined();
  });
  it("schema changes rotate the derived sample", () => {
    const first = searchCatalog(
      [
        {
          path: "files.read",
          description: "Read",
          input: z.object({ path: z.string().default("a") }),
        },
      ],
      "read",
    );
    const second = searchCatalog(
      [
        {
          path: "files.read",
          description: "Read",
          input: z.object({ path: z.string().default("b") }),
        },
      ],
      "read",
    );
    expect(first.results[0]?.sample).not.toEqual(second.results[0]?.sample);
  });
  it("operation descriptions carry an await usage line", () => {
    const output = createCatalog({ revision: "r", operations: files }).describe(
      { path: "files.read" },
    );
    expect(output.usage).toBe("await env.files.read({ ... })");
  });
});

describe("S9 — namespace instructions", () => {
  it("module descriptions expose namespace instructions", () => {
    expect(
      createCatalog({ revision: "r", operations: files }).describe({
        path: "files",
      }).description,
    ).toBe("Read and write workspace files");
  });
  it("namespaces without instructions omit the description", () => {
    expect(
      createCatalog({ revision: "r", operations: files.slice(1) }).describe({
        path: "files",
      }).description,
    ).toBeUndefined();
  });
});

describe("Forage boundary and structural contracts", () => {
  it("rejects an empty catalog with a typed failure", () => {
    expect(() => createCatalog({ revision: "r", operations: [] })).toThrow(
      ForageError,
    );
  });
  it("rejects duplicate operation paths before installation", () => {
    const duplicate = {
      path: "files.read",
      description: "Read a text file",
      input: textInput(),
    };
    expect(() =>
      createCatalog({ revision: "r", operations: [duplicate, duplicate] }),
    ).toThrow(/Duplicate/);
  });
  it("rejects malformed search input at the Zod boundary", () => {
    const catalog = createCatalog({ revision: "r", operations: files });
    expect(() => catalog.search({ query: "read", maxResults: 0 })).toThrow(
      ForageError,
    );
    expect(() =>
      forageSearchInput.parse({ query: "read", maxResults: 51 }),
    ).toThrow();
  });
  it("rejects unknown targets with a typed failure", () => {
    const catalog = createCatalog({ revision: "r", operations: files });
    expect(() => catalog.describe({ path: "missing" })).toThrow(ForageError);
    expect(() => catalog.describe({ path: "missing" })).toThrow(
      /Unknown target/,
    );
  });
  it("rejects empty description targets with the closed empty-query failure", () => {
    const catalog = createCatalog({ revision: "r", operations: files });
    for (const path of ["", "   "]) {
      try {
        catalog.describe({ path });
        expect.fail("Expected the empty description target to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(ForageError);
        if (!(error instanceof ForageError)) throw error;
        expect(error.code).toBe("empty_query");
      }
    }
  });
  it("bounds search results to the requested maximum", () => {
    const operations = Array.from({ length: 10 }, (_, index) => ({
      path: `tools.read_${String(index)}`,
      description: "Read files",
      input: textInput(),
    }));
    const result = searchCatalog(operations, "read", 3);
    expect(result.results).toHaveLength(3);
    expect(result.total).toBe(10);
    expect(result.truncated).toBe(true);
  });
  it("public search remains capped at the public result bound", () => {
    const operations = Array.from({ length: 60 }, (_, index) => ({
      path: `tools.read_${String(index)}`,
      description: "Read files",
      input: textInput(),
    }));
    const result = searchCatalog(operations, "read", 50);
    expect(result.results).toHaveLength(50);
    expect(result.truncated).toBe(true);
  });
  it("definitions are immutable Zod-backed structures without behavior", () => {
    expect(Object.isFrozen(forageSearchDefinition)).toBe(true);
    expect(Object.isFrozen(forageDescribeDefinition)).toBe(true);
    expect(forageSearchDefinition.path).toBe("forage.search");
    expect(forageDescribeDefinition.path).toBe("forage.describe");
    expect("execute" in forageSearchDefinition).toBe(false);
    expect(
      operationSchema.safeParse({ path: "files.read", input: z.object({}) })
        .success,
    ).toBe(true);
  });
  it("failure values are validated by the exported failure schema", () => {
    const failure = new ForageError("unknown_target", "Unknown target: missing")
      .failure;
    expect(forageFailureSchema.parse(failure)).toEqual(failure);
  });
  it("the convenience namespace exposes the narrow public surface", () => {
    expect(Forage.createCatalog).toBe(createCatalog);
    expect(Forage.forageSearchDefinition).toBe(forageSearchDefinition);
    expect(forageDescribeInput.parse({ path: "files" }).detail).toBe("full");
    expect("Catalog" in foragePackage).toBe(false);
  });
  it("prepares schema descriptions once when the catalog revision is installed", () => {
    let projectionReads = 0;
    const input = z.object({
      path: z.string().meta({
        get description() {
          projectionReads += 1;
          return "A file path";
        },
      }),
    });
    const catalog = createCatalog({
      revision: "r",
      operations: [{ path: "files.read", input }],
    });
    const installedReads = projectionReads;
    expect(installedReads).toBeGreaterThan(0);

    catalog.describe({ path: "files.read" });
    catalog.describe({ path: "files", detail: "index" });

    expect(projectionReads).toBe(installedReads);
  });
  it("rejects an oversized schema projection before installation", () => {
    const input = z.object({
      path: z.string().meta({ description: "x".repeat(21_000) }),
    });
    expect(() =>
      createCatalog({
        revision: "r",
        operations: [{ path: "files.read", input }],
      }),
    ).toThrow(ForageError);
  });
  it("reports unsupported schema projections as typed input failures", () => {
    try {
      createCatalog({
        revision: "r",
        operations: [{ path: "files.read", input: z.bigint() }],
      });
      throw new Error("Expected catalog installation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ForageError);
      if (!(error instanceof ForageError)) throw error;
      expect(error.failure).toEqual({
        code: "invalid_input",
        message: "Schema cannot be projected to JSON Schema",
      });
    }
  });
  it("rejects an oversized output projection before installation", () => {
    const output = z.string().meta({ description: "x".repeat(21_000) });
    expect(() =>
      createCatalog({
        revision: "r",
        operations: [{ path: "files.read", input: textInput(), output }],
      }),
    ).toThrow(ForageError);
  });
  it("rejects too many derived sample entries before installation", () => {
    const fields: Record<string, z.ZodType> = {};
    for (let index = 0; index <= 100; index += 1) {
      fields[`field_${String(index)}`] = z.string().default("x");
    }
    const input = z.object(fields);
    expect(() =>
      createCatalog({
        revision: "r",
        operations: [{ path: "files.read", input }],
      }),
    ).toThrow(ForageError);
  });
  it("rejects an unserializable schema example before installation", () => {
    const input = z.string().meta({ examples: [BigInt(1)] });
    expect(() =>
      createCatalog({
        revision: "r",
        operations: [{ path: "files.read", input }],
      }),
    ).toThrow(ForageError);
  });
  it("rejects a circular schema example before installation", () => {
    type Circular = { self?: Circular };
    const circular: Circular = {};
    circular.self = circular;
    const input = z.object({ value: z.any().meta({ examples: [circular] }) });
    expect(() =>
      createCatalog({
        revision: "r",
        operations: [{ path: "files.read", input }],
      }),
    ).toThrow(ForageError);
  });
  it("rejects namespace description overflow before installation", () => {
    const operations = Array.from({ length: 160 }, (_, index) => ({
      path: `tools.read_${String(index)}`,
      input: z.object({ ["x".repeat(100)]: z.string() }),
    }));
    expect(() => createCatalog({ revision: "r", operations })).toThrow(
      ForageError,
    );
  });
  it("constructs bounded provenance rather than leaking a Zod error", () => {
    const namespaceTerm = "a".repeat(49);
    const firstMethodTerm = "b".repeat(49);
    const secondMethodTerm = "c".repeat(49);
    const terms = [namespaceTerm, firstMethodTerm, secondMethodTerm];
    const query = terms.join(" ");
    const result = searchCatalog(
      [
        {
          path: `x_${namespaceTerm}.x_${firstMethodTerm}_${secondMethodTerm}`,
          description: `x ${query}`,
          input: z.object({}),
        },
      ],
      query,
    );
    expect(result.results[0]?.matchReason?.length).toBeLessThanOrEqual(500);
  });
  it("renders recursive schema references as conservative self-contained types", () => {
    const tree: z.ZodType = z.lazy(() => z.object({ child: tree.optional() }));
    const output = createCatalog({
      revision: "r",
      operations: [{ path: "tools.tree", input: tree }],
    }).describe({ path: "tools.tree" });
    expect(output.types).toContain("unknown");
    expect(output.types).not.toContain("#");
  });
  it("rejects an aggregate projection beyond the catalog budget", () => {
    const operations = Array.from({ length: 1_000 }, (_, index) => ({
      path: `tools.read_${String(index)}`,
      description: "x".repeat(1_000),
      input: textInput(),
    }));
    expect(() => createCatalog({ revision: "r", operations })).toThrow(
      ForageError,
    );
  });
});

it("describes nested callable types without conflating dotted and underscored names", () => {
  const path = "apps.bazaar.windows.panels.delete";
  const catalog = createCatalog({
    revision: "nested",
    operations: [
      {
        path,
        input: z.object({ value: z.string() }),
        output: z.object({ value: z.string() }),
      },
      {
        path: "apps.bazaar.windows_panels_delete",
        input: z.object({ count: z.number() }),
        output: z.number(),
      },
    ],
  });
  const sources = new Map(
    ["index", "full"].map((detail) => {
      const description = catalog.describe({
        path: "apps.bazaar",
        detail: detail === "index" ? "index" : "full",
        methods: ["windows.panels.delete", "windows_panels_delete"],
      });
      return [
        `${detail}.ts`,
        `${description.types}
const reply: Promise<{value: string}> = env.${path}({value: "hello"});
const count: Promise<number> = env.apps.bazaar.windows_panels_delete({count: 1});
env.${path}({value: 1});`,
      ];
    }),
  );
  const options: ts.CompilerOptions = {
    strict: true,
    noEmit: true,
    types: [],
    target: ts.ScriptTarget.ES2022,
  };
  const host = ts.createCompilerHost(options);
  const readSource = host.getSourceFile.bind(host);
  host.getSourceFile = (
    file,
    languageVersion,
    onError,
    shouldCreateNewSourceFile,
  ) => {
    const source = sources.get(file);
    return source === undefined
      ? readSource(file, languageVersion, onError, shouldCreateNewSourceFile)
      : ts.createSourceFile(file, source, languageVersion, true);
  };
  const diagnostics = ts.getPreEmitDiagnostics(
    ts.createProgram([...sources.keys()], options, host),
  );
  expect(
    diagnostics.map((item) => ({ code: item.code, file: item.file?.fileName })),
  ).toEqual([
    { code: 2322, file: "full.ts" },
    { code: 2322, file: "index.ts" },
  ]);
  expect(
    catalog
      .list({ namespace: "apps.bazaar.windows.panels" })
      .results.map((row) => row.path),
  ).toEqual([path]);
  expect(
    catalog
      .search({ query: "delete" })
      .results.some((row) => row.path === path),
  ).toBe(true);
});

it("installs many sibling nested namespaces while retaining each description's bound", () => {
  const operations = Array.from({ length: 60 }, (_, app) =>
    Array.from({ length: 3 }, (_, method) => ({
      path: `apps.app${String(app)}.windows.open${String(method)}`,
      input: z.object({ value: z.string() }),
      output: z.object({ value: z.string() }),
    })),
  ).flat();
  const catalog = createCatalog({ revision: "many-apps", operations });
  expect(catalog.list({ namespace: "apps" }).total).toBe(180);
  expect(catalog.describe({ path: "apps.app17.windows" }).types).toContain(
    '["app17"]',
  );
  expect(() => catalog.describe({ path: "apps" })).toThrow(
    "Description types exceed the bounded output",
  );
});

describe("Standard JSON Schema sources", () => {
  it("refuses an operation schema that cannot describe itself", () => {
    const parsed = foragePackage.operationSchema.safeParse({
      path: "demo.ping",
      input: { "~standard": { validate: () => ({ value: null }) } },
    });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain(
      "Expected a Standard JSON Schema",
    );
  });

  it("expands local $defs and stops at recursion", () => {
    const tree = {
      type: "object",
      properties: { root: { $ref: "#/$defs/Node" } },
      required: ["root"],
      $defs: {
        Node: {
          type: "object",
          properties: {
            name: { type: "string" },
            children: { type: "array", items: { $ref: "#/$defs/Node" } },
          },
          required: ["name", "children"],
        },
      },
    };
    const source: foragePackage.JsonSchemaSource = {
      "~standard": { jsonSchema: { input: () => tree, output: () => tree } },
    };
    const catalog = createCatalog({
      revision: "refs",
      operations: [{ path: "demo.tree", input: source }],
    });
    expect(catalog.describe({ path: "demo.tree" }).types).toContain(
      "root: {\n    children: unknown[];\n    name: string;\n  };",
    );
  });
});

describe("Shared definition expansion", () => {
  it("refuses a schema whose $defs expand without bound", () => {
    // Each level references the next twice: 2^20 expansions if unbounded.
    type Level = Readonly<{
      type: "object" | "string";
      properties?: Readonly<{ a: { $ref: string }; b: { $ref: string } }>;
    }>;
    const levels = new Map<string, Level>([["L20", { type: "string" }]]);
    for (let level = 0; level < 20; level += 1) {
      const next = `#/$defs/L${String(level + 1)}`;
      levels.set(`L${String(level)}`, {
        type: "object",
        properties: { a: { $ref: next }, b: { $ref: next } },
      });
    }
    const $defs = Object.fromEntries(levels);
    const tree = { $ref: "#/$defs/L0", $defs };
    const source: foragePackage.JsonSchemaSource = {
      "~standard": { jsonSchema: { input: () => tree, output: () => tree } },
    };
    expect(() =>
      createCatalog({
        revision: "explosive",
        operations: [{ path: "demo.boom", input: source }],
      }),
    ).toThrow("Schema references expand more than 256 times");
  });
});

it("describes the bounds from the same schema that validates operation input", () => {
  const input = z.strictObject({ header: z.string().min(1).max(12) });
  const catalog = createCatalog({
    revision: "bounded",
    operations: [{ path: "question.ask", input }],
  });
  expect(catalog.describe({ path: "question.ask" })).toMatchObject({
    inputSchema: {
      type: "object",
      properties: { header: { type: "string", minLength: 1, maxLength: 12 } },
    },
  });
  expect(input.safeParse({ header: "123456789012" }).success).toBe(true);
  expect(input.safeParse({ header: "1234567890123" }).success).toBe(false);
});

it("omits hidden App operations from discovery while retaining direct RPC validators", () => {
  const method = {
    description: "Read data",
    effect: "read" as const,
    requires: [],
    input: {
      type: "object",
      properties: { cursor: { type: "string" } },
      required: ["cursor"],
      additionalProperties: false,
    },
    output: { type: "string" },
  };
  const api = {
    methods: {
      read: method,
      rebuildCopies: { ...method, hidden: true as const },
    },
  };
  expect(
    foragePackage.appApiOperations("APP", api).map(({ path }) => path),
  ).toEqual(["APP.read"]);
  const direct = foragePackage.appMethodSchemas(api).rebuildCopies;
  if (!direct) throw new Error("Hidden direct method was removed");
  expect(direct.input.parse({ cursor: "saved" })).toEqual({ cursor: "saved" });
  expect(direct.output.parse("rebuilt")).toBe("rebuilt");
  expect(direct.input.safeParse({ cursor: 1 }).success).toBe(false);
});

it("describes a bounded App schema without adding JSON-validation nesting", () => {
  let nested: z.ZodType = z.string();
  for (let index = 0; index < 7; index++)
    nested = z.strictObject({ value: nested });
  const declared = z.toJSONSchema(nested);
  const methods = foragePackage.appMethodSchemas({
    methods: {
      read: {
        description: "Read nested JSON",
        effect: "read",
        requires: [],
        input: declared,
        output: declared,
      },
    },
  });
  const method = methods.read;
  if (!method) throw new Error("Missing method");
  const catalog = createCatalog({
    revision: "nested-app",
    operations: [
      {
        path: "app.read",
        input: method.input,
        output: method.output,
      },
    ],
  });
  expect(catalog.describe({ path: "app.read" }).types).toContain("string");
  let valid: z.output<z.ZodJSONSchema> = "text";
  for (let index = 0; index < 7; index++) valid = { value: valid };
  expect(method.input.parse(valid)).toEqual(valid);
  expect(method.output.parse(valid)).toEqual(valid);
  expect(method.output.safeParse({ value: "too shallow" }).success).toBe(false);
});

it("retains JSON-only App validation through parse and Standard Schema", async () => {
  const method = foragePackage.appMethodSchemas({
    methods: {
      read: {
        description: "Read JSON",
        effect: "read",
        requires: [],
        input: {},
        output: {},
      },
    },
  }).read;
  if (!method) throw new Error("Missing method");
  for (const schema of [method.input, method.output]) {
    expect(schema.parse({ value: [null, true, 1, "text"] })).toEqual({
      value: [null, true, 1, "text"],
    });
    for (const invalid of [
      undefined,
      { value: undefined },
      new Date(),
      Number.NaN,
    ]) {
      expect(schema.safeParse(invalid).success).toBe(false);
      expect(
        (await schema["~standard"].validate(invalid)).issues,
      ).toBeDefined();
    }
  }
});

it("describes published family rows using the signed listing and authored input schema", () => {
  const tool = {
    workflowId: "storyboard",
    tool: "storyboard",
    title: "Storyboard",
    description: "Draw the supplied beats",
    version: 1,
    commit: "a".repeat(40),
    input: {
      type: "object",
      properties: {
        beats: { type: "array", items: { type: "string" }, minItems: 1 },
      },
      required: ["beats"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      properties: { runId: { type: "string" } },
      required: ["runId"],
    },
    // Opaque to this test's own host: the App's own extra call arguments.
    call: { workflowId: "storyboard", version: 1, bindings: {} },
  };
  const listingSchema = z.union([
    z.strictObject({ kind: z.literal("unindexed") }),
    z.strictObject({
      kind: z.literal("ready"),
      tools: z.array(
        z.strictObject({
          workflowId: z.string(),
          tool: z.string(),
          title: z.string(),
          description: z.string(),
          version: z.number().int().positive(),
          commit: z.string(),
          input: z.record(z.string(), z.json()),
          output: z.record(z.string(), z.json()),
          call: z.record(z.string(), z.json()),
        }),
      ),
    }),
  ]);
  const api = {
    toolFamily: { name: "flows", list: "list", call: "run" },
    methods: {
      list: {
        description: "List tools",
        hidden: true as const,
        effect: "read" as const,
        requires: [],
        input: { type: "object" },
        output: z.toJSONSchema(listingSchema),
      },
      run: {
        description: "Run",
        effect: "write" as const,
        requires: [],
        input: { type: "object" },
        output: { type: "object" },
      },
    },
  };
  const family = foragePackage.appToolFamilySchemas(api, {
    kind: "ready",
    tools: [tool],
  });
  expect(family?.name).toBe("flows");
  expect(family?.call).toBe("run");
  const operation = family?.tools[0];
  expect(operation?.row).toEqual(tool);
  expect(
    operation?.input.safeParse({ beats: ["A quiet garden"] }).success,
  ).toBe(true);
  expect(operation?.input.safeParse({ beats: 42 }).success).toBe(false);
  if (!operation) throw new Error("Published tool missing");
  const catalog = createCatalog({
    revision: "published-v1",
    operations: [
      {
        path: `env.WORKFLOWS.${family.name}.${operation.row.tool}`,
        description: operation.description,
        input: operation.input,
        output: operation.output,
      },
    ],
  });
  expect(
    catalog.describe({ path: "env.WORKFLOWS.flows.storyboard" }).types,
  ).toContain("beats: string[]");
  expect(
    foragePackage.appToolFamilySchemas(api, { kind: "unindexed" })?.tools,
  ).toEqual([]);
  expect(() =>
    foragePackage.appToolFamilySchemas(api, {
      kind: "ready",
      tools: [{ ...tool, version: 0 }],
    }),
  ).toThrow();
  expect(() =>
    foragePackage.appToolFamilySchemas(api, {
      kind: "ready",
      tools: [tool, tool],
    }),
  ).toThrow();
  expect(
    foragePackage.appToolFamilySchemas(
      { methods: api.methods },
      { kind: "unindexed" },
    ),
  ).toBeNull();
});

it("describes a dotted App method as a nested env call", () => {
  const method = {
    description: "List repositories",
    effect: "read" as const,
    requires: [],
    input: { type: "object", properties: {}, additionalProperties: false },
    output: { type: "array", items: { type: "string" } },
  };
  const catalog = createCatalog({
    revision: "dotted-app",
    operations: [
      ...foragePackage.appApiOperations("BONSAI", {
        methods: { "repos.list": method },
      }),
    ],
  });
  expect(catalog.describe({ path: "BONSAI.repos.list" }).usage).toBe(
    "await env.BONSAI.repos.list({ ... })",
  );
  const { types } = catalog.describe({ path: "BONSAI" });
  expect(types).toContain('["repos"]: { ["list"]:');
  expect(types).not.toContain('"repos.list"');
});

describe("schema projection reuse", () => {
  it("projects each schema once across catalog revisions over the same schemas", () => {
    const schema = z.object({
      path: z.string(),
      nested: z.object({ depth: z.array(z.object({ leaf: z.number() })) }),
    });
    const projected = { input: 0, output: 0 };
    const counted: Operation["input"] = {
      "~standard": {
        jsonSchema: {
          input: (options) => {
            projected.input += 1;
            return schema["~standard"].jsonSchema.input(options);
          },
          output: (options) => {
            projected.output += 1;
            return schema["~standard"].jsonSchema.output(options);
          },
        },
      },
    };
    const operations: Operation[] = [
      { path: "files.inspect", input: counted, output: counted },
    ];
    const first = createCatalog({ revision: "first", operations });
    const second = createCatalog({ revision: "second", operations });
    expect(projected).toEqual({ input: 1, output: 1 });
    expect(second.stamp()).toBe(first.stamp());
    const described = second.describe({ path: "files.inspect" });
    expect(described).toEqual(first.describe({ path: "files.inspect" }));
  });
});
