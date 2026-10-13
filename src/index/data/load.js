import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));

function readJson(name) {
  return JSON.parse(readFileSync(path.join(dir, name), "utf8"));
}

const AVOID = {
  proposal: ["eps_proposal"],
  proposal_persons: ["eps_proposal_persons", "era_proposal_person_roles"],
  eps_proposal: ["proposal"],
  eps_proposal_persons: ["proposal_persons", "era_proposal_person_roles"],
  era_proposal_person_roles: ["eps_proposal_persons", "proposal_persons"],
  award: ["sap_award_feed", "feed_award_details"],
  award_persons: ["award_persons_inactive"],
  sponsor: ["proposal_sponsors", "eps_proposal_sponsors", "agreement_sponsor"],
};

export function loadTableCatalog() {
  const rows = readJson("table_catalog.json");
  const map = new Map();
  for (const row of rows) {
    const key = row.table_name.toLowerCase();
    map.set(key, {
      ...row,
      avoid: AVOID[key] || [],
    });
  }
  return map;
}

export function loadFewshotExamples() {
  const rows = readJson("fewshot_examples.json");
  const seen = new Set();
  const unique = [];
  for (const row of rows) {
    const key = row.question.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(row);
  }
  return unique;
}

export function lookupCatalog(catalog, tableName) {
  return catalog.get(String(tableName).toLowerCase()) || null;
}
