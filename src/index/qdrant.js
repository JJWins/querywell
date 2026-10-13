import { QdrantClient } from "@qdrant/js-client-rest";
import { EMBEDDING_DIM } from "./embed.js";

export const SCHEMA_COLLECTION = "nlp_saas_schema";
export const FEWSHOT_COLLECTION = "nlp_saas_fewshot";

export function qdrantUrl() {
  return process.env.QDRANT_URL || "http://127.0.0.1:6333";
}

export function createQdrantClient() {
  const client = new QdrantClient({
    url: qdrantUrl(),
    checkCompatibility: false,
  });
  if (typeof client.search !== "function") {
    client.search = async function search(collection, { vector, limit, with_payload, filter }) {
      const result = await this.query(collection, {
        query: vector,
        limit,
        with_payload,
        filter,
      });
      return result.points || [];
    };
  }
  return client;
}

function existsResult(value) {
  return value === true || value?.exists === true;
}

export async function ensureCollections(client) {
  for (const name of [SCHEMA_COLLECTION, FEWSHOT_COLLECTION]) {
    let exists = false;
    try {
      exists = existsResult(await client.collectionExists(name));
    } catch {
      exists = false;
    }
    if (exists) continue;
    await client.createCollection(name, {
      vectors: { size: EMBEDDING_DIM, distance: "Cosine" },
    });
  }
}
