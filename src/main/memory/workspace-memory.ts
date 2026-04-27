import * as fs from 'fs';
import * as path from 'path';
import type { Message } from '../../renderer/types';
import type { AppConfig } from '../config/config-store';
import { generateWorkspaceMemoryWithClaudeSdk } from '../claude/claude-sdk-one-shot';
import { log, logError, logWarn } from '../utils/logger';

export type WorkspaceMemoryCategory =
  | 'user_preference'
  | 'command_rule'
  | 'os'
  | 'environment'
  | 'dependency'
  | 'workflow'
  | 'constraint';

export interface WorkspaceMemoryEntry {
  category: WorkspaceMemoryCategory;
  content: string;
  updatedAt: number;
}

export interface WorkspaceMemoryDocument {
  version: 1;
  updatedAt: number;
  entries: WorkspaceMemoryEntry[];
}

export interface WorkspaceMemoryPromptContext {
  prompt: string;
  entryCount: number;
  filePath: string | null;
}

export interface WorkspaceMemoryReadOptions {
  category?: WorkspaceMemoryCategory;
  query?: string;
  limit?: number;
}

export interface WorkspaceMemoryWriteInput {
  category: WorkspaceMemoryCategory;
  content: string;
  updatedAt?: number;
}

interface WorkspaceMemoryUpdateInput {
  workspaceDir?: string;
  userMessage: Message;
  assistantMessages?: Message[];
  config: AppConfig;
}

interface WorkspaceSignals {
  hostOs: string;
  packageManager: string | null;
  ecosystems: string[];
}

const MEMORY_DIR = '.open-cowork';
const MEMORY_FILE = 'workspace-memory.json';
const MAX_ENTRIES = 12;
const MAX_ENTRY_CHARS = 140;
const MAX_MESSAGE_CHARS = 1400;
const MAX_PROMPT_CHARS = 2400;
const VALID_CATEGORIES = new Set<WorkspaceMemoryCategory>([
  'user_preference',
  'command_rule',
  'os',
  'environment',
  'dependency',
  'workflow',
  'constraint',
]);
const workspaceUpdateChains = new Map<string, Promise<void>>();

function canonicalizeWorkspaceDir(workspaceDir?: string): string | null {
  if (!workspaceDir || !workspaceDir.trim()) {
    return null;
  }

  const resolved = path.resolve(workspaceDir);
  if (!fs.existsSync(resolved)) {
    return null;
  }

  try {
    const nativeRealpath = fs.realpathSync.native;
    return typeof nativeRealpath === 'function'
      ? nativeRealpath(resolved)
      : fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

export function getWorkspaceMemoryPath(workspaceDir?: string): string | null {
  const canonicalWorkspaceDir = canonicalizeWorkspaceDir(workspaceDir);
  if (!canonicalWorkspaceDir) {
    return null;
  }
  return path.join(canonicalWorkspaceDir, MEMORY_DIR, MEMORY_FILE);
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function truncate(value: string, maxChars: number): string {
  const normalized = normalizeWhitespace(value);
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(1, maxChars - 3)).trimEnd()}...`;
}

function sanitizeEntry(entry: unknown): WorkspaceMemoryEntry | null {
  if (!entry || typeof entry !== 'object') {
    return null;
  }

  const candidate = entry as Partial<WorkspaceMemoryEntry>;
  if (!VALID_CATEGORIES.has(candidate.category as WorkspaceMemoryCategory)) {
    return null;
  }

  const content =
    typeof candidate.content === 'string' ? truncate(candidate.content, MAX_ENTRY_CHARS) : '';
  if (!content) {
    return null;
  }

  const updatedAt =
    typeof candidate.updatedAt === 'number' && Number.isFinite(candidate.updatedAt)
      ? candidate.updatedAt
      : Date.now();

  return {
    category: candidate.category as WorkspaceMemoryCategory,
    content,
    updatedAt,
  };
}

function dedupeEntries(entries: WorkspaceMemoryEntry[]): WorkspaceMemoryEntry[] {
  const deduped = new Map<string, WorkspaceMemoryEntry>();

  for (const entry of [...entries].sort((left, right) => right.updatedAt - left.updatedAt)) {
    const key = `${entry.category}:${entry.content.toLowerCase()}`;
    if (!deduped.has(key)) {
      deduped.set(key, entry);
    }
  }

  return Array.from(deduped.values())
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, MAX_ENTRIES);
}

function normalizeDocument(entries: WorkspaceMemoryEntry[]): WorkspaceMemoryDocument {
  const compactEntries = dedupeEntries(entries);
  const updatedAt = compactEntries[0]?.updatedAt ?? Date.now();
  return {
    version: 1,
    updatedAt,
    entries: compactEntries,
  };
}

function parseModelJson(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  const withoutFence = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const firstBrace = withoutFence.indexOf('{');
  const lastBrace = withoutFence.lastIndexOf('}');
  const candidate =
    firstBrace >= 0 && lastBrace > firstBrace
      ? withoutFence.slice(firstBrace, lastBrace + 1)
      : withoutFence;

  return JSON.parse(candidate);
}

function readWorkspaceMemoryDocumentByPath(filePath: string): WorkspaceMemoryDocument | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = parseModelJson(raw) as Partial<WorkspaceMemoryDocument> | null;
    const rawEntries = Array.isArray(parsed?.entries) ? parsed.entries : [];
    const entries = rawEntries
      .map(sanitizeEntry)
      .filter((entry): entry is WorkspaceMemoryEntry => Boolean(entry));
    return normalizeDocument(entries);
  } catch (error) {
    logWarn('[WorkspaceMemory] Failed to read workspace memory file, ignoring:', filePath, error);
    return null;
  }
}

export function readWorkspaceMemoryDocument(workspaceDir?: string): WorkspaceMemoryDocument | null {
  const filePath = getWorkspaceMemoryPath(workspaceDir);
  return filePath ? readWorkspaceMemoryDocumentByPath(filePath) : null;
}

function normalizeReadLimit(limit?: number): number {
  if (!Number.isFinite(limit)) {
    return MAX_ENTRIES;
  }

  return Math.max(1, Math.min(MAX_ENTRIES, Math.floor(limit as number)));
}

export function listWorkspaceMemoryEntries(
  workspaceDir?: string,
  options: WorkspaceMemoryReadOptions = {}
): WorkspaceMemoryEntry[] {
  const document = readWorkspaceMemoryDocument(workspaceDir);
  if (!document) {
    return [];
  }

  const normalizedQuery =
    typeof options.query === 'string' ? normalizeWhitespace(options.query).toLowerCase() : '';

  return document.entries
    .filter((entry) => {
      if (options.category && entry.category !== options.category) {
        return false;
      }
      if (!normalizedQuery) {
        return true;
      }

      return `${entry.category} ${entry.content}`.toLowerCase().includes(normalizedQuery);
    })
    .slice(0, normalizeReadLimit(options.limit));
}

export function saveWorkspaceMemoryEntries(
  workspaceDir: string | undefined,
  inputs: WorkspaceMemoryWriteInput[]
): WorkspaceMemoryDocument | null {
  const filePath = getWorkspaceMemoryPath(workspaceDir);
  if (!filePath) {
    return null;
  }

  const existingDocument = readWorkspaceMemoryDocumentByPath(filePath);
  const sanitizedEntries = inputs
    .map((input) =>
      sanitizeEntry({
        category: input.category,
        content: input.content,
        updatedAt: input.updatedAt ?? Date.now(),
      })
    )
    .filter((entry): entry is WorkspaceMemoryEntry => Boolean(entry));

  if (sanitizedEntries.length === 0) {
    return existingDocument;
  }

  const nextDocument = normalizeDocument([
    ...(existingDocument?.entries ?? []),
    ...sanitizedEntries,
  ]);
  writeWorkspaceMemory(filePath, nextDocument);
  log('[WorkspaceMemory] Saved memory entries:', filePath, 'entries:', nextDocument.entries.length);
  return nextDocument;
}

export function composeContextualPrompt(
  prompt: string,
  options: { workspaceMemoryPrompt?: string; conversationHistoryPrompt?: string }
): string {
  return [options.workspaceMemoryPrompt, options.conversationHistoryPrompt, prompt]
    .filter((section): section is string => Boolean(section && section.trim()))
    .join('\n\n');
}

export function getWorkspaceMemoryPromptContext(
  workspaceDir?: string
): WorkspaceMemoryPromptContext {
  const filePath = getWorkspaceMemoryPath(workspaceDir);
  if (!filePath) {
    return { prompt: '', entryCount: 0, filePath: null };
  }

  const document = readWorkspaceMemoryDocumentByPath(filePath);
  if (!document || document.entries.length === 0) {
    return { prompt: '', entryCount: 0, filePath };
  }

  const lines: string[] = [];
  let charCount = 0;

  for (const entry of document.entries) {
    const line = `- ${entry.category}: ${entry.content}`;
    if (charCount + line.length > MAX_PROMPT_CHARS) {
      break;
    }
    lines.push(line);
    charCount += line.length;
  }

  if (lines.length === 0) {
    return { prompt: '', entryCount: 0, filePath };
  }

  return {
    prompt: `<workspace_memory>\nShared long-term workspace memory. Use these notes when relevant, but let the user's current request override them if they conflict.\n${lines.join('\n')}\n</workspace_memory>`,
    entryCount: lines.length,
    filePath,
  };
}

function extractTextFromMessage(message?: Message): string {
  if (!message) {
    return '';
  }

  const text = message.content
    .filter(
      (block): block is Extract<Message['content'][number], { type: 'text' }> =>
        block.type === 'text'
    )
    .map((block) => block.text)
    .join('\n')
    .trim();

  return truncate(text, MAX_MESSAGE_CHARS);
}

function detectWorkspaceSignals(workspaceDir: string): WorkspaceSignals {
  const packageManager = fs.existsSync(path.join(workspaceDir, 'pnpm-lock.yaml'))
    ? 'pnpm'
    : fs.existsSync(path.join(workspaceDir, 'yarn.lock'))
      ? 'yarn'
      : fs.existsSync(path.join(workspaceDir, 'package-lock.json'))
        ? 'npm'
        : null;

  const ecosystems: string[] = [];
  if (fs.existsSync(path.join(workspaceDir, 'package.json'))) {
    ecosystems.push('node');
  }
  if (
    fs.existsSync(path.join(workspaceDir, 'pyproject.toml')) ||
    fs.existsSync(path.join(workspaceDir, 'requirements.txt'))
  ) {
    ecosystems.push('python');
  }
  if (fs.existsSync(path.join(workspaceDir, 'Cargo.toml'))) {
    ecosystems.push('rust');
  }
  if (fs.existsSync(path.join(workspaceDir, 'go.mod'))) {
    ecosystems.push('go');
  }

  return {
    hostOs: process.platform,
    packageManager,
    ecosystems,
  };
}

function buildUpdatePrompt(
  existingDocument: WorkspaceMemoryDocument | null,
  userText: string,
  assistantText: string,
  signals: WorkspaceSignals
): string {
  const existingEntries = existingDocument?.entries ?? [];
  return [
    'Maintain the shared long-term memory for this workspace.',
    '',
    'Existing memory JSON:',
    JSON.stringify({ entries: existingEntries }, null, 2),
    '',
    'Workspace signals:',
    JSON.stringify(signals, null, 2),
    '',
    'Recent turn:',
    `<user>${userText || '[empty]'}</user>`,
    `<assistant>${assistantText || '[empty]'}</assistant>`,
    '',
    'Keep only durable, reusable facts that will help future sessions in this workspace, such as:',
    '- stable user preferences or special requirements',
    '- command or shell conventions that should be followed again',
    '- operating system or environment constraints',
    '- dependency, toolchain, or package-manager facts that matter repeatedly',
    '- repo-specific workflow rules or recurring pitfalls',
    '',
    'Do not keep:',
    '- one-off tasks or temporary plans',
    '- secrets, tokens, or credentials',
    '- large excerpts or redundant restatements',
    '- guesses that were not confirmed',
    '',
    'Return strict JSON only with this schema:',
    '{"entries":[{"category":"user_preference|command_rule|os|environment|dependency|workflow|constraint","content":"concise fact"}]}',
    '',
    `Rules: maximum ${MAX_ENTRIES} entries total; each content string maximum ${MAX_ENTRY_CHARS} characters; merge duplicates; keep the most useful facts first.`,
  ].join('\n');
}

function writeWorkspaceMemory(filePath: string, document: WorkspaceMemoryDocument): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
}

async function performWorkspaceMemoryUpdate(
  canonicalWorkspaceDir: string,
  input: WorkspaceMemoryUpdateInput
): Promise<void> {
  const filePath = getWorkspaceMemoryPath(canonicalWorkspaceDir);
  if (!filePath) {
    return;
  }

  const userText = extractTextFromMessage(input.userMessage);
  const assistantText = truncate(
    (input.assistantMessages ?? [])
      .map((message) => extractTextFromMessage(message))
      .filter(Boolean)
      .join('\n\n'),
    MAX_MESSAGE_CHARS
  );

  if (!userText && !assistantText) {
    return;
  }

  const existingDocument = readWorkspaceMemoryDocumentByPath(filePath);
  const prompt = buildUpdatePrompt(
    existingDocument,
    userText,
    assistantText,
    detectWorkspaceSignals(canonicalWorkspaceDir)
  );
  const rawResponse = await generateWorkspaceMemoryWithClaudeSdk(prompt, input.config);

  if (!rawResponse) {
    return;
  }

  try {
    const parsed = parseModelJson(rawResponse) as { entries?: unknown[] } | null;
    const nextEntries = Array.isArray(parsed?.entries)
      ? parsed.entries
          .map(sanitizeEntry)
          .filter((entry): entry is WorkspaceMemoryEntry => Boolean(entry))
      : [];
    const nextDocument = normalizeDocument(nextEntries);
    const currentSerialized = JSON.stringify(existingDocument?.entries ?? []);
    const nextSerialized = JSON.stringify(nextDocument.entries);

    if (currentSerialized === nextSerialized && existingDocument) {
      return;
    }

    writeWorkspaceMemory(filePath, nextDocument);
    log(
      '[WorkspaceMemory] Updated workspace memory:',
      filePath,
      'entries:',
      nextDocument.entries.length
    );
  } catch (error) {
    logError('[WorkspaceMemory] Failed to parse or write workspace memory update:', error);
  }
}

export function scheduleWorkspaceMemoryUpdate(input: WorkspaceMemoryUpdateInput): Promise<void> {
  const canonicalWorkspaceDir = canonicalizeWorkspaceDir(input.workspaceDir);
  if (!canonicalWorkspaceDir) {
    return Promise.resolve();
  }

  const previous = workspaceUpdateChains.get(canonicalWorkspaceDir) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(() => performWorkspaceMemoryUpdate(canonicalWorkspaceDir, input));

  workspaceUpdateChains.set(canonicalWorkspaceDir, next);

  return next.finally(() => {
    if (workspaceUpdateChains.get(canonicalWorkspaceDir) === next) {
      workspaceUpdateChains.delete(canonicalWorkspaceDir);
    }
  });
}
