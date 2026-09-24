import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function configurePi() {
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  if (!agentDir) {
    throw new Error("PI_CODING_AGENT_DIR is required");
  }

  await mkdir(agentDir, { recursive: true });

  const baseUrl = process.env.DEMO_MODEL_BASE_URL?.trim();
  const modelId = process.env.DEMO_MODEL_ID?.trim();
  if (!baseUrl && !modelId) {
    return { configured: false, modelId: null };
  }
  if (!baseUrl || !modelId) {
    throw new Error("Set both DEMO_MODEL_BASE_URL and DEMO_MODEL_ID");
  }

  const model = {
    id: modelId,
    input: process.env.DEMO_MODEL_VISION === "false" ? ["text"] : ["text", "image"],
    reasoning: process.env.DEMO_MODEL_REASONING !== "false",
    compat: {
      thinkingFormat: process.env.DEMO_MODEL_THINKING_FORMAT || "qwen-chat-template",
      ...(process.env.DEMO_MODEL_THINKING_BUDGET_FIELD === "none"
        ? {}
        : { thinkingTokenBudgetField: process.env.DEMO_MODEL_THINKING_BUDGET_FIELD || "thinking_token_budget" }),
    },
  };
  const config = {
    providers: {
      demo: {
        baseUrl,
        api: process.env.DEMO_MODEL_API || "openai-completions",
        apiKey: process.env.DEMO_MODEL_API_KEY ? "$DEMO_MODEL_API_KEY" : "local-demo",
        models: [model],
      },
    },
  };
  await writeFile(join(agentDir, "models.json"), `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  });
  return { configured: true, modelId };
}
