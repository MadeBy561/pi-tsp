#!/usr/bin/env node
/**
 * One-time setup for pi-tsp: its own pi config dir, so the front end has its
 * own model list, sessions and settings while the user's ~/.pi stays exactly
 * as it was. Model config is copied (never moved); npm packages and extension
 * config are symlinked so subagents work without reinstalling anything.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function piTspHome() {
  return process.env.PI_TSP_HOME || join(homedir(), ".pi-tsp");
}

export function configDir() {
  return join(piTspHome(), "agent");
}

export function sessionDir() {
  return process.env.PI_TSP_SESSION_DIR || join(piTspHome(), "sessions");
}

function addAlias(models) {
  try {
    const parsed = JSON.parse(models);
    const providers = parsed.providers || {};
    for (const [providerName, provider] of Object.entries(providers)) {
      const list = provider.models || [];
      if (list.length === 1 && !list.some((model) => model.id.endsWith("-alias"))) {
        const original = list[0];
        const alias = {
          ...original,
          id: original.id.replace(/-1017$/, ""),
          name: `${original.name || original.id} (alias)`,
        };
        if (alias.id === original.id) alias.id = `${original.id}-alias`;
        list.push(alias);
        provider.models = list;
        void providerName;
      }
    }
    return JSON.stringify(parsed, null, 2);
  } catch {
    return models;
  }
}

export function ensureConfig() {
  const dir = configDir();
  mkdirSync(dir, { recursive: true });
  mkdirSync(sessionDir(), { recursive: true });
  const source = join(homedir(), ".pi", "agent");

  const modelsPath = join(dir, "models.json");
  if (!existsSync(modelsPath) && existsSync(join(source, "models.json"))) {
    const raw = readFileSync(join(source, "models.json"), "utf8");
    writeFileSync(modelsPath, addAlias(raw));
  }

  const settingsPath = join(dir, "settings.json");
  if (!existsSync(settingsPath)) {
    let settings = {};
    try {
      settings = JSON.parse(readFileSync(join(source, "settings.json"), "utf8"));
    } catch {
      /* a fresh config is fine */
    }
    const next = {
      ...settings,
      theme: settings.theme || "dracula",
      defaultThinkingLevel: settings.defaultThinkingLevel || "max",
    };
    writeFileSync(settingsPath, JSON.stringify(next, null, 2));
  }

  for (const name of ["npm", "extensions", "themes"]) {
    const link = join(dir, name);
    const target = join(source, name);
    if (!existsSync(link) && existsSync(target)) {
      try {
        symlinkSync(target, link, "dir");
      } catch {
        /* an existing directory or an unsupported link: not fatal */
      }
    }
  }
  return dir;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(ensureConfig());
}
