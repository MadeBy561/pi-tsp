/** Which logo a model gets: its maker's when the id names one, else its provider's. */

/** Model families by what their ids contain, most specific first. */
const FAMILIES: [RegExp, string][] = [
  [/deepseek/, "deepseek"],
  [/claude/, "anthropic"],
  [/\b(gpt|o[134]|codex|chatgpt)\b|^gpt|^o[134]-/, "openai"],
  [/gemini|gemma/, "google"],
  [/grok/, "xai"],
  [/glm|zhipu/, "zhipu-coding-plan"],
  [/kimi|moonshot/, "moonshot"],
  [/qwen|qwq/, "qwen-portal"],
  [/mistral|mixtral|codestral|devstral/, "mistral"],
  [/llama/, "meta"],
  [/minimax/, "minimax"],
];

/** Provider names that differ from the logo's id. */
const PROVIDERS: [RegExp, string][] = [
  [/deepseek/, "deepseek"],
  [/anthropic|claude/, "anthropic"],
  [/codex/, "openai-codex"],
  [/openai|azure/, "openai"],
  [/vertex/, "google-vertex"],
  [/google|gemini/, "google"],
  [/^x-?ai|xai/, "xai"],
  [/^z\.?-?ai$/, "zai"],
  [/zhipu|glm/, "zhipu-coding-plan"],
  [/moonshot|kimi/, "moonshot"],
  [/qwen|alibaba|dashscope/, "qwen-portal"],
  [/openrouter/, "openrouter"],
  [/groq/, "groq"],
  [/ollama/, "ollama-cloud"],
  [/mistral/, "mistral"],
  [/together/, "together"],
  [/fireworks/, "fireworks"],
  [/copilot/, "github-copilot"],
  [/hugging/, "huggingface"],
  [/nvidia/, "nvidia"],
  [/minimax/, "minimax"],
];

/**
 * The logo id for a model. A model served through a gateway or a local
 * endpoint (`local/deepseek-…`, `openrouter/anthropic/claude-…`) shows its
 * maker, which is what people recognise; otherwise the provider's own logo.
 */
export function providerKey(provider: string | undefined, model: string | undefined): string {
  const id = String(model ?? "").toLowerCase();
  for (const [pattern, key] of FAMILIES) if (pattern.test(id)) return key;
  const name = String(provider ?? "").toLowerCase();
  for (const [pattern, key] of PROVIDERS) if (pattern.test(name)) return key;
  return name;
}

/** The icon name Tern draws the logo from. */
export function providerIcon(provider: string | undefined, model: string | undefined): string | undefined {
  const key = providerKey(provider, model);
  return key ? `provider:${key}` : undefined;
}
