import { getEmbeddings } from "../index/embed.js";
import { loadTableCatalog, lookupCatalog } from "../index/data/load.js";
import {
  ensureLookupValues,
  matchLookupTerms,
  stemWord,
} from "../index/lookup.js";
import { FEWSHOT_COLLECTION, SCHEMA_COLLECTION } from "../index/qdrant.js";
import { schemaToText } from "../index/schema.js";
import { assertEngineContext, openSourcePool } from "../db/source.js";
import { executeWithRetries } from "./sql.js";

const RETRIEVE_LIMIT = Number(process.env.RETRIEVE_LIMIT || 10);
const FACET_LIMIT = 4;
const FACET_SCORE_FLOOR = 0.55;
const MAX_RETRIEVED = 14;
const FEWSHOT_LIMIT = Number(process.env.FEWSHOT_LIMIT || 4);
const TABLE_CATALOG = loadTableCatalog();

const STOP_WORDS = new Set([
  "the", "and", "for", "with", "from", "that", "this", "these", "those",
  "what", "which", "who", "whose", "how", "many", "much", "show", "list",
  "find", "give", "tell", "get", "count", "are", "was", "were", "have",
  "has", "had", "been", "being", "into", "about", "their", "there", "here",
  "please", "using", "used", "use", "where", "when", "between", "within",
  "each", "over", "under", "after", "before", "during", "than", "then",
  "just", "only", "also", "not", "can", "could", "should", "would",
  "associated", "named", "called", "per", "all", "any", "some", "most",
  "recent", "recently", "current", "supplied", "specified", "linked",
  "link", "does", "did", "its", "our", "your", "you", "will", "onto",
  "via", "across", "among", "every", "such", "like", "who", "whose",
]);

function explainFetch(err, what) {
  const cause = err?.cause;
  if (cause?.code === "ECONNREFUSED") {
    return new Error(`${what} is not running (${cause.address}:${cause.port})`);
  }
  return err;
}

function scopeOf(ctx) {
  return {
    workspaceId: ctx.workspaceId,
    connectionId: ctx.connectionId,
    database: ctx.source.database,
  };
}

function qdrantFilter(ctx) {
  return {
    must: [
      { key: "workspace_id", match: { value: Number(ctx.workspaceId) } },
      { key: "connection_id", match: { value: Number(ctx.connectionId) } },
    ],
  };
}

export function contentTokens(question) {
  const words = question.match(/[A-Za-z0-9]+/g) || [];
  const tokens = [];
  words.forEach((word, index) => {
    const lower = word.toLowerCase();
    if (lower.length < 3 || STOP_WORDS.has(lower)) return;
    const midSentenceName =
      index > 0 &&
      word[0] === word[0].toUpperCase() &&
      word.slice(1) === word.slice(1).toLowerCase();
    if (midSentenceName) return;
    tokens.push(lower);
  });
  return [...new Set(tokens)];
}

function addHit(ordered, name, score, note) {
  const key = String(name || "").toLowerCase();
  if (!key) return;
  let row = ordered.find((item) => item.table_name.toLowerCase() === key);
  if (!row) {
    row = { table_name: name, score: null, note: "" };
    ordered.push(row);
  }
  if (score != null && (row.score == null || score > row.score)) {
    row.score = Number(Number(score).toFixed(4));
  }
  if (note && !row.note.includes(note)) {
    row.note = row.note ? `${row.note}; ${note}` : note;
  }
}

function formatTermLinks(matches, childrenByTable) {
  const groups = new Map();
  for (const match of matches) {
    const key = `${match.token}\n${match.table_name}\n${match.column_name}`;
    if (!groups.has(key)) groups.set(key, new Set());
    groups.get(key).add(match.value);
  }
  if (groups.size === 0) return "";

  const lines = [
    "Term links — these words from the question were found in lookup values. Filter on the matched value.",
  ];
  for (const [key, values] of groups) {
    const [token, table, column] = key.split("\n");
    const shown = [...values].slice(0, 5).map((value) => `"${value}"`).join(", ");
    lines.push(`- "${token}" matches ${table}.${column}: ${shown}`);
    const children = childrenByTable.get(table.toLowerCase()) || [];
    if (children.length) {
      lines.push(
        `  Join ${children.join(", ")} when the question needs records attached to ${table}.`
      );
      const names = children.map((name) => name.toLowerCase());
      const hasEps = names.some((name) => name.includes("eps_"));
      const hasPlain = names.some(
        (name) => name.includes("proposal") && !name.includes("eps_")
      );
      if (hasEps && hasPlain) {
        lines.push(
          "  The question does not choose development versus institutional proposals. Return matching rows from both, using UNION ALL."
        );
      }
    }
  }
  return lines.join("\n");
}

async function tablesReferencing(ctx, tableName) {
  const [rows] = await ctx.catalog.execute(
    `SELECT DISTINCT st.table_name
     FROM schema_columns sc
     JOIN schema_tables st ON st.id = sc.table_id
     WHERE st.workspace_id = ?
       AND st.connection_id = ?
       AND SUBSTRING_INDEX(sc.references_col, '.', 1) = ?`,
    [ctx.workspaceId, ctx.connectionId, tableName]
  );
  return rows.map((row) => row.table_name);
}

function childMatchesQuestion(childName, lookupTable, tokens, matchedToken) {
  const lookupParts = new Set(lookupTable.toLowerCase().split("_").map(stemWord));
  const matchedStem = stemWord(matchedToken);
  const others = tokens
    .map(stemWord)
    .filter((stem) => stem !== matchedStem && !lookupParts.has(stem));
  if (others.length === 0) return true;
  const name = childName.toLowerCase();
  return others.some((stem) => name.includes(stem));
}

async function retrieveTables(ctx, vector, limit = RETRIEVE_LIMIT) {
  let hits;
  try {
    hits = await ctx.qdrant.search(SCHEMA_COLLECTION, {
      vector,
      limit,
      with_payload: true,
      filter: qdrantFilter(ctx),
    });
  } catch (err) {
    throw explainFetch(err, "Qdrant");
  }

  return hits.map((hit) => ({
    table_id: hit.payload.table_id,
    table_name: hit.payload.table_name,
    score: Number(hit.score.toFixed(4)),
  }));
}

async function retrieveFewshots(ctx, vector, limit = FEWSHOT_LIMIT) {
  let hits;
  try {
    hits = await ctx.qdrant.search(FEWSHOT_COLLECTION, {
      vector,
      limit,
      with_payload: true,
      filter: qdrantFilter(ctx),
    });
  } catch (err) {
    throw explainFetch(err, "Qdrant");
  }

  return hits.map((hit) => ({
    question: hit.payload.question,
    sql: hit.payload.sql,
    explanation: hit.payload.explanation,
    score: Number(hit.score.toFixed(4)),
  }));
}

async function retrieveFacets(ctx, question, tokens, log = () => {}) {
  const facets = [{ text: question, limit: RETRIEVE_LIMIT, floor: 0, part: false }];
  if (tokens.length > 1) {
    for (const token of tokens) {
      facets.push({ text: token, limit: FACET_LIMIT, floor: FACET_SCORE_FLOOR, part: true });
    }
  }

  const embedStarted = Date.now();
  log(`embedding ${facets.length} search text${facets.length === 1 ? "" : "s"}`);
  const vectors = await getEmbeddings(facets.map((facet) => facet.text));
  log(`embeddings ready in ${Date.now() - embedStarted} ms`);

  const searchStarted = Date.now();
  log("searching table index");
  const groups = await Promise.all(
    facets.map((facet, index) => retrieveTables(ctx, vectors[index], facet.limit))
  );
  log(`table search done in ${Date.now() - searchStarted} ms`);

  const questionHits = groups[0];
  const facetHits = [];
  const facetHitsByToken = new Map();
  groups.forEach((group, index) => {
    if (!facets[index].part) return;
    const kept = group.filter((hit) => hit.score >= facets[index].floor);
    facetHitsByToken.set(facets[index].text, kept);
    facetHits.push(...kept);
  });
  return { questionHits, facetHits, facetHitsByToken, questionVector: vectors[0] };
}

function isShortLabel(value) {
  const words = String(value).split(/[^A-Za-z0-9]+/).filter(Boolean);
  return words.length > 0 && words.length <= 4;
}

function tableHasStem(tableName, stem) {
  return String(tableName)
    .toLowerCase()
    .split("_")
    .some((part) => stemWord(part) === stem);
}

function chooseLookupMatches(matches, tokens, questionHits, facetHitsByToken) {
  const questionNames = new Set(
    questionHits.map((hit) => hit.table_name.toLowerCase())
  );
  const heads = new Set();
  for (const token of tokens) {
    const hits = facetHitsByToken.get(token) || [];
    if (hits.length === 0) continue;
    const overlap = hits.filter((hit) =>
      questionNames.has(hit.table_name.toLowerCase())
    ).length;
    if (overlap * 2 >= hits.length) heads.add(token);
  }

  const byToken = new Map();
  for (const match of matches) {
    if (!isShortLabel(match.value)) continue;
    if (!byToken.has(match.token)) byToken.set(match.token, []);
    byToken.get(match.token).push(match);
  }

  const chosen = [];
  for (const [token, group] of byToken) {
    if (heads.has(token)) continue;
    const others = tokens.filter((item) => item !== token && !heads.has(item));
    const ranked = group.map((match) => {
      const coversOther = others.some((other) =>
        tableHasStem(match.table_name, stemWord(other))
      );
      return { match, score: coversOther ? 3 : 1 };
    });
    const best = Math.max(...ranked.map((item) => item.score));
    const kept = ranked.filter((item) => item.score === best).map((item) => item.match);
    const tables = new Set(kept.map((item) => item.table_name.toLowerCase()));
    if (best < 3 && tables.size > 8) continue;

    const seen = new Set();
    for (const match of kept) {
      const key = match.table_name.toLowerCase();
      if (!seen.has(key) && seen.size >= 8) continue;
      seen.add(key);
      chosen.push(match);
    }
  }
  return chosen;
}

function preferModuleChildren(question, children) {
  const dev = /\b(proposal[- ]development|eps|development proposal)\b/i.test(question);
  const institutional = /\b(institutional proposal|institute proposal)\b/i.test(question);
  if (dev && !institutional) {
    const eps = children.filter((name) => name.toLowerCase().includes("eps_"));
    if (eps.length) return eps.slice(0, 6);
  }
  if (institutional && !dev) {
    const plain = children.filter((name) => !name.toLowerCase().includes("eps_"));
    if (plain.length) return plain.slice(0, 6);
  }
  return children.slice(0, 6);
}

export async function retrieveContext(question, ctx, log = () => {}) {
  if (!ctx?.qdrant) throw new Error("qdrant client is required.");
  const tokens = contentTokens(question);
  log(`content words: ${tokens.join(", ") || "(none)"}`);
  const scope = scopeOf(ctx);

  const lookupPromise = (async () => {
    const started = Date.now();
    log("matching lookup values");
    const sourcePool = openSourcePool(ctx.source);
    try {
      await ensureLookupValues(ctx.catalog, sourcePool, scope);
      const matches = await matchLookupTerms(ctx.catalog, tokens, scope);
      log(`lookup matches: ${matches.length} in ${Date.now() - started} ms`);
      return matches;
    } finally {
      await sourcePool.end();
    }
  })();

  const [{ questionHits, facetHits, facetHitsByToken, questionVector }, lookupMatches] =
    await Promise.all([
      retrieveFacets(ctx, question, tokens, log),
      lookupPromise,
    ]);
  const selectedMatches = chooseLookupMatches(
    lookupMatches,
    tokens,
    questionHits,
    facetHitsByToken
  );

  const ordered = [];
  const childrenByTable = new Map();
  const lookups = new Map();
  for (const match of selectedMatches) {
    const key = match.table_name.toLowerCase();
    if (!lookups.has(key)) lookups.set(key, []);
    lookups.get(key).push(match);
  }

  for (const [tableKey, matches] of lookups) {
    const tableName = matches[0].table_name;
    const note = matches
      .map((match) => `${match.token} → ${match.value}`)
      .filter((item, index, list) => list.indexOf(item) === index)
      .slice(0, 3)
      .join("; ");
    addHit(ordered, tableName, null, note);

    const children = await tablesReferencing(ctx, tableName);
    const matchedToken = matches[0].token;
    const related = children.filter((name) =>
      childMatchesQuestion(name, tableName, tokens, matchedToken)
    );
    const chosen = preferModuleChildren(question, related);
    childrenByTable.set(tableKey, chosen);
    for (const child of chosen) {
      addHit(ordered, child, null, `joins ${tableName}`);
    }
  }

  for (const hit of facetHits) {
    addHit(ordered, hit.table_name, hit.score, "");
  }
  for (const hit of questionHits) {
    addHit(ordered, hit.table_name, hit.score, "");
  }

  const pinned = ordered.filter((hit) => hit.note);
  const rest = ordered.filter((hit) => !hit.note);
  const tables = [...pinned, ...rest].slice(0, Math.max(MAX_RETRIEVED, pinned.length));
  log(
    `retrieved ${tables.length} tables: ${tables
      .map((hit) => hit.table_name)
      .slice(0, 8)
      .join(", ")}`
  );

  return {
    tokens,
    tables,
    termLinks: formatTermLinks(selectedMatches, childrenByTable),
    questionVector,
  };
}

function seedTables(question) {
  const q = question.toLowerCase();
  const wantsPerson =
    /\b(person|people|pi\b|investigator|named|whose name|associated with)\b/.test(q);
  const isDev = /\b(proposal[- ]development|eps|development proposal)\b/.test(q);
  const isInst = /\b(institutional proposal|institute proposal)\b/.test(q);
  const isProposal = /\bproposals?\b/.test(q);
  const seeds = [];

  if (isDev) {
    seeds.push("eps_proposal");
    if (wantsPerson) seeds.push("eps_proposal_persons");
  } else if (isInst || isProposal) {
    seeds.push("proposal");
    if (wantsPerson) seeds.push("proposal_persons");
  }

  if (/\bawards?\b/.test(q)) {
    seeds.push("award");
    if (wantsPerson) seeds.push("award_persons");
  }
  if (/\bagreements?\b/.test(q)) {
    seeds.push("agreement_header");
    if (wantsPerson) seeds.push("agreement_people");
  }
  return seeds;
}

function tablesFromSql(sql) {
  if (!sql) return [];
  return [...sql.matchAll(/\b(?:from|join)\s+([a-zA-Z_][\w]*)/gi)].map(
    (match) => match[1]
  );
}

function mergeTableNames(preferred, extra) {
  const seen = new Set();
  const out = [];
  for (const name of [...preferred, ...extra]) {
    const key = String(name).toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

async function expandReferencedTables(ctx, tableNames) {
  const names = mergeTableNames(tableNames, []);
  if (names.length === 0) return names;

  const expanded = new Set(names.map((name) => String(name)));
  const placeholders = names.map(() => "?").join(",");
  const [rows] = await ctx.catalog.execute(
    `SELECT DISTINCT sc.references_col
     FROM schema_tables st
     JOIN schema_columns sc ON sc.table_id = st.id
     WHERE st.workspace_id = ?
       AND st.connection_id = ?
       AND st.table_name IN (${placeholders})
       AND sc.references_col IS NOT NULL`,
    [ctx.workspaceId, ctx.connectionId, ...names]
  );

  for (const row of rows) {
    const refTable = String(row.references_col).split(".")[0];
    if (refTable) expanded.add(refTable);
  }

  for (const name of names) {
    const meta = lookupCatalog(TABLE_CATALOG, name);
    for (const join of meta?.joins || []) {
      if (join.to) expanded.add(join.to);
    }
  }

  return [...expanded];
}

async function loadSchema(ctx, tableNames) {
  if (tableNames.length === 0) return {};

  const placeholders = tableNames.map(() => "?").join(",");
  const [rows] = await ctx.catalog.execute(
    `SELECT st.table_name, sc.column_name, sc.data_type, sc.column_key, sc.references_col
     FROM schema_tables st
     JOIN schema_columns sc ON sc.table_id = st.id
     WHERE st.workspace_id = ?
       AND st.connection_id = ?
       AND st.table_name IN (${placeholders})
     ORDER BY st.table_name, sc.id`,
    [ctx.workspaceId, ctx.connectionId, ...tableNames]
  );

  const schema = {};
  for (const row of rows) {
    if (!schema[row.table_name]) schema[row.table_name] = [];
    const entry = {
      column: row.column_name,
      type: row.data_type,
      key: row.column_key,
    };
    if (row.references_col) entry.references = row.references_col;
    schema[row.table_name].push(entry);
  }
  return schema;
}

export async function retrieveAnswerContext(question, ctx, log = () => {}) {
  const started = Date.now();
  assertEngineContext(ctx);
  if (!ctx.qdrant) throw new Error("qdrant client is required.");

  const retrievedContext = await retrieveContext(question, ctx, log);
  const fewStarted = Date.now();
  log("searching examples");
  const fewshots = await retrieveFewshots(ctx, retrievedContext.questionVector);
  log(`examples: ${fewshots.length} in ${Date.now() - fewStarted} ms`);
  const seeded = seedTables(question);
  const fromExamples = fewshots.flatMap((ex) => tablesFromSql(ex.sql));

  const schemaStarted = Date.now();
  log("loading schema");
  const tableNames = await expandReferencedTables(
    ctx,
    mergeTableNames(
      seeded,
      mergeTableNames(
        fromExamples,
        retrievedContext.tables.map((hit) => hit.table_name)
      )
    )
  );
  const schema = await loadSchema(ctx, tableNames);
  const schemaText = schemaToText(schema, TABLE_CATALOG);
  log(`schema loaded: ${tableNames.length} tables in ${Date.now() - schemaStarted} ms`);

  return {
    tables: retrievedContext.tables,
    termLinks: retrievedContext.termLinks,
    seeded,
    fewshots,
    includedTables: tableNames,
    schemaText,
    schemaMs: Date.now() - started,
  };
}

function packResult(question, prepared, executed) {
  return {
    question,
    path: "large",
    mode: "advanced",
    tables: prepared.tables,
    term_links: prepared.termLinks,
    seeded_tables: prepared.seeded,
    fewshots: prepared.fewshots,
    included_tables: prepared.includedTables,
    other_tables: [],
    query: executed.generated.query,
    explanation: executed.generated.explanation,
    executed_sql: executed.executedSql,
    rows: executed.rows,
    executeError: executed.executeError,
    estimated_tokens: executed.estimatedTokens,
    schemaMs: prepared.schemaMs || 0,
    synthesisMs: executed.synthesisMs || 0,
    executionMs: executed.executionMs || 0,
  };
}

export async function answerAdvanced(question, ctx, log = () => {}) {
  const prepared = await retrieveAnswerContext(question, ctx, log);
  const sourcePool = openSourcePool(ctx.source);
  try {
    const executed = await executeWithRetries({
      question,
      schemaText: prepared.schemaText,
      fewshots: prepared.fewshots,
      termLinks: prepared.termLinks,
      log,
      options: { fullSchema: false, onPrompt: ctx.onPrompt },
      sourcePool,
    });
    return packResult(question, prepared, executed);
  } finally {
    await sourcePool.end();
  }
}
