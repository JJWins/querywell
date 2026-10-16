import { loadTableCatalog } from "../index/data/load.js";
import { loadStoredSchema } from "../index/schema.js";
import { assertEngineContext, openSourcePool } from "../db/source.js";
import { planForPath } from "../billing/plans.js";
import { answerBasic } from "./basic.js";
import { answerAdvanced, retrieveAnswerContext } from "./advanced.js";
import { resolveSqlProvider } from "./models.js";
import { executeWithRetries } from "./sql.js";

export const SMALL_MAX_CHARS = 30000;
export const MEDIUM_MAX_CHARS = 120000;
const TABLE_CATALOG = loadTableCatalog();

export function choosePath(schemaTextChars) {
  const count = Number(schemaTextChars);
  if (!Number.isFinite(count) || count < 0) {
    throw new Error("Schema text length is required.");
  }
  if (count <= SMALL_MAX_CHARS) return "small";
  if (count <= MEDIUM_MAX_CHARS) return "medium";
  return "large";
}

export function appendCompactTableNames(schemaText, otherNames) {
  const names = [...otherNames]
    .map((name) => String(name))
    .sort((a, b) => a.localeCompare(b));
  const body = names.length ? names.join(", ") : "(none)";
  return `${schemaText}\n\nOther tables (names only): ${body}`;
}

async function rememberSchemaChars(ctx, chars) {
  await ctx.catalog.execute(
    `UPDATE connections SET schema_text_chars = ? WHERE id = ? AND workspace_id = ?`,
    [chars, ctx.connectionId, ctx.workspaceId]
  );
  await ctx.catalog.execute(
    `UPDATE workspaces SET schema_text_chars = ? WHERE id = ?`,
    [chars, ctx.workspaceId]
  );
}

async function answerMedium(question, ctx, stored, log) {
  const prepared = await retrieveAnswerContext(question, ctx, log);
  const included = new Set(
    prepared.includedTables.map((name) => String(name).toLowerCase())
  );
  const otherTables = stored.tableNames.filter(
    (name) => !included.has(String(name).toLowerCase())
  );
  const schemaText = appendCompactTableNames(prepared.schemaText, otherTables);
  log(`medium path adds ${otherTables.length} other table names`);

  const sourcePool = openSourcePool(ctx.source);
  try {
    const executed = await executeWithRetries({
      question,
      schemaText,
      fewshots: prepared.fewshots,
      termLinks: prepared.termLinks,
      log,
      options: { fullSchema: false, path: "medium", onPrompt: ctx.onPrompt, provider: ctx.provider },
      sourcePool,
    });
    return {
      question,
      path: "medium",
      mode: "advanced",
      schema_text_chars: stored.text.length,
      tables: prepared.tables,
      term_links: prepared.termLinks,
      seeded_tables: prepared.seeded,
      fewshots: prepared.fewshots,
      included_tables: prepared.includedTables,
      other_tables: otherTables,
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
  } finally {
    await sourcePool.end();
  }
}

export async function answerQuestion(question, ctx, log = () => {}) {
  assertEngineContext(ctx);
  const schemaStarted = Date.now();
  const stored = await loadStoredSchema(
    ctx.catalog,
    ctx.workspaceId,
    ctx.connectionId,
    TABLE_CATALOG
  );
  const catalogSchemaMs = Date.now() - schemaStarted;
  const path = choosePath(stored.text.length);
  const plan = planForPath(path);
  await rememberSchemaChars(ctx, stored.text.length);
  log(
    `schema text ${stored.text.length} characters, path ${path}, plan ${plan.code}`
  );

  const sqlModel = resolveSqlProvider(ctx.provider);
  const withSchema = { ...ctx, storedSchema: stored, provider: sqlModel.id };
  let result;
  if (path === "small") result = await answerBasic(question, withSchema, log);
  else if (path === "medium") result = await answerMedium(question, withSchema, stored, log);
  else result = await answerAdvanced(question, withSchema, log);

  return {
    ...result,
    path,
    provider: sqlModel.id,
    model: sqlModel.model,
    modelLabel: sqlModel.label,
    schema_text_chars: stored.text.length,
    plan,
    schemaMs: catalogSchemaMs + (Number(result.schemaMs) || 0),
    synthesisMs: Number(result.synthesisMs) || 0,
    executionMs: Number(result.executionMs) || 0,
  };
}
