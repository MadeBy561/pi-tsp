/**
 * One-time setup for pi-tsp: its own pi config dir, so the front end has its
 * own sessions and settings while the user's ~/.pi stays exactly as it was.
 * Model config is copied (never moved); npm packages, extensions and themes
 * are symlinked so the user's pi setup works without reinstalling anything.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function piTspHome(): string {
  return process.env.PI_TSP_HOME || join(homedir(), ".pi-tsp");
}

export function configDir(): string {
  return join(piTspHome(), "agent");
}

export function sessionDir(): string {
  return process.env.PI_TSP_SESSION_DIR || join(piTspHome(), "sessions");
}

/** Creates the config dir (0700) and seeds it from ~/.pi/agent; returns its path. */
export function ensureConfig(): string {
  const dir = configDir();
  for (const path of [piTspHome(), dir, sessionDir()]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  try {
    chmodSync(piTspHome(), 0o700);
  } catch {
    /* a filesystem without modes */
  }
  const source = join(homedir(), ".pi", "agent");

  const modelsPath = join(dir, "models.json");
  if (!existsSync(modelsPath) && existsSync(join(source, "models.json"))) {
    writeFileSync(modelsPath, readFileSync(join(source, "models.json"), "utf8"), { mode: 0o600 });
  }

  const settingsPath = join(dir, "settings.json");
  if (!existsSync(settingsPath)) {
    let settings: Record<string, unknown> = {};
    try {
      settings = JSON.parse(readFileSync(join(source, "settings.json"), "utf8")) as Record<string, unknown>;
    } catch {
      /* a fresh config is fine */
    }
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2), { mode: 0o600 });
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
