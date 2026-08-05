import { OllamaChatClient, DEFAULT_CHAT_MODEL, type ChatMessage } from '@cognistore/embeddings';
import { validateMergeDraft, deterministicMergeDraft, type MergeDraft, type MergeMember } from '@cognistore/core';

/**
 * Turns a group of duplicate entries into one merged draft, for the user to
 * review before anything is deleted.
 *
 * Only prompt construction and fallback orchestration live here. The rules the
 * result must satisfy (length limits, and above all which tags the merged entry
 * ends up with) live in @cognistore/core and are re-applied at apply time — a
 * draft produced here is a suggestion, never a trusted input.
 */

/** Per-member cap so a large group cannot blow the model's context window. */
const MEMBER_CONTENT_BUDGET = 8_000;

export interface MergeResult {
  draft: MergeDraft;
  /** False when the model was unavailable/unusable and the fallback ran. */
  usedLlm: boolean;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n[truncated]`;
}

function buildMessages(members: MergeMember[]): ChatMessage[] {
  const body = members
    .map((m, i) => {
      const age = i === 0 ? 'NEWEST — takes priority' : `older #${i}`;
      return `--- ENTRY ${i + 1} (${age})\nTitle: ${m.title}\nUpdated: ${new Date(m.updatedAt).toISOString()}\nContent:\n${truncate(m.content, MEMBER_CONTENT_BUDGET)}`;
    })
    .join('\n\n');

  return [
    {
      role: 'system',
      content:
        'You merge duplicate knowledge-base entries into ONE entry. ' +
        'The FIRST entry is the newest and takes priority whenever entries disagree. ' +
        'Preserve every unique technical fact, file path, function name and version number from all entries — ' +
        'losing information is worse than being verbose. Do not invent anything that is not in the entries. ' +
        'Reply with strict JSON only, exactly: {"title": string, "content": string}. ' +
        'Do not include tags, ids, commentary or markdown fences.',
    },
    { role: 'user', content: `Merge these ${members.length} duplicate entries:\n\n${body}` },
  ];
}

/**
 * Produce a merged draft, preferring the local model and falling back to a
 * deterministic concatenation.
 *
 * The fallback is not a degraded mode to be avoided — it loses no information,
 * which is what matters given the other members are deleted on approval. The
 * model only makes the result nicer to read.
 *
 * `members[0]` MUST be the canonical (newest) entry.
 */
export async function buildMergeDraft(
  members: MergeMember[],
  opts: { host?: string; model?: string; client?: OllamaChatClient } = {},
): Promise<MergeResult> {
  const fallback = () => ({ draft: deterministicMergeDraft(members), usedLlm: false });
  if (members.length < 2) return fallback();

  const client = opts.client ?? new OllamaChatClient({ host: opts.host, model: opts.model ?? DEFAULT_CHAT_MODEL });

  try {
    await client.ensureModel();
  } catch {
    // Model missing and the pull failed (offline, no disk, Ollama down).
    return fallback();
  }

  const messages = buildMessages(members);
  // One retry: `format: 'json'` still lets a small model emit a JSON document of
  // the wrong shape, and a second attempt usually lands.
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await client.chatJson(messages, { temperature: 0.2 });
    if (!raw) continue;
    try {
      // Core's validator, so the LLM path cannot be laxer than the apply path.
      return { draft: validateMergeDraft(raw), usedLlm: true };
    } catch {
      // Wrong shape or over the limits — try once more, then fall back.
    }
  }
  return fallback();
}
