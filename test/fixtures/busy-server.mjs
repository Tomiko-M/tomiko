// A small MCP server for the MCP fix tests: a slow tool, and a tool that asks the client to
// sample from its model while it works. It appends what happens to it to $BUSY_LOG, and exits
// at once when $BUSY_CRASH is set, as a server that fails to come up does.
import { appendFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const log = (line) => {
  if (process.env.BUSY_LOG) appendFileSync(process.env.BUSY_LOG, `${line}\n`);
};

log("start");
if (process.env.BUSY_CRASH) process.exit(1);

const server = new McpServer({ name: "Busy Server", version: "1.0.0" });
server.server.oninitialized = () => log("initialized");
server.registerTool("slow", { description: "Answer after a while", inputSchema: { ms: z.number() } }, async ({ ms }) => {
  log(`slow ${ms}`);
  await new Promise((resolve) => setTimeout(resolve, ms));
  return { content: [{ type: "text", text: `waited ${ms}` }] };
});
server.registerTool("echo", { description: "Echo", inputSchema: { text: z.string() } }, async ({ text }) => {
  log(`echo ${text}`);
  return { content: [{ type: "text", text }] };
});
server.registerTool("ask", { description: "Ask the client's model", inputSchema: { question: z.string() } }, async ({ question }) => {
  log(`ask ${question}`);
  const answer = await server.server.createMessage({ messages: [{ role: "user", content: { type: "text", text: question } }], maxTokens: 50 });
  return { content: [{ type: "text", text: `model said: ${answer.content.type === "text" ? answer.content.text : "?"}` }] };
});
await server.connect(new StdioServerTransport());
