// A small MCP server for tests: notes to read and add, a count that reports progress, a resource.
// It appends what happens to it to $NOTES_LOG, so a test can tell whether a replay started it.
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const log = (line) => {
  if (process.env.NOTES_LOG) appendFileSync(process.env.NOTES_LOG, `${line}\n`);
};

export function notesServer() {
  const notes = new Map([
    ["groceries", "eggs, milk"],
    ["todo", "call the plumber"],
  ]);
  const server = new McpServer({ name: "Notes Server", version: "1.0.0" }, { capabilities: { logging: {} } });
  server.server.oninitialized = () => log("initialized");
  server.registerTool("read_note", { description: "Read a note", inputSchema: { name: z.string() } }, async ({ name }) => {
    log(`read_note ${name}`);
    return { content: [{ type: "text", text: notes.get(name) ?? `No note called ${name}.` }] };
  });
  server.registerTool("add_note", { description: "Add a note", inputSchema: { name: z.string(), text: z.string() } }, async ({ name, text }) => {
    log(`add_note ${name}`);
    notes.set(name, text);
    return { content: [{ type: "text", text: `Saved ${name}.` }] };
  });
  server.registerTool("count", { description: "Count, reporting progress", inputSchema: { to: z.number() } }, async ({ to }, extra) => {
    log(`count ${to}`);
    const token = extra._meta?.progressToken;
    for (let i = 1; i <= to; i++) {
      if (token !== undefined) await extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: i, total: to } });
    }
    await server.sendLoggingMessage({ level: "info", data: `counted to ${to}` });
    return { content: [{ type: "text", text: `Counted to ${to}.` }] };
  });
  server.registerResource("all notes", "notes://all", { mimeType: "text/plain" }, async (uri) => {
    log("read notes://all");
    return { contents: [{ uri: uri.href, text: [...notes.keys()].join("\n") }] };
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  log("start");
  await notesServer().connect(new StdioServerTransport());
}
