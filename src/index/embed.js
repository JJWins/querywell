const EMBEDDING_URL = process.env.EMBEDDING_URL || "http://192.168.1.235:11435/api/embed";
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || "qwen3-embedding:latest";
export const EMBEDDING_DIM = Number(process.env.EMBEDDING_DIM || 1024);
const EMBED_TIMEOUT_MS = Number(process.env.EMBED_TIMEOUT_MS || 120000);

function embeddingKeepAlive() {
  const raw = process.env.EMBED_KEEP_ALIVE;
  if (raw == null || raw === "") return -1;
  if (/^-?\d+$/.test(String(raw).trim())) return Number(raw);
  return raw;
}
const cache = new Map();
let tail = Promise.resolve();

function enqueue(task) {
  const run = tail.then(task, task);
  tail = run.then(
    () => {},
    () => {}
  );
  return run;
}

export async function getEmbeddings(texts) {
  const missing = [];
  for (const text of texts) {
    if (!cache.has(text) && !missing.includes(text)) missing.push(text);
  }

  if (missing.length) {
    await enqueue(async () => {
      const stillMissing = missing.filter((text) => !cache.has(text));
      if (stillMissing.length === 0) return;
      const started = Date.now();
      console.log(`[embed] requesting ${stillMissing.length}`);
      const vectors = await requestEmbeddings(stillMissing);
      stillMissing.forEach((text, index) => cache.set(text, vectors[index]));
      console.log(`[embed] received ${stillMissing.length} in ${Date.now() - started} ms`);
    });
  }

  return texts.map((text) => cache.get(text));
}

export async function getEmbedding(text) {
  const [vector] = await getEmbeddings([text]);
  return vector;
}

async function requestEmbeddings(texts) {
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), EMBED_TIMEOUT_MS);
    try {
      const response = await fetch(EMBEDDING_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          model: EMBEDDING_MODEL,
          input: texts,
          dimensions: EMBEDDING_DIM,
          keep_alive: embeddingKeepAlive(),
        }),
      });

      if (!response.ok) {
        throw new Error(
          `Embedding request failed (${response.status}): ${await response.text()}`
        );
      }

      const data = await response.json();
      const embeddings = data.embeddings ?? (data.embedding ? [data.embedding] : null);
      if (!Array.isArray(embeddings) || embeddings.length !== texts.length) {
        throw new Error(`Expected ${texts.length} embeddings, got ${embeddings?.length}`);
      }
      for (const embedding of embeddings) {
        if (!Array.isArray(embedding) || embedding.length !== EMBEDDING_DIM) {
          throw new Error(
            `Expected a ${EMBEDDING_DIM}-d embedding, got ${embedding?.length}`
          );
        }
      }
      return embeddings;
    } catch (err) {
      if (err.name === "AbortError") {
        throw new Error(`Embedding timed out after ${EMBED_TIMEOUT_MS} ms`);
      }
      lastError = err;
      console.log(`[embed] attempt ${attempt} failed: ${err.message}`);
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}
