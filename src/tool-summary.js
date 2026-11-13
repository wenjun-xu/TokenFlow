"use strict";

/** @param {unknown} value @returns {string | null} */
export function safeLabel(value) {
  return typeof value === "string" && !/[\u0000-\u001f\u007f\u2028-\u202e]|:\/\/|authorization|bearer\s|password|passwd|secret|api[_-]?key|access[_-]?token|github_pat_|gh[pousr]_|sk-[a-z0-9_-]{16,}|(?:AKIA|ASIA)[a-z0-9]{16}|AIza[a-z0-9_-]{30,}|eyJ[a-z0-9_-]{10,}\./i.test(value)
    ? value.trim() : null;
}

/** @param {{name?: unknown, arguments?: unknown}} tool @returns {string} */
export function toolSynopsis(tool) {
  if (tool.arguments === null || tool.arguments === undefined || tool.arguments === "") return "Arguments not recorded";
  if (typeof tool.arguments !== "string") return "Argument format cannot be summarized";
  if (tool.arguments.length > 65536) return "Arguments are too long; expand to view";
  let args;
  try { args = JSON.parse(tool.arguments); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return "Argument format cannot be summarized";
  }
  if (args === null) return "Arguments not recorded";
  if (typeof args !== "object" || Array.isArray(args)) return "Argument format cannot be summarized";
  const file = value => {
    const path = safeLabel(value);
    return path && !/[?#:]/.test(path) ? path.replace(/\\/g, "/").split("/").filter(Boolean).slice(-2).join("/") : null;
  };
  const type = typeof tool.name === "string" ? tool.name.split(/[.:]/).at(-1) : "";
  let summary = "Expand to view arguments";
  if (type === "skill") {
    const skill = safeLabel(args.skill);
    summary = skill && /^[\p{L}\p{N}_:./-]+$/u.test(skill) ? "Load " + skill : "Load skill (name not shown)";
  } else if (type === "view") {
    const path = file(args.path), range = args.view_range;
    summary = path ? "View " + path : "View file";
    if (Array.isArray(range) && range.length === 2 && Number.isSafeInteger(range[0]) && range[0] > 0
      && Number.isSafeInteger(range[1]) && (range[1] === -1 || range[1] >= range[0])) {
      summary += range[1] === -1 ? ` · Line ${range[0]} to end` : ` · Lines ${range[0]}–${range[1]}`;
    }
  } else if (type === "rg") {
    const pattern = safeLabel(args.pattern), path = file(Array.isArray(args.paths) ? args.paths[0] : args.paths);
    summary = pattern && /^[\p{L}_][\p{L}\p{N}_.| -]*$/u.test(pattern) ? "Search " + pattern : "Search content" + (path ? " · " + path : "");
  } else if (type === "glob") {
    const pattern = safeLabel(args.pattern);
    summary = pattern && !/[:="'<>]/.test(pattern) ? "Find " + pattern : "Find files";
  } else if (type === "bash") {
    const tokens = typeof args.command === "string" ? args.command.split(/\r?\n/, 1)[0].trim().split(/\s+/) : [];
    let executable = tokens.shift();
    if (executable?.split("/").at(-1) === "rtk") {
      if (tokens[0] === "bypass") tokens.shift();
      executable = tokens.shift();
    }
    const command = executable?.split("/").at(-1);
    const commands = {
      bun: ["test", "build", "install", "run"], npm: ["test", "run", "install", "ci"], pnpm: ["test", "run", "install"], yarn: ["test", "build", "install"],
      git: ["status", "diff", "log", "show", "add", "commit", "push", "fetch", "branch", "switch", "merge"],
      go: ["test", "build", "run"], cargo: ["test", "build", "check"], node: [], python: [], python3: [], ruby: [],
      curl: [], sh: [], bash: [], rg: [], cp: [], ls: [], mkdir: [], chmod: [], codesign: [],
    };
    summary = executable && /^[a-zA-Z0-9_./-]+$/.test(executable) && Object.hasOwn(commands, command)
      ? "Command " + command + (commands[command].includes(tokens[0]) ? " " + tokens[0] : "") : "Run command";
  } else if (type === "parallel" && Array.isArray(args.tool_uses)) {
    const names = args.tool_uses.map(call => safeLabel(call?.recipient_name)).filter(name => name && /^[a-zA-Z][\w:.-]*$/.test(name));
    summary = "Parallel " + names.slice(0, 2).join(", ") + ` · ${args.tool_uses.length} tools total`;
  } else if (type === "apply_patch") summary = "Apply patch";
  const characters = Array.from(summary);
  return characters.length > 60 ? characters.slice(0, 60).join("") + "…" : summary;
}
