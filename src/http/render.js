import Handlebars from "handlebars";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const viewsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../views");
const layoutsDir = path.join(viewsDir, "layouts");
const partialsDir = path.join(viewsDir, "partials");

const templateCache = new Map();
let partialsRegistered = false;

// Register utility helpers
Handlebars.registerHelper("eq", (a, b) => a === b);
Handlebars.registerHelper("neq", (a, b) => a !== b);
Handlebars.registerHelper("gt", (a, b) => Number(a) > Number(b));
Handlebars.registerHelper("gte", (a, b) => Number(a) >= Number(b));
Handlebars.registerHelper("lt", (a, b) => Number(a) < Number(b));
Handlebars.registerHelper("lte", (a, b) => Number(a) <= Number(b));
Handlebars.registerHelper("json", (context) => JSON.stringify(context));
Handlebars.registerHelper("formatNumber", (num) => (num == null ? "" : Number(num).toLocaleString()));
Handlebars.registerHelper("percent", (used, limit) => {
  const amount = Number(used);
  const cap = Number(limit);
  if (!Number.isFinite(amount) || !Number.isFinite(cap) || cap <= 0) return 0;
  return Math.min(100, Math.round((amount / cap) * 100));
});
Handlebars.registerHelper("or", (a, b) => Boolean(a || b));
Handlebars.registerHelper("and", (a, b) => Boolean(a && b));
Handlebars.registerHelper("default", (val, defaultVal) => (val != null && val !== "" ? val : defaultVal));

async function getTemplate(filePath) {
  if (process.env.NODE_ENV === "production" && templateCache.has(filePath)) {
    return templateCache.get(filePath);
  }
  const source = await readFile(filePath, "utf8");
  const compiled = Handlebars.compile(source);
  if (process.env.NODE_ENV === "production") {
    templateCache.set(filePath, compiled);
  }
  return compiled;
}

export async function registerPartials() {
  try {
    const entries = await readdir(partialsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".hbs")) {
        const name = path.basename(entry.name, ".hbs");
        const filePath = path.join(partialsDir, entry.name);
        const source = await readFile(filePath, "utf8");
        Handlebars.registerPartial(name, source);
      }
    }
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  partialsRegistered = true;
}

/**
 * Render a view with optional layout and partials.
 * @param {string} viewName - Name of the view file without .hbs (e.g. "home", "ask")
 * @param {object} data - Data passed into template
 * @param {object} options - Options including layout ("main", "app", or null)
 * @returns {Promise<string>} Rendered HTML string
 */
export async function renderView(viewName, data = {}, options = { layout: "main" }) {
  if (!partialsRegistered || process.env.NODE_ENV !== "production") {
    await registerPartials();
  }

  const viewFile = path.join(viewsDir, `${viewName}.hbs`);
  const viewTemplate = await getTemplate(viewFile);
  const bodyHtml = viewTemplate(data);

  const layout = options.layout;
  if (!layout) {
    return bodyHtml;
  }

  const layoutFile = path.join(layoutsDir, `${layout}.hbs`);
  const layoutTemplate = await getTemplate(layoutFile);
  return layoutTemplate({
    ...data,
    body: new Handlebars.SafeString(bodyHtml),
  });
}

/**
 * Invalidate cache if hot-reloading templates is needed.
 */
export function clearTemplateCache() {
  templateCache.clear();
  partialsRegistered = false;
}
