import { expect, it } from "vitest";
import { z } from "zod";
import {
  createCatalog,
  ForageError,
  type ForageListInput,
} from "../src/index.js";

const operations = [
  "z.read",
  "aa.read",
  "a_1.read",
  "A.read",
  "a.write",
  "a.read",
].map((path) => ({
  path,
  description: "Same equivalent operation",
  input: z.object({}),
}));

it("pages every registered operation once in stable namespace/path order, including equivalent peers", () => {
  const catalog = createCatalog({ revision: "one", operations });
  const expected = [
    "A.read",
    "a.read",
    "a.write",
    "a_1.read",
    "aa.read",
    "z.read",
  ];
  const paths: string[] = [];
  let cursor: string | undefined;
  do {
    const input: ForageListInput = { limit: 2 };
    if (cursor !== undefined) input.cursor = cursor;
    const page = catalog.list(input);
    expect(page.total).toBe(6);
    expect(
      page.results.every((row) => row.score === 0 && row.peers === undefined),
    ).toBe(true);
    paths.push(...page.results.map((row) => row.path));
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  expect(paths).toEqual(expected);
  expect(new Set(paths).size).toBe(6);
  const reversed = createCatalog({
    revision: "two",
    operations: [...operations].reverse(),
  });
  expect(reversed.list({ limit: 50 })).toEqual(catalog.list({ limit: 50 }));
});

it("paginates larger catalogs with an exact namespace filter and a filtered total", () => {
  const catalog = createCatalog({
    revision: "many",
    operations: Array.from({ length: 130 }, (_, i) => ({
      path:
        (i % 2 === 0 ? "goal" : "loop") + ".op_" + String(i).padStart(3, "0"),
      input: z.object({}),
    })),
  });
  const first = catalog.list({ namespace: "goal", limit: 50 });
  expect(first.total).toBe(65);
  expect(first.results).toHaveLength(50);
  if (first.nextCursor === null) throw new Error("Expected next page");
  const last = catalog.list({ namespace: "goal", cursor: first.nextCursor });
  expect(last.results).toHaveLength(15);
  expect(last.nextCursor).toBeNull();
  expect(
    new Set([...first.results, ...last.results].map((row) => row.path)).size,
  ).toBe(65);
  expect(catalog.list({ namespace: "missing" })).toMatchObject({
    results: [],
    total: 0,
    nextCursor: null,
  });
});

it("refuses malformed, stale and cross-filter cursors rather than silently restarting", () => {
  const catalog = createCatalog({ revision: "one", operations });
  const cursor = catalog.list({ limit: 1 }).nextCursor;
  if (cursor === null) throw new Error("Expected a cursor");
  expect(() => catalog.list({ cursor: "not-json" })).toThrow(ForageError);
  expect(() => catalog.list({ cursor, namespace: "a" })).toThrow(
    /different catalog or namespace/u,
  );
  const changed = createCatalog({
    revision: "changed",
    operations: operations.slice(1),
  });
  expect(() => changed.list({ cursor })).toThrow(
    /different catalog or namespace/u,
  );
  expect(() => catalog.list({ limit: 0 })).toThrow(ForageError);
  expect(() => catalog.list({ limit: 51 })).toThrow(ForageError);
});

it("listing returns independent samples, never mutable catalog state", () => {
  const catalog = createCatalog({
    revision: "one",
    operations: [
      {
        path: "files.read",
        input: z.object({ limit: z.number().default(25) }),
      },
    ],
  });
  const first = catalog.list({});
  const sample = first.results[0]?.sample;
  if (sample === undefined) throw new Error("Expected a sample");
  sample.limit = 99;
  expect(catalog.list({}).results[0]?.sample).toEqual({ limit: 25 });
});
