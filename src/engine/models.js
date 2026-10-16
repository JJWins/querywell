import Anthropic from "@anthropic-ai/sdk";

const SQL_TIMEOUT_MS = Number(process.env.SQL_TIMEOUT_MS || 120000);

const PROVIDERS = {
  anthropic: {
    id: "anthropic",
    label: "Claude",
    keyEnv: "ANTHROPIC_API_KEY",
    modelEnv: "ANTHROPIC_MODEL",
    defaultModel: "claude-sonnet-4-6",
  },
  gemini: {
    id: "gemini",
    label: "Gemini",
    keyEnv: "GEMINI_API_KEY",
    modelEnv: "GEMINI_MODEL",
    defaultModel: "gemini-3.8-flash",
  },
};

function keyFor(provider) {
  return String(process.env[provider.keyEnv] || "").trim();
}

function describe(provider) {
  return {
    id: provider.id,
    label: provider.label,
    model: process.env[provider.modelEnv] || provider.defaultModel,
  };
}

export function sqlProviderChoices() {
  const available = Object.values(PROVIDERS).filter((provider) => keyFor(provider));
  const preferred = String(process.env.SQL_PROVIDER || "anthropic").trim().toLowerCase();
  const selected = available.some((provider) => provider.id === preferred)
    ? preferred
    : available[0]?.id;
  return available.map((provider) => {
    const choice = describe(provider);
    return { ...choice, selected: choice.id === selected };
  });
}

export function resolveSqlProvider(requested) {
  const explicit = String(requested || process.env.SQL_PROVIDER || "").trim().toLowerCase();
  if (explicit) {
    const provider = PROVIDERS[explicit];
    if (!provider) {
      throw new Error(`SQL provider must be one of: ${Object.keys(PROVIDERS).join(", ")}.`);
    }
    if (!keyFor(provider)) {
      throw new Error(`${provider.label} is not configured. Set ${provider.keyEnv}.`);
    }
    return describe(provider);
  }

  const claude = PROVIDERS.anthropic;
  if (keyFor(claude)) return describe(claude);
  const gemini = PROVIDERS.gemini;
  if (keyFor(gemini)) return describe(gemini);
  throw new Error("Set ANTHROPIC_API_KEY or GEMINI_API_KEY.");
}

function geminiThinkingConfig(model) {
  if (/^gemini-2\.5-pro/i.test(model)) return undefined;
  if (/^gemini-2\.5/i.test(model)) return { thinkingBudget: 0 };
  return { thinkingLevel: "low" };
}

function geminiVisibleText(data) {
  const parts = data?.candidates?.[0]?.content?.parts || [];
  return parts
    .filter((part) => part && part.thought !== true && part.text)
    .map((part) => part.text)
    .join("");
}

async function completeGemini(model, system, messages) {
  const thinkingConfig = geminiThinkingConfig(model.model);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SQL_TIMEOUT_MS);
  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model.model)}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": keyFor(PROVIDERS.gemini),
        },
        signal: controller.signal,
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: messages.map((message) => ({
            role: message.role === "assistant" ? "model" : "user",
            parts: [{ text: String(message.content || "") }],
          })),
          generationConfig: {
            maxOutputTokens: 2048,
            temperature: 0,
            responseMimeType: "application/json",
            ...(thinkingConfig ? { thinkingConfig } : {}),
          },
        }),
      }
    );
    const raw = await response.text();
    let data = {};
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch {
      data = {};
    }
    if (!response.ok) {
      const apiMessage = data?.error?.message || raw.slice(0, 240);
      throw new Error(`Gemini request failed (${response.status}): ${apiMessage}`);
    }
    const block = data?.promptFeedback?.blockReason;
    if (block) throw new Error(`Gemini blocked the prompt (${block}).`);
    const usage = data.usageMetadata || {};
    return {
      text: geminiVisibleText(data),
      inputTokens: Number(usage.promptTokenCount || 0),
      outputTokens:
        Number(usage.candidatesTokenCount || 0) + Number(usage.thoughtsTokenCount || 0),
    };
  } catch (err) {
    if (err?.name === "AbortError") {
      throw new Error("Gemini request timed out.");
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function completeAnthropic(model, system, messages) {
  const client = new Anthropic();
  const response = await client.messages.create({
    model: model.model,
    max_tokens: 1024,
    system,
    messages,
  });
  const usage = response.usage || {};
  return {
    text: response.content?.[0]?.text || "",
    inputTokens: Number(usage.input_tokens || 0),
    outputTokens: Number(usage.output_tokens || 0),
  };
}

export async function completeSql({ provider, system, messages }) {
  const model = resolveSqlProvider(provider);
  const completion =
    model.id === "gemini"
      ? await completeGemini(model, system, messages)
      : await completeAnthropic(model, system, messages);
  return { ...completion, provider: model.id, model: model.model, label: model.label };
}
