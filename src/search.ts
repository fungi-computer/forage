import {
  searchOutputSchema,
  type Operation,
  type SearchOutput,
  type SearchResult,
} from "./schemas.js";
import {
  canonicalStringify,
  compareCodeUnits,
  hashString64,
  isStopword,
  normalizeQuery,
  operationMethod,
  operationNamespace,
  stemVariants,
  tokenize,
} from "./normalization.js";
import {
  deriveSample,
  inputSchemaProjection,
  renderOperation,
  schemaFingerprint,
  type RenderedOperation,
} from "./rendering.js";
import type { JsonValue } from "./normalization.js";
import { ForageError } from "./errors.js";

type MatchLevel =
  | "exact"
  | "startsWith"
  | "phrase"
  | "token"
  | "prefix"
  | "substring"
  | "includes"
  | "none";

type ScoredField = {
  level: MatchLevel;
  score: number;
  matchedTokens: string[];
};

type Candidate = {
  result: SearchResult;
  cluster: string;
  pathScore: number;
};

/** Private installation-time projection used by the pure ranking function. */
export type PreparedOperation = Operation & {
  readonly fingerprint: string;
  readonly inputSchema: JsonValue;
  readonly sample: Record<string, JsonValue> | undefined;
  readonly rendered: RenderedOperation;
};

/** Prepare schema-derived search metadata once for an immutable catalog revision. */
export function prepareOperation(operation: Operation): PreparedOperation {
  return Object.freeze({
    ...operation,
    fingerprint: schemaFingerprint(operation.input),
    inputSchema: inputSchemaProjection(operation.input),
    sample: deriveSample(operation.input),
    rendered: renderOperation(operation),
  });
}

const matchWeight = {
  exact: 14,
  startsWith: 9,
  phrase: 6,
  token: 4,
  prefix: 2,
  substring: 2,
  includes: 1,
} satisfies Record<Exclude<MatchLevel, "none">, number>;

function fieldWeight(field: string): number {
  switch (field) {
    case "path":
      return 12;
    case "namespace":
      return 8;
    case "method":
      return 10;
    case "description":
      return 5;
    default:
      return 5;
  }
}

/** Identify every model-visible part of the catalog, including schemas. */
function catalogStamp(operations: readonly PreparedOperation[]): string {
  const lines = [...operations]
    .sort((left, right) => compareCodeUnits(left.path, right.path))
    .map((operation) =>
      canonicalStringify([
        operation.path,
        operation.description ?? null,
        operation.capabilityNotes ?? null,
        operation.instructions ?? null,
        operation.fingerprint,
        operation.output === undefined
          ? null
          : schemaFingerprint(operation.output, "output"),
      ]),
    );
  return hashString64(lines.join("\n"));
}

function scoreLevel(value: string, term: string): MatchLevel {
  if (value === term) return "exact";
  if (value.startsWith(term)) return "startsWith";
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (new RegExp(`\\b${escaped}\\b`).test(value)) return "phrase";
  const parts = tokenize(value);
  if (parts.some((part) => part === term)) return "token";
  if (parts.some((part) => part.startsWith(term))) return "prefix";
  if (parts.some((part) => part.includes(term))) return "substring";
  if (value.includes(term)) return "includes";
  return "none";
}

function scoreField(
  rawValue: string,
  field: string,
  queryTokens: readonly string[],
): ScoredField {
  const value = normalizeQuery(rawValue);
  let bestLevel: MatchLevel = "none";
  let bestScore = 0;
  let matchedTokens: string[] = [];
  for (const token of queryTokens) {
    const terms = [token, ...stemVariants(token)];
    let selected: MatchLevel = "none";
    for (const term of terms) {
      const level = scoreLevel(value, term);
      if (level !== "none") {
        selected = level;
        break;
      }
    }
    if (selected === "none") continue;
    const score = matchWeight[selected] * fieldWeight(field);
    if (score > bestScore) {
      bestLevel = selected;
      bestScore = score;
      matchedTokens = [token];
    } else if (score === bestScore && !matchedTokens.includes(token)) {
      matchedTokens.push(token);
    }
  }
  return { level: bestLevel, score: bestScore, matchedTokens };
}

function tokenMatches(value: string, token: string): boolean {
  const normalized = normalizeQuery(value);
  return [token, ...stemVariants(token)].some((term) =>
    normalized.includes(term),
  );
}

function matchReason(
  fields: readonly [string, ScoredField][],
): string | undefined {
  const parts: string[] = [];
  for (const [field, scored] of fields) {
    if (scored.level === "none") continue;
    const tokens = scored.matchedTokens
      .slice(0, 4)
      .map((token) => token.slice(0, 20));
    parts.push(`${field}:${scored.level}(${tokens.join(" ")})`);
  }
  return parts.length > 0 ? parts.join("; ") : undefined;
}

function checkedSearchOutput(output: SearchOutput): SearchOutput {
  const parsed = searchOutputSchema.safeParse(output);
  if (!parsed.success) {
    throw new ForageError("invalid_input", "Search output exceeded its bounds");
  }
  return parsed.data;
}

function clusterKey(operation: PreparedOperation): string {
  return [
    operationMethod(operation.path),
    (operation.description ?? "").trim().toLowerCase().replace(/\s+/g, " "),
    operation.fingerprint,
  ].join("\u0000");
}

function emptyResult(stamp: string): SearchOutput {
  return checkedSearchOutput({
    results: [],
    total: 0,
    truncated: false,
    topScore: 0,
    margin: 0,
    catalogStamp: stamp,
  });
}

function scoreCandidate(
  operation: PreparedOperation,
  normalizedQuery: string,
  queryTokens: readonly string[],
  coverageTokens: readonly string[],
  threshold: number,
): Candidate | undefined {
  const namespace = operationNamespace(operation.path);
  const method = operationMethod(operation.path);
  const description = operation.description ?? "";
  const fields = [operation.path, namespace, method, description];
  const pathScore = scoreField(operation.path, "path", queryTokens);
  const namespaceScore = scoreField(namespace, "namespace", queryTokens);
  const methodScore = scoreField(method, "method", queryTokens);
  const descriptionScore = scoreField(description, "description", queryTokens);
  const matched = coverageTokens.filter((token) =>
    fields.some((field) => tokenMatches(field, token)),
  ).length;
  const coverage = matched / coverageTokens.length;
  const phraseMatch = normalizeQuery(
    `${operation.path} ${description}`,
  ).includes(normalizedQuery);
  if (coverage < threshold && !phraseMatch) return undefined;

  const baseScore = Math.max(
    pathScore.score,
    namespaceScore.score,
    methodScore.score,
    descriptionScore.score,
  );
  if (baseScore === 0) return undefined;
  let bonus = matched === coverageTokens.length ? 25 : coverage * 10;
  const firstToken = coverageTokens[0];
  if (firstToken && fields.some((field) => tokenMatches(field, firstToken))) {
    bonus += 8;
  }
  if (pathScore.level === "exact" || methodScore.level === "exact") bonus += 20;

  const result: SearchResult = {
    path: operation.path,
    score: baseScore + bonus,
  };
  if (description) result.description = description;
  const reason = matchReason([
    ["method", methodScore],
    ["description", descriptionScore],
    ["path", pathScore],
    ["namespace", namespaceScore],
  ]);
  if (reason) result.matchReason = reason;
  if (operation.sample) result.sample = operation.sample;
  if (operation.capabilityNotes)
    result.capabilityNotes = operation.capabilityNotes;

  return {
    result,
    cluster: clusterKey(operation),
    pathScore: pathScore.score,
  };
}

function mergeCandidateClusters(
  candidates: readonly Candidate[],
): SearchResult[] {
  const grouped = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const group = grouped.get(candidate.cluster) ?? [];
    group.push(candidate);
    grouped.set(candidate.cluster, group);
  }

  const merged: SearchResult[] = [];
  for (const group of grouped.values()) {
    const sorted = [...group].sort(
      (left, right) =>
        right.pathScore - left.pathScore ||
        right.result.score - left.result.score ||
        compareCodeUnits(left.result.path, right.result.path),
    );
    const survivor = sorted[0];
    if (!survivor) continue;
    const peers: NonNullable<SearchResult["peers"]> = [];
    const peerCandidates = sorted
      .slice(1)
      .sort((left, right) =>
        compareCodeUnits(left.result.path, right.result.path),
      );
    for (const candidate of peerCandidates) {
      const peer: NonNullable<SearchResult["peers"]>[number] = {
        path: candidate.result.path,
      };
      if (candidate.result.capabilityNotes) {
        peer.capabilityNotes = candidate.result.capabilityNotes;
      }
      peers.push(peer);
    }
    const mergedResult: SearchResult = {
      ...survivor.result,
      score: Math.max(...sorted.map((candidate) => candidate.result.score)),
    };
    if (peers.length > 0) mergedResult.peers = peers;
    merged.push(mergedResult);
  }
  return merged.sort(
    (left, right) =>
      right.score - left.score || compareCodeUnits(left.path, right.path),
  );
}

function checkedRankedOutput(
  merged: readonly SearchResult[],
  resultLimit: number,
  stamp: string,
): SearchOutput {
  const bounded = merged.slice(0, resultLimit);
  const top = bounded[0];
  const second = bounded[1];
  return checkedSearchOutput({
    results: bounded,
    total: merged.length,
    truncated: merged.length > resultLimit,
    topScore: top?.score ?? 0,
    margin: top && second ? top.score - second.score : 0,
    catalogStamp: stamp,
  });
}

/** Pure deterministic ranking over one immutable operation snapshot. */
export function searchCatalog(
  operations: readonly PreparedOperation[],
  query: string,
  maxResults = 50,
  stamp: string,
): SearchOutput {
  const resultLimit = Math.min(50, Math.max(1, Math.floor(maxResults)));
  const normalizedQuery = normalizeQuery(query);
  const queryTokens = tokenize(normalizedQuery);
  const coverageTokens = queryTokens.filter((token) => !isStopword(token));
  if (coverageTokens.length === 0) return emptyResult(stamp);

  const threshold = coverageTokens.length <= 2 ? 1 : 0.6;
  const candidates: Candidate[] = [];
  for (const operation of operations) {
    const candidate = scoreCandidate(
      operation,
      normalizedQuery,
      queryTokens,
      coverageTokens,
      threshold,
    );
    if (candidate) candidates.push(candidate);
  }

  return checkedRankedOutput(
    mergeCandidateClusters(candidates),
    resultLimit,
    stamp,
  );
}

export { catalogStamp };
