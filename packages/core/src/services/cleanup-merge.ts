/**
 * Merge policy for the cleanup cycle's consolidation candidates.
 *
 * This module is deliberately pure and LLM-free, and it lives in core rather
 * than in the sidecar for a security reason, not a testing one: consolidation
 * is applied through an HTTP route, so anything enforced only on the *producer*
 * side (the LLM caller) can be bypassed by a hand-made request. The apply path
 * calls computeMergedTags/validateMergeDraft itself, so the client can never
 * choose the merged entry's tags — in particular it can never inject the
 * `deprecated` or `keep` control tags and rig the next cycle.
 *
 * The LLM path and the deterministic fallback share these helpers so the two
 * can never drift apart.
 */

/** What a merge produces. Tags are NOT part of it — they are always derived. */
export interface MergeDraft {
  title: string;
  content: string;
}

/** The subset of an entry the merge helpers need. */
export interface MergeMember {
  id: string;
  title: string;
  content: string;
  tags: string[];
  updatedAt: Date | string;
}

/** Tags the cleanup cycle itself acts on — never carried into a merged entry. */
export const CLEANUP_CONTROL_TAGS = ['deprecated', 'keep'] as const;

export const MERGE_MAX_TITLE = 500;
export const MERGE_MAX_CONTENT = 100_000;
export const MERGE_MAX_TAGS = 20;
export const MERGE_MAX_TAG_LENGTH = 50;
/** Per-member cap when building the deterministic appendix. */
export const MERGE_APPENDIX_BUDGET = 50_000;

/**
 * Tags for the merged entry: the union across every member, minus the control
 * tags, normalised and capped.
 *
 * Dropping `deprecated` is what makes consolidation terminal — otherwise the
 * survivor would be re-proposed for deletion on the next cycle. Dropping `keep`
 * avoids silently making the survivor immortal because one member had it.
 */
export function computeMergedTags(members: MergeMember[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of members) {
    for (const raw of m.tags ?? []) {
      if (typeof raw !== 'string') continue;
      const tag = raw.trim().toLowerCase();
      if (!tag) continue;
      if (tag.length > MERGE_MAX_TAG_LENGTH) continue;
      if ((CLEANUP_CONTROL_TAGS as readonly string[]).includes(tag)) continue;
      if (seen.has(tag)) continue;
      seen.add(tag);
      out.push(tag);
      if (out.length >= MERGE_MAX_TAGS) return out;
    }
  }
  return out;
}

export class MergeDraftError extends Error {}

/**
 * Validate a draft coming from anywhere untrusted — the LLM, or a client POSTing
 * to the approve route. Returns the normalised draft; throws MergeDraftError.
 */
export function validateMergeDraft(draft: unknown): MergeDraft {
  if (!draft || typeof draft !== 'object') {
    throw new MergeDraftError('Draft must be an object with title and content');
  }
  const { title, content } = draft as Record<string, unknown>;
  if (typeof title !== 'string' || title.trim().length === 0) {
    throw new MergeDraftError('Draft title must be a non-empty string');
  }
  if (typeof content !== 'string' || content.trim().length === 0) {
    throw new MergeDraftError('Draft content must be a non-empty string');
  }
  if (title.length > MERGE_MAX_TITLE) {
    throw new MergeDraftError(`Draft title exceeds ${MERGE_MAX_TITLE} characters`);
  }
  if (content.length > MERGE_MAX_CONTENT) {
    throw new MergeDraftError(`Draft content exceeds ${MERGE_MAX_CONTENT} characters`);
  }
  return { title: title.trim(), content };
}

/**
 * Merge without a model: keep the canonical (newest) entry verbatim and append
 * the others under a clearly marked section.
 *
 * Used whenever Ollama is unavailable or returns something unusable. It loses no
 * information, which matters because the members are deleted afterwards — the
 * fallback must never be worse than doing nothing.
 *
 * `members[0]` MUST be the canonical; ordering is the caller's responsibility.
 */
export function deterministicMergeDraft(members: MergeMember[]): MergeDraft {
  if (members.length === 0) throw new MergeDraftError('Cannot merge an empty group');
  const [canonical, ...rest] = members;
  if (rest.length === 0) return { title: canonical.title, content: canonical.content };

  const parts: string[] = [canonical.content, '\n\n## Merged from duplicates\n'];
  let budget = MERGE_APPENDIX_BUDGET;
  let truncated = 0;

  for (const m of rest) {
    if (budget <= 0) { truncated++; continue; }
    const section = `\n### ${m.title}\n\n${m.content}\n`;
    if (section.length <= budget) {
      parts.push(section);
      budget -= section.length;
    } else {
      parts.push(`\n### ${m.title}\n\n${m.content.slice(0, Math.max(0, budget - m.title.length - 12))}\n[truncated]\n`);
      budget = 0;
    }
  }
  if (truncated > 0) {
    parts.push(`\n_[${truncated} further duplicate(s) omitted: merge size limit reached]_\n`);
  }

  const content = parts.join('');
  return {
    title: canonical.title,
    content: content.length > MERGE_MAX_CONTENT ? content.slice(0, MERGE_MAX_CONTENT) : content,
  };
}
