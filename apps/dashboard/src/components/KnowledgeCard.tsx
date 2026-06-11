import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api } from '../api/client.js';

interface RelatedPlan {
  planId: string;
  relationType: string;
  title: string;
  status: string;
}

const PLAN_STATUS_COLORS: Record<string, string> = {
  draft: '#6b7280',
  active: '#3b82f6',
  completed: '#22c55e',
  archived: '#a78bfa',
};

export interface KnowledgeCardProps {
  entry: Record<string, unknown>;
  similarity?: number;
  onDelete: (id: string) => void;
  onTagClick: (tag: string) => void;
  onEdit?: (entry: Record<string, unknown>) => void;
  selected?: boolean;
  onToggleSelect?: (id: string) => void;
}

export function KnowledgeCard({
  entry,
  similarity,
  onDelete,
  onTagClick,
  onEdit,
  selected,
  onToggleSelect,
}: KnowledgeCardProps) {
  const { t } = useTranslation();
  const [relatedPlans, setRelatedPlans] = useState<RelatedPlan[]>([]);

  useEffect(() => {
    const id = entry.id as string;
    if (id) {
      api.getKnowledgePlans(id).then(setRelatedPlans).catch(() => setRelatedPlans([]));
    }
  }, [entry.id]);

  const showSimilarity = similarity !== undefined;
  const simPercent = showSimilarity ? Math.round(similarity * 100) : 0;
  const color =
    simPercent >= 80 ? 'var(--success)' : simPercent >= 60 ? 'var(--warning)' : 'var(--error)';

  return (
    <div
      key={entry.id as string}
      onClick={() => onEdit?.(entry)}
      style={{
        backgroundColor: 'var(--bg-card)',
        borderRadius: 10,
        border: selected ? '1px solid var(--accent)' : '1px solid var(--border)',
        padding: 16,
        marginBottom: 12,
        cursor: onEdit ? 'pointer' : 'default',
        transition: 'border-color 0.15s',
        display: 'flex',
        gap: onToggleSelect ? 12 : 0,
      }}
      onMouseEnter={(e) => onEdit && (e.currentTarget.style.borderColor = 'var(--accent)')}
      onMouseLeave={(e) => onEdit && !selected && (e.currentTarget.style.borderColor = 'var(--border)')}
    >
      {onToggleSelect && (
        <div style={{ paddingTop: 2, flexShrink: 0 }}>
          <input
            type="checkbox"
            checked={selected || false}
            onChange={(e) => { e.stopPropagation(); onToggleSelect(entry.id as string); }}
            onClick={(e) => e.stopPropagation()}
            style={{ width: 16, height: 16, cursor: 'pointer', accentColor: 'var(--accent)' }}
          />
        </div>
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'start',
          marginBottom: 8,
        }}
      >
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {showSimilarity && (
            <span
              style={{
                backgroundColor: color,
                color: '#fff',
                padding: '2px 8px',
                borderRadius: 12,
                fontSize: 12,
                fontWeight: 700,
              }}
            >
              {simPercent}%
            </span>
          )}
          <span
            style={{
              backgroundColor: 'var(--accent)',
              color: '#fff',
              padding: '2px 8px',
              borderRadius: 12,
              fontSize: 11,
            }}
          >
            {t(`types.${entry.type as string}`)}
          </span>
          <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>
            {entry.scope as string}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          <button
            onClick={(e) => { e.stopPropagation(); onDelete(entry.id as string); }}
            title={t('actions.delete')}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              width: 28, height: 28, borderRadius: 6, border: 'none',
              backgroundColor: '#ef4444', cursor: 'pointer',
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 6h18" />
              <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
            </svg>
          </button>
        </div>
      </div>

      {(entry.title as string) && (
        <h4 style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>
          {entry.title as string}
        </h4>
      )}
      <div
        className="plan-markdown"
        style={{
          color: 'var(--text-primary)',
          fontSize: 13,
          lineHeight: 1.5,
          marginBottom: 8,
          opacity: (entry.title as string) ? 0.7 : 1,
          maxHeight: 80,
          overflow: 'hidden',
        }}
      >
        <Markdown remarkPlugins={[remarkGfm]}>{(entry.content as string).substring(0, 300)}</Markdown>
      </div>

      <div
        style={{
          display: 'flex',
          gap: 6,
          flexWrap: 'wrap',
          marginBottom: 6,
        }}
      >
        {((entry.tags as string[]) ?? []).map((tag) => (
          <button
            key={tag}
            onClick={(e) => { e.stopPropagation(); onTagClick(tag); }}
            style={{
              backgroundColor: 'var(--bg-input)',
              color: 'var(--accent)',
              padding: '2px 8px',
              borderRadius: 10,
              fontSize: 11,
              background: 'none',
              border: 'none',
              cursor: 'pointer',
            }}
          >
            {tag}
          </button>
        ))}
      </div>

      {relatedPlans.length > 0 && (
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 6 }}>
          {relatedPlans.map((p) => (
            <a
              key={`${p.planId}-${p.relationType}`}
              href={`/plans?select=${p.planId}`}
              onClick={(e) => { e.stopPropagation(); }}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 4,
                padding: '2px 8px', borderRadius: 4, fontSize: 10,
                backgroundColor: 'rgba(99,102,241,0.1)',
                color: 'var(--accent)', textDecoration: 'none',
                border: `1px solid ${PLAN_STATUS_COLORS[p.status] || '#6b7280'}44`,
              }}
              title={`${p.relationType === 'input' ? t('plans.input') : t('plans.output')} — ${p.title}`}
            >
              <span style={{
                width: 6, height: 6, borderRadius: '50%',
                backgroundColor: PLAN_STATUS_COLORS[p.status] || '#6b7280',
                flexShrink: 0,
              }} />
              {p.title.length > 40 ? p.title.slice(0, 40) + '…' : p.title}
              <span style={{ opacity: 0.6 }}>({p.relationType === 'input' ? '←' : '→'})</span>
            </a>
          ))}
        </div>
      )}

      <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
        v{entry.version as number} •{' '}
        {entry.agentId ? `Agent: ${entry.agentId} • ` : ''}
        {new Date(entry.createdAt as string).toLocaleDateString()}
        {!!entry.updatedAt && entry.updatedAt !== entry.createdAt && (
          <> • updated {new Date(entry.updatedAt as string).toLocaleDateString()}</>
        )}
      </div>
      </div>
    </div>
  );
}
