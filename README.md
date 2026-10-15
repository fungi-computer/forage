# Forage (`@fungi.computer/forage`)

Forage lists, searches and describes a catalog of operations that a host has
already provided, so a caller or a model can find the right one by name or by
description. It helps a caller discover a capability. It does not execute that
capability or grant permission to use it.

## Install or set up

```sh
npm install @fungi.computer/forage
```

The package ships ESM only and depends on Zod, YAML, JSON Schema Ref Parser and
[App Release](../puffball/README.md) at runtime. Each operation's input and
output is any schema that implements Standard JSON Schema, such as a Zod 4
schema; Forage only renders the JSON Schema it describes. Its discovery
entrypoint is `@fungi.computer/forage`; host-only OpenAPI intake is
`@fungi.computer/forage/openapi`. The pure JSON-Schema subset decoder is
`@fungi.computer/forage/json-schema-subset`: `jsonSchemaSubset()` validates
remote schemas before the shared `jsonSchemaToZod` compiler reads them. The
subset rejects references, regular-expression constraints and reserved property
names anywhere in the schema or JSON values. The decoder refuses depth over 32
and more than 50,000 expanded nodes before recursive decoding; callers bound
transport bytes separately.

## Quick start

This illustrative example creates an immutable catalog, searches it, and
describes one operation:

```ts
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
const firstPage = catalog.list({ limit: 25 });
```

The catalog tests exercise creation, search, description, and stable stamps in
[`test/catalog.test.ts`](test/catalog.test.ts).

## Core concepts

A catalog has a caller-supplied revision and a set of operations. Each operation
has a unique dotted path, an input schema, and optional description, capability
notes, instructions, and output schema. Forage validates the catalog, orders its
operations deterministically, and prepares descriptions once when the catalog is
created. To change the catalog, create a new revision instead of mutating the
existing one.

`search` ranks matching operations. `describe` returns a bounded TypeScript
description for one operation or a namespace. Operation descriptions also
include `inputSchema`, projected from the same validator through Standard JSON
Schema, so callers can see length, range and array bounds that TypeScript cannot
express. Paths may have any namespace depth; descriptions declare a callable
nested `env` with the operation's input and output types. Generated type aliases
separate every path segment with `$`: `computer.echo` declares
`computer$echo_Input` and `computer$echo_Output`, and the nested
`computers.local.files.read` declares `computers$local$files$read_Input` and
`computers$local$files$read_Output`. This keeps paths with underscores distinct
from nested paths. The same rule applies at every depth. `stamp()` returns a
stable identity for the sorted catalog metadata, including schema projections,
capability notes and instructions.

## Exhaustive listing

`forage.list({limit?, cursor?, namespace?})` (or `catalog.list` directly)
enumerates every registered operation exactly once. Ordering is by namespace
(the first path segment), then full operation path, compared by UTF-16 code
units, not locale. Registration order never changes it. Equivalent operations
are not merged into peers, unlike search.

Each page has `results`, `total`, `catalogStamp` and `nextCursor`. Results use
the same summary schema as search (path, description, sample and capability
notes); score is zero because listing does not rank matches. The default and
maximum limit is 50; the minimum is 1. Follow `nextCursor` until it is null.
Total counts all operations under the selected namespace, including its nested
namespaces, not just this page. For example, `namespace: "apps.bazaar"` also
selects `apps.bazaar.windows.open`. An absent namespace means every namespace;
an unknown namespace returns an empty page with total zero.

Cursors are opaque to callers and belong to one catalog stamp and namespace
filter. Reusing a cursor after either changes fails explicitly. Begin a fresh
listing instead. A host that narrows a guest's bound operations filters the
existing summaries and uses the same `listOperations` owner before paging. It
does not introduce another registry or leak unbound paths. Search and describe
keep their existing contracts.

## OpenAPI intake

Import `normalizeOpenApi` and `parseOpenApiTable` from
`@fungi.computer/forage/openapi` on the host. This entrypoint uses the
Node-oriented reference resolver; neutral Worker/guest discovery consumers use
the core entrypoint without importing intake.

`normalizeOpenApi(specText, {authParameter?})` accepts owner-supplied OpenAPI
3.0/3.1 JSON or YAML. It returns server and authentication hints plus supported
operations and explicit unsupported-operation reasons. It performs no fetch,
credential access or execution. Swagger 2 must be converted first.

Intake is bounded to 2 MiB, depth 32, 50,000 nodes and 500 operations. YAML
aliases and external references are refused. Local references are resolved by
JSON Schema Ref Parser with file and HTTP resolvers disabled; recursive schemas
are unsupported. The expansion budget counts every shared-reference occurrence
before recursive schema decoding or compilation. Input and declared JSON success
schemas use the same `jsonSchemaToZod` compiler as App methods. Schemas with
constraints the supported compiler subset cannot preserve are unsupported,
rather than widened.

Operations expose scalar path/query/header parameters with default OpenAPI
serialization and an optional JSON `body`. Other serialization styles, body
media, referenced Path Items and TRACE are unsupported. Required path parameters
must match the path. Reserved transport headers, declared API-key parameters and
an owner-provided `authParameter` cannot become guest input. GET/HEAD/OPTIONS
are reads; other supported methods are writes. Sanitized method names are unique
and reserve `describe`, `search`, `then` and JavaScript object member names.
Paths cannot change the origin, traverse dot segments or contain query/fragment
syntax or encoded separators. Header names follow RFC token grammar and exclude
transport, forwarding, credential and method-override headers. Prototype names
are refused before decoding. Regex keywords (`pattern`, `patternProperties`) and
all `format` constraints are unsupported. OpenAPI 3.0 `nullable` is supported;
OpenAPI 3.1 must use null types instead. Unknown schema keywords are refused.

Provider-authored descriptions/schema annotations are bounded to 2,048
characters, titles to 200, and tags to 16 entries of 64 characters each.
Operations mark their text as `third_party`; hosts must frame it as data. Server
hints require HTTPS without userinfo; relative hints remain relative to the
retrieved spec. Hints confer no network admission and do not select a credential
destination: that belongs to the private Veil execution door.

`parseOpenApiTable(selectedOperations)` decodes 1–64 supported methods before
storage, rejects duplicate names and tables above 512 KiB, and returns a stable
SHA-256 digest. It stores normalized schemas and call shapes, never raw specs or
credentials. A compiler result with no declared output constraint still needs
the execution owner's bounded JSON output decoder. Neither intake nor table
validation grants execution permission or validates a server's network
admission. A connector owner selects from its server-built preview by HTTP
method + path, never client-supplied operation bodies or generated method names;
collision suffixes can change when the spec changes.

The pure intake and selected-table laws are exercised in
[`test/openapi.test.ts`](test/openapi.test.ts).

## API reference

### App backend methods

`appApiOperations(bindingName, api)` projects a decoded App Release API into
operations such as `PRINTS.generate`, called as `env.PRINTS.generate()`; a
dotted method `desktop.arrange` is `env.TOURTOIS.desktop.arrange()`. The App
author generates that API through Agar during the build; Forage uses the same
declaration instead of a second method list. The host supplies the
installation's binding name and can project the same API under an explicit role
alias.

`appMethodSchemas(api)` supplies the same converted input and output schemas,
with the declared description, effect and requirements, to execution owners.
`appToolSchemas(api)` uses the same converter after excluding methods marked
`hidden: true`. `appApiOperations` and host Agent/MCP discovery share this
filtered projection. `appMethodSchemas` keeps every declared method for direct
RPC validators. Converting a declaration grants no authority to execute it.

Each visible method is searchable and has input and output types in `describe`.
Describing `PRINTS` returns the callable nested `env` declaration with
asynchronous methods. The projection includes declared effects and capability
requirements as discovery notes. It supplies no execution handler or permission
grant.

The generated-declaration round trip and nested descriptions are exercised by
Hub’s `app-api-discovery` test.

See the generated [Forage API reference](docs/api/README.md). It covers
`Forage.createCatalog`, the `createCatalog` function, operation definitions, and
the search and description result types.

## Examples and checks

The existing catalog suite covers validation, deterministic search and
description, and catalog stamps. Run it with:

```sh
pnpm --filter @fungi.computer/forage test
```

## Limits and errors

Forage is immutable discovery data. It has no executor, credentials,
authorization state, refresh operation, or host client. A result from `search`
or `describe` does not run the operation. An execution owner must make that
decision separately.

Catalogs must contain at least one operation and cannot repeat an operation
path. Forage bounds metadata and rendered descriptions. Invalid or oversized
input throws `ForageError`. The stable stamp identifies the immutable discovery
snapshot, not authority to execute its operations.

## Contribute and license

Forage is MIT licensed. See [`LICENSE`](LICENSE). Its retained source
attribution and notice are in [`THIRD_PARTY_NOTICES`](THIRD_PARTY_NOTICES).

## Dynamic App tool schemas

`appToolFamilySchemas(api, reply)` validates a dynamic listing through its
signed method output, then compiles each row's input and output with the
ordinary App schema decoder. It returns the family name, call method, declared
effect and requirements, plus rows and their validators. An `unindexed` listing
has no tools. App-owned selectors remain row data; the host constructs the
invocation through that App's call owner. The projection supplies no handlers,
binding defaults or authority. SDK modules and labelled MCP tools can consume
the same rows and validators.
