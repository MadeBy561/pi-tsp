/**
 * A shell command as the presentation Tern's `shell` node draws: one row per
 * line of the script, each a run of semantic segments (command, flag,
 * string, variable, operator, keyword, comment).
 *
 * omp fills this from its shell engine, which traces the script as it runs.
 * pi reports only the command and its outcome, so this is the static half:
 * the script tokenized, and the whole of it marked with how the run ended.
 */

export type ShellView = "raw" | "pseudo";

export interface ShellPrefs {
  view: ShellView;
  color: boolean;
}

interface Segment {
  text: string;
  style?: string;
  node: string;
  range: [number, number];
  state?: string;
  language?: string;
}

interface Row {
  id: string;
  depth: number;
  node: string;
  range: [number, number];
  active: boolean;
  role: "stmt";
  state?: string;
  segments: Segment[];
  effects: { kind: string; glyph: string; label: string; why: string }[];
  meta?: string;
  detail: string;
}

const KEYWORDS = new Set(["if", "then", "else", "elif", "fi", "for", "while", "until", "do", "done", "case", "esac", "in", "function", "select", "time", "{", "}", "!", "[[", "]]"]);
const OPERATORS = ["&&", "||", ">>", "<<", "2>&1", "&>", "|&", "|", ";", "&", ">", "<", "(", ")"];
/** Interpreters whose `-c`/`-e` argument is a script in another language. */
const EMBEDDED: Record<string, { flag: string; language: string }> = {
  python: { flag: "-c", language: "py" },
  python3: { flag: "-c", language: "py" },
  node: { flag: "-e", language: "js" },
  bash: { flag: "-c", language: "bash" },
  sh: { flag: "-c", language: "bash" },
  zsh: { flag: "-c", language: "bash" },
  ruby: { flag: "-e", language: "rb" },
  perl: { flag: "-e", language: "pl" },
};

/** What a command is known for, as omp's effect glyphs flag it. Heuristic. */
const EFFECTS: [RegExp, { kind: string; glyph: string; label: string; why: string }][] = [
  [/^(rm|rmdir|shred|mkfs|dd)$/, { kind: "destructive", glyph: "!", label: "destructive", why: "removes or overwrites data" }],
  [/^(sudo|doas|su)$/, { kind: "privilege", glyph: "#", label: "privileged", why: "runs with elevated privileges" }],
  [/^(curl|wget|ssh|scp|rsync|nc|git)$/, { kind: "network", glyph: "~", label: "network", why: "may talk to the network" }],
];

interface Token {
  text: string;
  from: number;
  kind: "word" | "string" | "op" | "comment" | "space" | "var";
}

function tokenize(line: string, offset: number): Token[] {
  const out: Token[] = [];
  let at = 0;
  const push = (to: number, kind: Token["kind"]): void => {
    if (to > at) out.push({ text: line.slice(at, to), from: offset + at, kind });
    at = to;
  };
  while (at < line.length) {
    const ch = line[at]!;
    if (/\s/.test(ch)) {
      let to = at;
      while (to < line.length && /\s/.test(line[to]!)) to += 1;
      push(to, "space");
    } else if (ch === "#" && (at === 0 || /\s/.test(line[at - 1]!))) {
      push(line.length, "comment");
    } else if (ch === "'" || ch === '"') {
      let to = at + 1;
      while (to < line.length && line[to] !== ch) to += ch === '"' && line[to] === "\\" ? 2 : 1;
      push(Math.min(to + 1, line.length), "string");
    } else if (ch === "$") {
      let to = at + 1;
      if (line[to] === "{" || line[to] === "(") {
        const close = line[to] === "{" ? "}" : ")";
        let depth = 0;
        for (; to < line.length; to += 1) {
          if (line[to] === line[at + 1]) depth += 1;
          else if (line[to] === close && --depth === 0) {
            to += 1;
            break;
          }
        }
      } else while (to < line.length && /[\w?@#*!$-]/.test(line[to]!) && (to === at + 1 || /\w/.test(line[to]!))) to += 1;
      push(to, "var");
    } else {
      const op = OPERATORS.find(candidate => line.startsWith(candidate, at));
      if (op) push(at + op.length, "op");
      else {
        let to = at;
        while (to < line.length && !/[\s'"$|&;<>()]/.test(line[to]!)) to += line[to] === "\\" ? 2 : 1;
        push(Math.max(to, at + 1), "word");
      }
    }
  }
  return out;
}

export interface ShellRun {
  running: boolean;
  failed: boolean;
  /** `0.4s`, shown at the row's end once the run is over. */
  took?: string;
}

/** The presentation of `script` for a `shell` node. */
export function shellPresentation(script: string, run: ShellRun, prefs: ShellPrefs): Record<string, unknown> {
  const state = run.running ? "running" : run.failed ? "fail" : "ok";
  const rows: Row[] = [];
  let offset = 0;
  let node = 0;
  const lines = script.split("\n");
  lines.forEach((line, index) => {
    const tokens = tokenize(line, offset);
    const segments: Segment[] = [];
    const effects: Row["effects"] = [];
    let expectCommand = true;
    let embed: { flag: string; language: string } | undefined;
    let armed = false;
    for (const token of tokens) {
      const id = `pi:${index + 1}:${++node}`;
      const range: [number, number] = [token.from, token.from + token.text.length];
      let style: string | undefined;
      if (token.kind === "space") style = undefined;
      else if (token.kind === "comment") style = "comment";
      else if (token.kind === "op") {
        style = "op";
        expectCommand = !/^[<>]|^2>&1$|^&>$/.test(token.text);
        embed = undefined;
      } else if (token.kind === "var") style = "var";
      else if (token.kind === "string") {
        // In the Pseudo view a script handed to an interpreter is shown as that language, unquoted.
        if (armed && embed && prefs.view === "pseudo" && token.text.length >= 2) {
          segments.push({ text: "‹", style: "emb", node: id, range });
          segments.push({ text: token.text.slice(1, -1), node: id, range, language: embed.language });
          segments.push({ text: "›", style: "emb", node: id, range });
          armed = false;
          continue;
        }
        style = "str";
      } else if (expectCommand && KEYWORDS.has(token.text)) style = "kw";
      else if (expectCommand && /^\w+=/.test(token.text)) style = "var";
      else if (expectCommand) {
        style = "cmd";
        expectCommand = false;
        const name = token.text.split("/").at(-1) ?? token.text;
        embed = EMBEDDED[name];
        for (const [pattern, effect] of EFFECTS) if (pattern.test(name) && !effects.some(known => known.kind === effect.kind)) effects.push(effect);
      } else if (token.text.startsWith("-")) {
        style = "arg";
        armed = Boolean(embed && token.text === embed.flag);
      } else if (/^\d+$/.test(token.text)) style = "num";
      else if (/[/.~]/.test(token.text)) style = "path";
      segments.push({ text: token.text, ...(style && prefs.color ? { style } : style === "emb" ? { style } : {}), node: id, range, ...(token.kind === "space" || run.running ? {} : { state }) });
      if (token.kind !== "space" && token.kind !== "string") armed = armed && token.text === embed?.flag;
    }
    rows.push({
      id: `row-pi:${index + 1}`,
      depth: 0,
      node: `pi:${index + 1}:0`,
      range: [offset, offset + line.length],
      active: run.running,
      role: "stmt",
      ...(run.running ? {} : { state }),
      segments,
      effects: prefs.color ? effects : [],
      ...(run.took && index === lines.length - 1 ? { meta: run.took } : {}),
      detail: line,
    });
    offset += line.length + 1;
  });
  return {
    preferences: { view: prefs.view, layers: { color: prefs.color, inline: true, idioms: true, effects: true, unwrap: true }, split: false, playing: false, speed: 1, expandedNodes: [] },
    rows,
    original: [],
    output: "",
    running: run.running,
    executing: run.running,
    watches: [],
    timeline: { length: 0, cursor: 0, elapsedNs: 0, durationNs: 0 },
  };
}
