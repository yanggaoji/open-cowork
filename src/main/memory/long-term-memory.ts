import type { MessageRole } from '../../renderer/types';

export interface LongTermMemoryCandidate {
  sessionId: string;
  sessionTitle: string;
  role: Extract<MessageRole, 'user' | 'assistant'>;
  text: string;
  timestamp: number;
}

interface BuildLongTermMemoryOptions {
  now?: number;
  maxEntries?: number;
  maxSnippetLength?: number;
  maxTotalChars?: number;
}

const LATIN_TOKEN_REGEX = /[a-z0-9][a-z0-9_-]{2,31}/gi;
const CJK_TOKEN_REGEX = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]{2,}/g;
const STOP_WORDS = new Set([
  'about',
  'after',
  'before',
  'continue',
  'from',
  'have',
  'into',
  'login',
  'please',
  'that',
  'the',
  'then',
  'this',
  'with',
]);

function extractSearchTerms(text: string): string[] {
  const terms = new Set<string>();
  const latinTokens = text.match(LATIN_TOKEN_REGEX) ?? [];
  for (const token of latinTokens) {
    const normalized = token.toLowerCase();
    if (!STOP_WORDS.has(normalized)) {
      terms.add(normalized);
    }
  }

  const cjkTokens = text.match(CJK_TOKEN_REGEX) ?? [];
  for (const token of cjkTokens) {
    const normalized = token.trim();
    if (normalized.length < 2) continue;
    if (normalized.length <= 8) {
      terms.add(normalized);
    }
    for (let index = 0; index < normalized.length - 1; index++) {
      terms.add(normalized.slice(index, index + 2));
    }
  }

  return Array.from(terms);
}

function truncateSnippet(text: string, maxLength: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

export function buildLongTermMemoryContext(
  prompt: string,
  candidates: LongTermMemoryCandidate[],
  options: BuildLongTermMemoryOptions = {}
): string | null {
  const maxEntries = options.maxEntries ?? 6;
  const maxSnippetLength = options.maxSnippetLength ?? 220;
  const maxTotalChars = options.maxTotalChars ?? 2400;
  const now = options.now ?? Date.now();
  const searchTerms = extractSearchTerms(prompt);

  const normalizedCandidates = candidates
    .map((candidate) => {
      const snippet = truncateSnippet(candidate.text, maxSnippetLength);
      const searchableText = `${candidate.sessionTitle}\n${snippet}`.toLowerCase();
      const overlap = searchTerms.reduce(
        (score, term) => score + (searchableText.includes(term.toLowerCase()) ? 1 : 0),
        0
      );
      const ageDays = Math.max(0, (now - candidate.timestamp) / (1000 * 60 * 60 * 24));
      const recencyBoost = Math.max(0, 2 - ageDays / 14);
      const roleBoost = candidate.role === 'user' ? 0.35 : 0;

      return {
        ...candidate,
        snippet,
        overlap,
        score: overlap > 0 ? overlap * 10 + recencyBoost + roleBoost : recencyBoost + roleBoost,
      };
    })
    .filter((candidate) => candidate.snippet.length > 0)
    .sort((left, right) => right.score - left.score || right.timestamp - left.timestamp);

  if (normalizedCandidates.length === 0) {
    return null;
  }

  const relevantCandidates = normalizedCandidates.filter((candidate) => candidate.overlap > 0);
  const selectedPool = relevantCandidates.length > 0 ? relevantCandidates : normalizedCandidates;
  const entryLimit = relevantCandidates.length > 0 ? maxEntries : Math.min(maxEntries, 3);
  const selectedLines: string[] = [];
  const seen = new Set<string>();
  let totalChars = 0;

  for (const candidate of selectedPool) {
    const dedupeKey = `${candidate.sessionId}:${candidate.role}:${candidate.snippet.toLowerCase()}`;
    if (seen.has(dedupeKey)) {
      continue;
    }

    const line = `- [${candidate.sessionTitle}] ${candidate.role}: ${candidate.snippet}`;
    if (selectedLines.length > 0 && totalChars + line.length > maxTotalChars) {
      break;
    }

    seen.add(dedupeKey);
    selectedLines.push(line);
    totalChars += line.length;

    if (selectedLines.length >= entryLimit) {
      break;
    }
  }

  if (selectedLines.length === 0) {
    return null;
  }

  const intro =
    relevantCandidates.length > 0
      ? 'Relevant context remembered from earlier sessions in this workspace:'
      : 'Recent context remembered from earlier sessions in this workspace:';

  return [
    '<long_term_memory>',
    intro,
    ...selectedLines,
    'Only use this memory when it is relevant, and prefer the current workspace state if anything conflicts.',
    '</long_term_memory>',
  ].join('\n');
}
