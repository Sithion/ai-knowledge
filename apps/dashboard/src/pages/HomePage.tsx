import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams, useLocation } from 'react-router-dom';
import { api, type ExternalSection } from '../api/client.js';
import { useInfiniteList, PAGE_SIZE } from '../hooks/useInfiniteScroll.js';
import { KnowledgeCard } from '../components/KnowledgeCard.js';
import { TagBar } from '../components/TagBar.js';
import { KnowledgeModal } from '../components/KnowledgeModal.js';
import { FloatingAddButton } from '../components/FloatingAddButton.js';
import { ConfirmModal } from '../components/ConfirmModal.js';

const STATUS_COLORS: Record<string, string> = {
  draft: '#6b7280',
  active: '#3b82f6',
  completed: '#22c55e',
  archived: '#a78bfa',
};

const POLL_INTERVAL_MS = 5_000;

interface RelatedPlan {
  planId: string;
  relationType: string;
  title: string;
  status: string;
}

export function HomePage() {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();

  // Search state
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [scopeFilter, setScopeFilter] = useState('');

  // External knowledge providers (additive federated search; local list is unaffected)
  const [externalSections, setExternalSections] = useState<ExternalSection[]>([]);
  const [externalEnabled, setExternalEnabled] = useState(false);
  const [searchingExt, setSearchingExt] = useState(false);

  // Tag state
  const [allTags, setAllTags] = useState<string[]>([]);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);

  // Available scopes (from stats API)
  const [allScopes, setAllScopes] = useState<string[]>([]);

  // Modal state
  const [showModal, setShowModal] = useState(false);
  const [editingEntry, setEditingEntry] = useState<Record<string, unknown> | null>(null);

  // Polling state — track both count and lastUpdatedAt for cross-process detection
  const lastSnapshotRef = useRef<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const types = ['decision', 'pattern', 'fix', 'constraint', 'gotcha'];

  const hasActiveFilters = typeFilter !== '' || scopeFilter !== '' || selectedTags.length > 0 || query.trim() !== '';

  const tagsKey = selectedTags.join(',');
  const searchMode = query.trim().length > 0;

  // BROWSE mode (empty search box): infinite-scroll over the WHOLE base, filtered
  // server-side by type/scope/tags. In SEARCH mode the fetcher no-ops so the list
  // is empty (search results render from `searchResults` below).
  const browse = useInfiniteList<Record<string, unknown>>(
    (offset) => {
      if (searchMode) return Promise.resolve([]);
      const filters: { type?: string; scope?: string; tags?: string[] } = {};
      if (typeFilter) filters.type = typeFilter;
      if (scopeFilter) filters.scope = scopeFilter;
      if (selectedTags.length) filters.tags = selectedTags;
      return api.listRecent(PAGE_SIZE, filters, offset) as Promise<Record<string, unknown>[]>;
    },
    [typeFilter, scopeFilter, tagsKey, searchMode],
  );

  // SEARCH mode (non-empty box): semantic search, filters applied server-side.
  // api.search returns SearchResult[] ({entry,similarity}) — normalize to entries.
  const [searchResults, setSearchResults] = useState<Record<string, unknown>[]>([]);
  const [searchingLocal, setSearchingLocal] = useState(false);
  useEffect(() => {
    const term = query.trim();
    if (!term) { setSearchResults([]); setSearchingLocal(false); return; }
    let cancelled = false;
    setSearchingLocal(true);
    const handle = setTimeout(() => {
      const opts: Record<string, unknown> = { limit: 50 };
      if (typeFilter) opts.type = typeFilter;
      if (scopeFilter) opts.scope = scopeFilter;
      if (selectedTags.length) opts.tags = selectedTags;
      opts.threshold = 0;
      api.search(term, opts)
        .then((res: any) => {
          if (cancelled) return;
          const list = Array.isArray(res) ? res : (res?.local ?? []);
          setSearchResults(list.map((r: any) => (r && r.entry ? r.entry : r)));
        })
        .catch(() => { if (!cancelled) setSearchResults([]); })
        .finally(() => { if (!cancelled) setSearchingLocal(false); });
    }, 350);
    return () => { cancelled = true; clearTimeout(handle); };
  }, [query, typeFilter, scopeFilter, tagsKey]);

  // Entries to render: search results in search mode, else the infinite browse list.
  // Keep the defensive `type !== 'plan'` exclusion (plans have their own page).
  const displayedEntries = (searchMode ? searchResults : browse.items)
    .filter((e) => (e as any).type !== 'plan');

  // Load tags (silent)
  const loadTags = useCallback(() => {
    return api.listTags().then(setAllTags).catch(() => {});
  }, []);

  // Load available scopes
  const loadScopes = useCallback(() => {
    return (api.getStats() as Promise<{ byScope: { scope: string }[] }>)
      .then(stats => setAllScopes(stats.byScope.map(s => s.scope)))
      .catch(() => {});
  }, []);

  // Initial load on mount (tags + scopes; the browse list loads itself)
  useEffect(() => {
    loadTags();
    loadScopes();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Poll for new/updated entries — detects changes from any process (OpenCode, Claude, etc.)
  useEffect(() => {
    const interval = setInterval(async () => {
      try {
        const stats = await api.getStats() as { total: number; lastUpdatedAt?: string };
        const snapshot = `${stats.total}:${stats.lastUpdatedAt || ''}`;
        if (lastSnapshotRef.current !== null && snapshot !== lastSnapshotRef.current) {
          setRefreshing(true);
          if (!searchMode) browse.reset();
          await loadTags();
          setRefreshing(false);
        }
        lastSnapshotRef.current = snapshot;
      } catch { /* ignore polling errors */ }
    }, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [loadTags, searchMode, browse.reset]);

  // Detect whether federating to external providers is worthwhile (any enabled provider or always-on)
  useEffect(() => {
    Promise.all([
      api.listProviders().catch(() => ({ providers: [] as { enabled?: boolean }[] })),
      api.getSettings().catch(() => ({} as { alwaysSearchExternalProviders?: boolean })),
    ]).then(([cfg, settings]) => {
      setExternalEnabled(
        (cfg.providers?.some((p) => p.enabled) ?? false) || !!settings.alwaysSearchExternalProviders,
      );
    });
  }, []);

  // Federated external search — additive; the local recent list above is rendered exactly as before.
  useEffect(() => {
    const term = query.trim();
    if (!externalEnabled || term.length < 2) { setExternalSections([]); setSearchingExt(false); return; }
    let cancelled = false;
    setSearchingExt(true);
    const handle = setTimeout(() => {
      api.searchFederated(term)
        .then((fed) => { if (!cancelled) setExternalSections(fed.external ?? []); })
        .catch(() => { if (!cancelled) setExternalSections([]); })
        .finally(() => { if (!cancelled) setSearchingExt(false); });
    }, 450);
    return () => { cancelled = true; clearTimeout(handle); };
  }, [query, externalEnabled]);

  // Read ?tag= from URL on mount
  useEffect(() => {
    const tagParam = searchParams.get('tag');
    if (tagParam) {
      setSelectedTags(tagParam.split(',').map(t => t.trim()).filter(Boolean));
    }
  }, []); // Only on mount

  // Sync selectedTags to URL
  useEffect(() => {
    if (selectedTags.length > 0) {
      setSearchParams({ tag: selectedTags.join(',') }, { replace: true });
    } else {
      const newParams = new URLSearchParams(searchParams);
      newParams.delete('tag');
      setSearchParams(newParams, { replace: true });
    }
  }, [selectedTags]); // eslint-disable-line react-hooks/exhaustive-deps

  // Related plans for editing entry
  const [relatedPlans, setRelatedPlans] = useState<RelatedPlan[]>([]);

  // Deep-link: open knowledge from ?edit=knowledgeId
  useEffect(() => {
    const editId = searchParams.get('edit');
    if (editId && !editingEntry) {
      api.getById(editId).then((entry: any) => {
        if (entry) { setEditingEntry(entry); setShowModal(true); }
      }).catch(() => {});
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Reset state when nav link clicked for same route
  useEffect(() => {
    if ((location.state as any)?.reset) {
      setShowModal(false);
      setEditingEntry(null);
      setQuery('');
      setTypeFilter('');
      setScopeFilter('');
      setSelectedTags([]);
      setRelatedPlans([]);
      setSearchParams({}, { replace: true });
      window.history.replaceState({}, '');
      browse.reset();
    }
  }, [(location.state as any)?.reset]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load related plans when editing entry changes
  useEffect(() => {
    if (editingEntry?.id) {
      api.getKnowledgePlans(editingEntry.id as string).then(setRelatedPlans).catch(() => setRelatedPlans([]));
    } else {
      setRelatedPlans([]);
    }
  }, [editingEntry?.id]);

  // Bulk selection state
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkMode, setBulkMode] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);

  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const handleBulkDelete = async () => {
    if (selectedIds.size === 0) return;
    setBulkDeleting(true);
    try {
      await api.bulkDeleteKnowledge(Array.from(selectedIds));
      setSelectedIds(new Set());
      setBulkMode(false);
      setShowBulkDeleteConfirm(false);
      handleSuccess();
    } catch (error) {
      console.error('Bulk delete failed:', error);
    } finally {
      setBulkDeleting(false);
    }
  };

  // Delete confirmation modal state
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [showBulkDeleteConfirm, setShowBulkDeleteConfirm] = useState(false);

  const handleDeleteClick = (id: string) => {
    setDeleteTargetId(id);
  };

  const handleConfirmDelete = async () => {
    if (!deleteTargetId) return;
    setDeleting(true);
    try {
      await api.deleteEntry(deleteTargetId);
      browse.setItems(prev => prev.filter(e => e.id !== deleteTargetId));
      setSearchResults(prev => prev.filter(e => e.id !== deleteTargetId));
      setDeleteTargetId(null);
    } catch (error) {
      console.error('Delete failed:', error);
    } finally {
      setDeleting(false);
    }
  };

  const handleToggleTag = (tag: string) => {
    setSelectedTags(prev =>
      prev.includes(tag) ? prev.filter(t => t !== tag) : [...prev, tag]
    );
  };

  const handleClearAll = () => {
    setSelectedTags([]);
    setTypeFilter('');
    setScopeFilter('');
    setQuery('');
  };

  const handleSuccess = () => {
    browse.reset();
    loadTags();
    loadScopes();
    // Reset snapshot so polling doesn't double-refresh
    lastSnapshotRef.current = null;
  };

  const handleEdit = (entry: Record<string, unknown>) => {
    setEditingEntry(entry);
    setShowModal(true);
  };

  const handleCloseModal = () => {
    setShowModal(false);
    setEditingEntry(null);
    setRelatedPlans([]);
    const newParams = new URLSearchParams(searchParams);
    newParams.delete('edit');
    setSearchParams(newParams, { replace: true });
  };

  return (
    <div>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      {showModal ? (
        <>
          <button
            onClick={handleCloseModal}
            style={{
              display: 'flex', alignItems: 'center', gap: 6, marginBottom: 20,
              background: 'none', border: 'none', color: 'var(--text-secondary)',
              cursor: 'pointer', fontSize: 13, padding: 0,
            }}
          >
            ← {t('search.recent')}
          </button>
          <KnowledgeModal
            isOpen={showModal}
            onClose={handleCloseModal}
            onSuccess={handleSuccess}
            entry={editingEntry}
          />
          {/* Related Plans Section */}
          {editingEntry && relatedPlans.length > 0 && (() => {
            const originPlans = relatedPlans.filter(p => p.relationType === 'output');
            const usedInPlans = relatedPlans.filter(p => p.relationType === 'input');
            return (
              <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 20 }}>
                <div style={{ flex: 1, minWidth: 250 }}>
                  <h3 style={{ fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1, color: 'var(--text-secondary)', marginBottom: 10 }}>
                    {t('plans.originPlan')}
                  </h3>
                  {originPlans.length === 0 ? (
                    <p style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{t('plans.noPlans')}</p>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {originPlans.map(p => (
                        <a key={`${p.planId}-out`} href={`/plans?select=${p.planId}`} style={{
                          display: 'block', textDecoration: 'none', color: 'inherit',
                          backgroundColor: 'var(--bg-main)', borderRadius: 6, border: '1px solid var(--border)',
                          padding: 10, fontSize: 12, cursor: 'pointer', transition: 'border-color 0.15s',
                        }}
                        onMouseEnter={(e) => (e.currentTarget.style.borderColor = 'var(--accent)')}
                        onMouseLeave={(e) => (e.currentTarget.style.borderColor = 'var(--border)')}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <span style={{ width: 6, height: 6, borderRadius: '50%', backgroundColor: STATUS_COLORS[p.status] || '#6b7280', flexShrink: 0 }} />
                            <span style={{ fontWeight: 600 }}>{p.title}</span>
                            <span style={{ padding: '1px 6px', borderRadius: 4, fontSize: 9, fontWeight: 600, backgroundColor: STATUS_COLORS[p.status] || '#6b7280', color: '#fff' }}>{p.status}</span>
                          </div>
                        </a>
                      ))}
                    </div>
                  )}
                </div>
                <div style={{ flex: 1, minWidth: 250 }}>
                  <h3 style={{ fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1, color: 'var(--text-secondary)', marginBottom: 10 }}>
                    {t('plans.consultedBy')}
                  </h3>
                  {usedInPlans.length === 0 ? (
                    <p style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{t('plans.noPlans')}</p>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {usedInPlans.map(p => (
                        <a key={`${p.planId}-in`} href={`/plans?select=${p.planId}`} style={{
                          display: 'block', textDecoration: 'none', color: 'inherit',
                          backgroundColor: 'var(--bg-main)', borderRadius: 6, border: '1px solid var(--border)',
                          padding: 10, fontSize: 12, cursor: 'pointer', transition: 'border-color 0.15s',
                        }}
                        onMouseEnter={(e) => (e.currentTarget.style.borderColor = 'var(--accent)')}
                        onMouseLeave={(e) => (e.currentTarget.style.borderColor = 'var(--border)')}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <span style={{ width: 6, height: 6, borderRadius: '50%', backgroundColor: STATUS_COLORS[p.status] || '#6b7280', flexShrink: 0 }} />
                            <span style={{ fontWeight: 600 }}>{p.title}</span>
                            <span style={{ padding: '1px 6px', borderRadius: 4, fontSize: 9, fontWeight: 600, backgroundColor: STATUS_COLORS[p.status] || '#6b7280', color: '#fff' }}>{p.status}</span>
                          </div>
                        </a>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            );
          })()}
        </>
      ) : (
        <>
      {/* Search Bar + Actions */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('search.placeholder')}
          style={{
            flex: 1, padding: '12px 16px', borderRadius: 8,
            backgroundColor: 'var(--bg-input)', border: '1px solid var(--border)',
            color: 'var(--text-primary)', fontSize: 14, outline: 'none',
          }}
        />
        <button
          onClick={() => { setBulkMode(!bulkMode); setSelectedIds(new Set()); }}
          title={t('actions.bulkSelect')}
          style={{
            padding: '8px 14px', borderRadius: 8,
            border: bulkMode ? '1px solid var(--accent)' : '1px solid var(--border)',
            backgroundColor: bulkMode ? 'var(--accent-muted)' : 'transparent',
            color: bulkMode ? 'var(--accent)' : 'var(--text-secondary)',
            cursor: 'pointer', fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap',
          }}
        >
          {bulkMode ? t('actions.cancel') : (
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="2" width="12" height="12" rx="2" />
              <path d="M5.5 8l2 2 3.5-3.5" />
            </svg>
          )}
        </button>
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 20, alignItems: 'center' }}>
        <select
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
          style={{
            padding: '8px 12px', borderRadius: 6,
            backgroundColor: 'var(--bg-input)', border: '1px solid var(--border)',
            color: typeFilter ? 'var(--text-primary)' : 'var(--text-secondary)', fontSize: 13,
          }}
        >
          <option value="">{t('filters.all')} — {t('filters.type')}</option>
          {types.map(type => (
            <option key={type} value={type}>{t(`types.${type}`)}</option>
          ))}
        </select>
        <select
          value={scopeFilter}
          onChange={(e) => setScopeFilter(e.target.value)}
          style={{
            padding: '8px 12px', borderRadius: 6,
            backgroundColor: 'var(--bg-input)', border: '1px solid var(--border)',
            color: scopeFilter ? 'var(--text-primary)' : 'var(--text-secondary)', fontSize: 13,
          }}
        >
          <option value="">{t('filters.all')} — {t('filters.scope')}</option>
          {allScopes.map(scope => (
            <option key={scope} value={scope}>{scope}</option>
          ))}
        </select>
        {hasActiveFilters && (
          <button
            onClick={handleClearAll}
            style={{
              padding: '8px 14px', borderRadius: 6,
              border: '1px solid var(--border)', backgroundColor: 'transparent',
              color: 'var(--accent)', fontSize: 12, fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            {t('filters.clear')}
          </button>
        )}
      </div>

      {/* Tag Bar */}
      <TagBar
        tags={allTags}
        selectedTags={selectedTags}
        onToggleTag={handleToggleTag}
        onClearTags={() => setSelectedTags([])}
        loading={false}
      />

      {/* Knowledge Entries */}
      {displayedEntries.length > 0 && (
        <div>
          <h3 style={{ color: 'var(--text-secondary)', fontSize: 13, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
            {searchMode ? t('search.results') : t('search.recent')}
            {(refreshing || searchingLocal) && (
              <span style={{
                display: 'inline-block', width: 12, height: 12,
                border: '2px solid var(--border)', borderTopColor: 'var(--accent)',
                borderRadius: '50%', animation: 'spin 0.8s linear infinite',
              }} />
            )}
          </h3>
          {displayedEntries.map((entry) => (
            <KnowledgeCard
              key={entry.id as string}
              entry={entry}
              onDelete={handleDeleteClick}
              onTagClick={handleToggleTag}
              onEdit={bulkMode ? undefined : handleEdit}
              selected={selectedIds.has(entry.id as string)}
              onToggleSelect={bulkMode ? toggleSelect : undefined}
            />
          ))}
          {/* Infinite-scroll sentinel + footer (browse mode only) */}
          {!searchMode && (
            <div ref={browse.sentinelRef} style={{ height: 1 }} />
          )}
          {!searchMode && browse.loadingMore && (
            <p style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: 16, fontSize: 12 }}>
              {t('list.loadingMore')}
            </p>
          )}
          {!searchMode && !browse.hasMore && displayedEntries.length > PAGE_SIZE && (
            <p style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: 16, fontSize: 12 }}>
              {t('list.noMore')}
            </p>
          )}
        </div>
      )}

      {displayedEntries.length === 0 && !browse.loadingMore && !searchingLocal && (
        <p style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: 40 }}>
          {hasActiveFilters ? t('search.noResults') : t('search.empty')}
        </p>
      )}

      {/* External provider results — provenance-labeled, untrusted, kept separate from local */}
      {(searchingExt || externalSections.length > 0) && query.trim().length >= 2 && (
        <div style={{ marginTop: 28 }}>
          <h3 style={{ color: 'var(--text-secondary)', fontSize: 13, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 8 }}>
            {t('providers.externalResults')}
            {searchingExt && (
              <span style={{ display: 'inline-block', width: 12, height: 12, border: '2px solid var(--border)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
            )}
          </h3>
          <p style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 14 }}>⚠ {t('providers.externalUntrusted')}</p>
          {externalSections.map((sec) => (
            <div key={sec.providerId} style={{ marginBottom: 18 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <strong style={{ fontSize: 13 }}>{sec.providerName}</strong>
                <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 999, border: '1px solid var(--border)', color: 'var(--text-secondary)' }}>{t('providers.untrustedBadge')}</span>
                <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{sec.tookMs}ms</span>
              </div>
              {sec.error ? (
                <p style={{ fontSize: 12, color: 'var(--error)' }}>{t('providers.failed')}: {sec.error}</p>
              ) : sec.results.length === 0 ? (
                <p style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{t('providers.externalNoResults')}</p>
              ) : (
                sec.results.map((r, i) => (
                  <div key={i} style={{ backgroundColor: 'var(--bg-card)', border: '1px dashed var(--border)', borderRadius: 8, padding: 12, marginBottom: 8 }}>
                    <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 4 }}>
                      {r.url
                        ? <a href={r.url} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)', textDecoration: 'none' }}>{r.title}</a>
                        : r.title}
                      {typeof r.score === 'number' && <span style={{ fontSize: 11, color: 'var(--text-secondary)', fontWeight: 400 }}> · {r.score.toFixed(2)}</span>}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-secondary)', whiteSpace: 'pre-wrap' }}>{r.content}</div>
                  </div>
                ))
              )}
            </div>
          ))}
        </div>
      )}

      {/* Bulk action bar */}
      {bulkMode && selectedIds.size > 0 && (
        <div style={{
          position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)',
          backgroundColor: 'var(--bg-card)', border: '1px solid var(--accent)',
          borderRadius: 12, padding: '12px 20px', display: 'flex', gap: 12, alignItems: 'center',
          zIndex: 50, boxShadow: '0 4px 20px rgba(0,0,0,0.3)',
        }}>
          <span style={{ fontSize: 13, color: 'var(--text-primary)', fontWeight: 600 }}>
            {selectedIds.size} {t('actions.selected')}
          </span>
          <button
            onClick={() => setSelectedIds(new Set(displayedEntries.map(e => e.id as string)))}
            style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', fontSize: 12 }}
          >
            {t('actions.selectAll')}
          </button>
          <button
            onClick={() => setSelectedIds(new Set())}
            style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 12 }}
          >
            {t('actions.deselectAll')}
          </button>
          <button
            onClick={() => setShowBulkDeleteConfirm(true)}
            style={{
              padding: '6px 16px', borderRadius: 6, border: 'none',
              backgroundColor: 'var(--error)', color: '#fff', cursor: 'pointer',
              fontSize: 13, fontWeight: 600,
            }}
          >
            {t('actions.delete')}
          </button>
        </div>
      )}

      {/* FAB */}
      <FloatingAddButton onClick={() => { setEditingEntry(null); setShowModal(true); }} />
        </>
      )}

      {/* Single delete confirmation modal */}
      <ConfirmModal
        isOpen={deleteTargetId !== null}
        onClose={() => setDeleteTargetId(null)}
        onConfirm={handleConfirmDelete}
        title={t('delete.title')}
        message={t('delete.message')}
        loading={deleting}
      />

      {/* Bulk delete confirmation modal */}
      <ConfirmModal
        isOpen={showBulkDeleteConfirm}
        onClose={() => setShowBulkDeleteConfirm(false)}
        onConfirm={handleBulkDelete}
        title={t('delete.bulkTitle')}
        message={t('delete.bulkMessage', { count: selectedIds.size })}
        loading={bulkDeleting}
      />
    </div>
  );
}
