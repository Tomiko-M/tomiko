import { afterEach, beforeEach } from "vitest";
import { resetConfig, resetReports } from "../src/index.js";

// Tests talk to fake APIs only, and to servers of their own on this machine. Anything else that
// reaches the real fetch is a test bug.
const local = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  if (/^http:\/\/127\.0\.0\.1[:/]/.test(url)) return local(input, init);
  throw new Error(`Test tried to reach the network: ${url}`);
};

// SDK clients read these at construction; a developer's own settings must not change the tests.
for (const key of ["ANTHROPIC_BASE_URL", "OPENAI_BASE_URL"]) delete process.env[key];

// Tests choose their mode explicitly; the runner's own CI/TOMIKO_MODE must not leak in.
const saved = { CI: process.env.CI, TOMIKO_MODE: process.env.TOMIKO_MODE };

beforeEach(() => {
  delete process.env.CI;
  delete process.env.TOMIKO_MODE;
  resetConfig();
  resetReports();
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
