import { afterEach, beforeEach } from "vitest";
import { resetConfig, resetReports } from "../src/index.js";

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
