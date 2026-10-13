import { loadTableCatalog } from "../index/data/load.js";
import { loadStoredSchema } from "../index/schema.js";
import { assertEngineContext, openSourcePool } from "../db/source.js";
import { executeWithRetries } from "./sql.js";

const TABLE_CATALOG = loadTableCatalog();

export async function answerBasic(question, ctx, log = () => {}) {
  assertEngineContext(ctx);
  const stored =
    ctx.storedSchema ||
    (await loadStoredSchema(
      ctx.catalog,
      ctx.workspaceId,
      ctx.connectionId,
      TABLE_CATALOG
    ));
  log(
    `using full schema (${stored.tableNames.length} tables, ${stored.text.length} characters)`
  );

  const sourcePool = openSourcePool(ctx.source);
  try {
    const executed = await executeWithRetries({
      question,
      schemaText: stored.text,
      fewshots: [],
      termLinks: "",
      log,
      options: { fullSchema: true, onPrompt: ctx.onPrompt },
      sourcePool,
    });
    return {
      question,
      path: "small",
      mode: "basic",
      schema_text_chars: stored.text.length,
      tables: [],
      term_links: "",
      seeded_tables: [],
      fewshots: [],
      included_tables: stored.tableNames,
      other_tables: [],
      query: executed.generated.query,
      explanation: executed.generated.explanation,
      executed_sql: executed.executedSql,
      rows: executed.rows,
      executeError: executed.executeError,
      estimated_tokens: executed.estimatedTokens,
      schemaMs: 0,
      synthesisMs: executed.synthesisMs || 0,
      executionMs: executed.executionMs || 0,
    };
  } finally {
    await sourcePool.end();
  }
}
