#!/usr/bin/env node
// A stand-in for `pi --mode rpc`: answers the commands pi-tsp sends at startup.
import { createInterface } from "node:readline";

const model = { id: "fake-1", name: "Fake One", provider: "fake", contextWindow: 100000, reasoning: true, input: ["text"] };
const data = {
  get_state: { model, thinkingLevel: "high", isStreaming: false, isCompacting: false, steeringMode: "one-at-a-time", followUpMode: "one-at-a-time", sessionId: "s1", autoCompactionEnabled: true, messageCount: 0, pendingMessageCount: 0 },
  get_available_models: { models: [model] },
  get_available_thinking_levels: { levels: ["off", "low", "high"] },
  get_commands: { commands: [] },
  get_messages: { messages: [] },
  get_session_stats: { sessionId: "s1", userMessages: 0, assistantMessages: 0, toolCalls: 0, toolResults: 0, totalMessages: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0, contextUsage: { tokens: 0, contextWindow: 100000, percent: 0 } },
};
if (process.argv.includes("--version")) {
  console.log("9.9.9");
  process.exit(0);
}
createInterface({ input: process.stdin }).on("line", line => {
  const command = JSON.parse(line);
  if (command.type === "prompt") {
    console.log(JSON.stringify({ id: command.id, type: "response", command: "prompt", success: true, data: { disposition: "started" } }));
    for (const event of [
      { type: "agent_start" },
      { type: "message_start", message: { role: "user", content: command.message } },
      { type: "message_start", message: { role: "assistant" } },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: `echo: ${command.message}` } },
      { type: "message_end", message: { role: "assistant", model: "fake-1", content: [{ type: "text", text: `echo: ${command.message}` }], usage: { input: 5, output: 3, totalTokens: 8 } } },
      { type: "turn_end", message: { usage: { input: 5, output: 3, totalTokens: 8 } } },
      { type: "agent_settled" },
    ]) console.log(JSON.stringify(event));
    return;
  }
  console.log(JSON.stringify({ id: command.id, type: "response", command: command.type, success: true, data: data[command.type] ?? {} }));
});
