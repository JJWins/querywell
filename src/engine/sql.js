import Anthropic from "@anthropic-ai/sdk";

const RESULT_LIMIT = Number(process.env.RESULT_LIMIT || 100);
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";

const CANONICAL_RULES = `Canonical joins for this app:
- Institutional proposal people: PROPOSAL_PERSONS JOIN PROPOSAL ON PROPOSAL_ID. Never use EPS_PROPOSAL_PERSONS or ERA_PROPOSAL_PERSON_ROLES for institutional proposals.
- Proposal-development people: EPS_PROPOSAL_PERSONS JOIN EPS_PROPOSAL ON PROPOSAL_ID. Never use PROPOSAL_PERSONS or ERA_PROPOSAL_PERSON_ROLES for development proposals.
- If the question just says "proposals" and a person name, prefer institutional PROPOSAL + PROPOSAL_PERSONS unless it says development/EPS.
- Award people: AWARD_PERSONS JOIN AWARD ON AWARD_ID. Do not use AWARD_PERSONS_INACTIVE.
- Agreement people: AGREEMENT_PEOPLE JOIN AGREEMENT_HEADER ON AGREEMENT_REQUEST_ID.
- Sponsor master is SPONSOR. PROPOSAL_SPONSORS / EPS_PROPOSAL_SPONSORS / AGREEMENT_SPONSOR are link tables only.`;

export function buildSystemPrompt(schemaText, fewshots = [], termLinks = "", options = {}) {
  const fullSchema = options.fullSchema === true;
  const medium = options.path === "medium";
  const examples = fewshots
    .map(
      (ex) =>
        `Question: ${ex.question}\n${JSON.stringify({
          query: ex.sql,
          explanation: ex.explanation,
        })}`
    )
    .join("\n\n");
  const scope = medium
    ? "The tables with columns below were retrieved for this question. Use only those columns. A compact list of every other table name is included so you know what else exists. Do not invent columns for tables that appear as names only."
    : fullSchema
      ? "The full database schema is below. Use only these tables and columns. Do not invent names."
      : "The tables below were retrieved as the most relevant to the question. Use ONLY these tables and columns. Do not invent names.";

  return `You are a MySQL expert who translates natural-language questions into SQL.

${CANONICAL_RULES}

${termLinks ? `${termLinks}\n` : ""}
${scope}

${schemaText}

${examples ? `${fullSchema ? "Examples" : "Retrieved examples from this schema"}:\n${examples}\n` : ""}
Rules:
- Output a single JSON object and nothing else. No markdown, no code fences, no extra text.
- Shape: {"query": "<SQL or null>", "explanation": "<short reason>"}
- Dialect is MySQL. Use MySQL functions (YEAR(), CURDATE(), LIMIT, etc.).
- Write only a single SELECT statement. Never INSERT, UPDATE, DELETE, DROP, ALTER, or multiple statements.
- A column may be used only on the table it is listed under. Never SELECT alias.column unless that column belongs to that table.
${examples ? "- Follow the examples' join style when the question is similar.\n" : ""}${termLinks ? "- When Term links names a lookup value, filter on that value. Do not replace it with a free-text search of titles, abstracts, or comments.\n" : ""}- If the question cannot be answered from these tables, return {"query": null, "explanation": "..."}.`;
}

function parseModelJson(text) {
  const raw = String(text ?? "").trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : raw).trim();
  const parsed = tryParseJson(candidate) ?? tryParseJson(sliceJsonObject(candidate));
  if (parsed && typeof parsed === "object") return parsed;
  return {
    query: null,
    explanation: "Model returned invalid JSON.",
  };
}

function tryParseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function sliceJsonObject(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return "";
  return text.slice(start, end + 1);
}

export async function generateSQL(
  question,
  schemaText,
  history = [],
  fewshots = [],
  termLinks = "",
  options = {}
) {
  const system = buildSystemPrompt(schemaText, fewshots, termLinks, options);
  if (typeof options.onPrompt === "function") options.onPrompt(system);

  const client = new Anthropic();
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system,
    messages: [{ role: "user", content: question }, ...history],
  });

  const parsed = parseModelJson(response.content?.[0]?.text);
  const usage = response.usage || {};
  parsed.estimated_tokens =
    Number(usage.input_tokens || 0) + Number(usage.output_tokens || 0);
  return parsed;
}

export function isSafeSelect(sql) {
  const trimmed = String(sql || "").trim().replace(/;+$/, "");
  if (!trimmed || /;/.test(trimmed)) return false;
  if (!/^\s*select\b/i.test(trimmed)) return false;
  if (
    /\b(insert|update|delete|drop|alter|truncate|create|grant|revoke|replace|load|outfile|dumpfile|into\s+outfile)\b/i.test(
      trimmed
    )
  ) {
    return false;
  }
  return true;
}

export function withLimit(sql, limit = RESULT_LIMIT) {
  const trimmed = sql.trim().replace(/;+$/, "");
  if (/\blimit\s+\d+/i.test(trimmed)) return trimmed;
  if (/\bcount\s*\(/i.test(trimmed) && !/\bgroup\s+by\b/i.test(trimmed)) {
    return trimmed;
  }
  return `${trimmed} LIMIT ${limit}`;
}

function serializeRows(rows) {
  return rows.map((row) => {
    const out = {};
    for (const [key, value] of Object.entries(row)) {
      out[key] = value instanceof Date ? value.toISOString() : value;
    }
    return out;
  });
}

export async function executeWithRetries({
  question,
  schemaText,
  fewshots = [],
  termLinks = "",
  log = () => {},
  options = {},
  sourcePool,
}) {
  if (!sourcePool) throw new Error("A source connection is required to run SQL.");

  const sqlStarted = Date.now();
  log("generating SQL");
  let generated = await generateSQL(
    question,
    schemaText,
    [],
    fewshots,
    termLinks,
    options
  );
  let estimatedTokens = generated.estimated_tokens || 0;
  let synthesisMs = Date.now() - sqlStarted;
  let executionMs = 0;
  log(`SQL ready in ${synthesisMs} ms`);
  const history = [];

  let rows = null;
  let executedSql = null;
  let executeError = null;

  for (let attempt = 0; attempt < 3; attempt++) {
    if (!generated.query) break;
    if (!isSafeSelect(generated.query)) {
      executeError = "Generated SQL was not a single SELECT and was not run.";
      log(executeError);
      break;
    }

    executedSql = withLimit(generated.query);
    const runStarted = Date.now();
    log(`running SQL, attempt ${attempt + 1}`);
    try {
      const [resultRows] = await sourcePool.query(executedSql);
      rows = serializeRows(resultRows);
      executeError = null;
      executionMs = Date.now() - runStarted;
      log(`SQL returned ${rows.length} rows in ${executionMs} ms`);
      break;
    } catch (err) {
      executeError = err.message;
      executionMs = Date.now() - runStarted;
      log(`SQL failed in ${executionMs} ms: ${err.message}`);
      if (attempt === 2) break;
      history.push(
        { role: "assistant", content: JSON.stringify({
          query: generated.query,
          explanation: generated.explanation,
        }) },
        {
          role: "user",
          content:
            `MySQL rejected that query:\n${err.message}\n\nRewrite it. Every selected column must exist on the table behind its alias. Join another table if you need its columns. Return JSON only.`,
        }
      );
      const retryStarted = Date.now();
      log("regenerating SQL");
      generated = await generateSQL(
        question,
        schemaText,
        history,
        fewshots,
        termLinks,
        options
      );
      estimatedTokens += generated.estimated_tokens || 0;
      const retryMs = Date.now() - retryStarted;
      synthesisMs += retryMs;
      log(`SQL ready in ${retryMs} ms`);
    }
  }

  return { generated, rows, executedSql, executeError, estimatedTokens, synthesisMs, executionMs };
}
