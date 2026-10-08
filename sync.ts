import * as fs from "fs";
import * as path from "path";
import { randomBytes } from "crypto";

export const BEGIN = "<!-- ai-context-sync:begin -->";
export const END = "<!-- ai-context-sync:end -->";
export const CURSOR_HEADER = '---\ndescription: "Context synchronized from Obsidian"\nalwaysApply: true\n---\n\n';

export interface Target {
  id: string;
  name: string;
  outputPath: string;
  dedicated?: boolean;
}

// Fixed destinations keep exported settings from turning into arbitrary paths.
export const TARGETS: readonly Target[] = [
  { id: "claude", name: "Claude Code", outputPath: "CLAUDE.md" },
  { id: "agents", name: "Codex / AGENTS.md", outputPath: "AGENTS.md" },
  { id: "copilot", name: "GitHub Copilot", outputPath: ".github/copilot-instructions.md" },
  { id: "cursor-rules", name: "Cursor Agent", outputPath: ".cursor/rules/ai-context-sync.mdc", dedicated: true },
];

export interface RenderOptions {
  source: string;
  header: string;
  timestamp?: string;
  sourceAbsolutePath?: string;
}

export interface PlannedWrite {
  root: string;
  target: Target;
  destination: string;
  previous: string | null;
  next: string;
}

export function renderTemplate(template: string, variables: Record<string, string>): string {
  // Callback replacements are literal, and inserted values are never rescanned.
  return template.replace(/\{\{(CONTENT|HEADER|TIMESTAMP|SOURCE)\}\}/g,
    (token, key: string) => variables[key] ?? token);
}

function hasMarker(value: string): boolean {
  return value.includes(BEGIN) || value.includes(END);
}

export function updateManagedRegion(previous: string | null, body: string, dedicated = false): string {
  if (hasMarker(body)) throw new Error("Source or header contains reserved AI Context Sync markers.");
  const block = `${BEGIN}\n${body}\n${END}`;
  if (previous === null) return `${dedicated ? CURSOR_HEADER : ""}${block}\n`;
  const start = previous.indexOf(BEGIN);
  const end = previous.indexOf(END);
  if (start < 0 && end < 0) {
    if (dedicated) throw new Error("The dedicated Cursor rule already exists without AI Context Sync markers. Choose another project or move that rule manually.");
    return previous + (previous.length ? (previous.endsWith("\n") ? "\n" : "\n\n") : "") + block + "\n";
  }
  if (start < 0 || end < start || previous.indexOf(BEGIN, start + BEGIN.length) >= 0 || previous.indexOf(END, end + END.length) >= 0) {
    throw new Error("Malformed or duplicate AI Context Sync markers; repair the file manually before syncing.");
  }
  // Reject marker text embedded in prose/code rather than complete marker lines.
  if ((start > 0 && previous[start - 1] !== "\n") || previous[start + BEGIN.length] !== "\n" ||
      (end > 0 && previous[end - 1] !== "\n") ||
      (end + END.length < previous.length && !["\n", "\r"].includes(previous[end + END.length]))) {
    throw new Error("AI Context Sync markers must occupy complete lines.");
  }
  if (dedicated && !previous.startsWith(CURSOR_HEADER)) {
    throw new Error("The dedicated Cursor rule header changed; restore its documented frontmatter before syncing.");
  }
  return previous.slice(0, start) + block + previous.slice(end + END.length);
}

export function validateProjectRoot(input: string): string {
  if (!input || !path.isAbsolute(input)) throw new Error("Project paths must be existing absolute directories (expand ~ first).");
  let root: string;
  try {
    root = fs.realpathSync(input);
    if (!fs.statSync(root).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new Error(`Project directory does not exist: ${input}`);
  }
  return root;
}

function fileState(destination: string): string | null {
  try {
    const stat = fs.lstatSync(destination);
    if (stat.isSymbolicLink()) throw new Error(`Refusing symlink destination: ${destination}`);
    if (!stat.isFile()) throw new Error(`Destination is not a regular file: ${destination}`);
    if (stat.nlink !== 1) throw new Error(`Refusing hard-linked destination: ${destination}`);
    const bytes = fs.readFileSync(destination);
    const text = bytes.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(bytes)) throw new Error(`Destination is not valid UTF-8: ${destination}`);
    return text;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function safeDestination(root: string, relative: string, createDirectories = false): string {
  if (validateProjectRoot(root) !== root || fs.lstatSync(root).isSymbolicLink()) throw new Error(`Project root changed or became a symlink: ${root}`);
  const destination = path.resolve(root, relative);
  const rel = path.relative(root, destination);
  if (!rel || rel.startsWith(`..${path.sep}`) || rel === ".." || path.isAbsolute(rel)) {
    throw new Error("Destination must remain inside its project directory.");
  }
  const parts = rel.split(path.sep);
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    let stat: fs.Stats;
    try { stat = fs.lstatSync(current); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (!createDirectories) continue;
      fs.mkdirSync(current, { mode: 0o700 });
      stat = fs.lstatSync(current);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Refusing symlink or non-directory parent: ${current}`);
  }
  fileState(destination);
  return destination;
}

function identity(input: string): string {
  return process.platform === "darwin" || process.platform === "win32" ? input.toLowerCase() : input;
}

export function planSync(projectPaths: readonly string[], targetIds: readonly string[], content: string, options: RenderOptions): PlannedWrite[] {
  if (!projectPaths.length) throw new Error("Add an existing project directory first; the vault root is never selected implicitly.");
  if (!targetIds.length) throw new Error("Enable at least one sync target first.");
  const targets = targetIds.map(id => {
    const target = TARGETS.find(item => item.id === id);
    if (!target) throw new Error(`Unsupported sync target: ${id}`);
    return target;
  });
  const header = renderTemplate(options.header, { TIMESTAMP: options.timestamp ?? "", SOURCE: options.source });
  const body = renderTemplate(header ? "{{HEADER}}\n\n{{CONTENT}}" : "{{CONTENT}}", { HEADER: header, CONTENT: content });
  if (hasMarker(body)) throw new Error("Source or header contains reserved AI Context Sync markers.");
  const source = options.sourceAbsolutePath ? fs.realpathSync(options.sourceAbsolutePath) : null;
  const roots = projectPaths.map(validateProjectRoot);
  const seen = new Set<string>();
  const plan: PlannedWrite[] = [];
  for (const root of roots) {
    for (const target of targets) {
      const destination = safeDestination(root, target.outputPath);
      const key = identity(destination);
      if (seen.has(key)) throw new Error(`Duplicate sync destination: ${destination}`);
      seen.add(key);
      if (source && identity(source) === key) throw new Error("A sync destination is also the source note; choose a separate source.");
      const previous = fileState(destination);
      plan.push({ root, target, destination, previous, next: updateManagedRegion(previous, body, target.dedicated) });
    }
  }
  return plan;
}

function checkUnchanged(item: PlannedWrite): void {
  const current = safeDestination(item.root, item.target.outputPath);
  if (current !== item.destination || fileState(current) !== item.previous) {
    throw new Error(`Destination changed after preview: ${item.destination}. Sync again after reviewing it.`);
  }
}

export function applyPlan(plan: readonly PlannedWrite[]): number {
  // Validate every destination before the first write. Each file is replaced
  // atomically; this is not a transaction across several files or projects.
  for (const item of plan) checkUnchanged(item);
  let changed = 0;
  for (const item of plan) {
    if (item.previous === item.next) continue;
    safeDestination(item.root, item.target.outputPath, true);
    checkUnchanged(item);
    const temporary = path.join(path.dirname(item.destination), `.ai-context-sync-${randomBytes(12).toString("hex")}.tmp`);
    const mode = item.previous === null ? 0o600 : fs.statSync(item.destination).mode & 0o777;
    let created = false;
    try {
      const fd = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, mode);
      created = true;
      try { fs.fchmodSync(fd, mode); fs.writeFileSync(fd, item.next, "utf8"); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      checkUnchanged(item);
      fs.renameSync(temporary, item.destination);
      created = false;
      changed++;
    } finally {
      if (created) fs.unlinkSync(temporary);
    }
  }
  return changed;
}

export class SyncQueue {
  private tail: Promise<unknown> = Promise.resolve();
  enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.tail.then(task);
    this.tail = next.catch(() => undefined);
    return next;
  }
}
