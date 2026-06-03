import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams, useLocation, useNavigate } from 'react-router-dom';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api } from '../api/client.js';
import { useInfiniteList, PAGE_SIZE } from '../hooks/useInfiniteScroll.js';
import { FloatingAddButton } from '../components/FloatingAddButton.js';
import { ScopeAutocomplete } from '../components/ScopeAutocomplete.js';
import { PLAN_TEMPLATES, type PlanTemplate } from '../data/planTemplates.js';
import { ConfirmModal } from '../components/ConfirmModal.js';

const STATUS_COLORS: Record<string, string> = {
  draft: '#6b7280',
  active: '#3b82f6',
  completed: '#22c55e',
  archived: '#a78bfa',
};

const PRIORITY_COLORS: Record<string, string> = {
  high: '#ef4444',
  medium: '#f59e0b',
  low: '#6b7280',
};

const TYPE_COLORS: Record<string, string> = {
  decision: '#3b82f6',
  pattern: '#8b5cf6',
  fix: '#ef4444',
  constraint: '#f59e0b',
  gotcha: '#ec4899',
};

interface PlanEntry {
  id: string;
  title: string;
  content: string;
  tags: string[];
  scope: string;
  source: string;
  status: string;
  planFilePath?: string | null;
  createdAt: string;
  updatedAt: string;
}

interface PlanTask {
  id: string;
  planId: string;
  description: string;
  status: string;
  priority: string;
  notes: string | null;
  position: number;
}

interface PlanRelation {
  entry: Record<string, unknown>;
  relationType: string;
}

/* ── Badges ── */

function StatusBadge({ status }: { status: string }) {
  const s = status || 'draft';
  return (
    <span style={{
      padding: '2px 8px', borderRadius: 4, fontSize: 10, fontWeight: 600,
      backgroundColor: `${STATUS_COLORS[s] || '#6b7280'}22`,
      color: STATUS_COLORS[s] || '#6b7280',
      textTransform: 'uppercase', letterSpacing: 0.5,
    }}>
      {s}
    </span>
  );
}

/* ── Task Status Icon ── */

function TaskStatusIcon({ status }: { status: string }) {
  if (status === 'completed') {
    return <span style={{ color: '#22c55e', fontSize: 16, fontWeight: 700, lineHeight: 1 }}>✓</span>;
  }
  if (status === 'in_progress') {
    return (
      <span style={{ display: 'inline-block', width: 14, height: 14 }}>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        <svg width="14" height="14" viewBox="0 0 14 14" style={{ animation: 'spin 1s linear infinite' }}>
          <circle cx="7" cy="7" r="5.5" fill="none" stroke="var(--accent)" strokeWidth="2" strokeDasharray="20 14" strokeLinecap="round" />
        </svg>
      </span>
    );
  }
  // pending
  return <span style={{ color: 'var(--text-secondary)', fontSize: 14, lineHeight: 1 }}>○</span>;
}

/* ── Progress Bar ── */

function ProgressBar({ completed, total }: { completed: number; total: number }) {
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
  const barColor = pct === 100 ? '#22c55e' : pct > 50 ? 'var(--accent)' : '#6b7280';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
      <div style={{ flex: 1, height: 6, backgroundColor: 'var(--bg-input)', borderRadius: 3, overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', backgroundColor: barColor, borderRadius: 3, transition: 'width 0.3s' }} />
      </div>
      <span style={{ fontSize: 11, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
        {completed}/{total}
      </span>
    </div>
  );
}

/* ── Mini Progress (for plan cards) ── */

function MiniProgress({ completed, total }: { completed: number; total: number }) {
  if (total === 0) return null;
  const pct = Math.round((completed / total) * 100);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 6 }}>
      <div style={{ width: 50, height: 4, backgroundColor: 'var(--bg-input)', borderRadius: 2, overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', backgroundColor: pct === 100 ? '#22c55e' : 'var(--accent)', borderRadius: 2 }} />
      </div>
      <span style={{ fontSize: 9, color: 'var(--text-secondary)' }}>{completed}/{total}</span>
    </div>
  );
}

/* ── Task Item ── */

function TaskItem({ task, expandedNotes, onToggleNotes, onUpdateTask }: {
  task: PlanTask;
  expandedNotes: boolean;
  onToggleNotes: () => void;
  onUpdateTask?: (taskId: string, updates: Record<string, unknown>) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [editingDesc, setEditingDesc] = useState(false);
  const [editDesc, setEditDesc] = useState(task.description);
  const [editingNotes, setEditingNotes] = useState(false);
  const [editNotes, setEditNotes] = useState(task.notes || '');
  const [showPriorityMenu, setShowPriorityMenu] = useState(false);

  const cycleStatus = () => {
    if (!onUpdateTask) return;
    const next = task.status === 'pending' ? 'in_progress' : task.status === 'in_progress' ? 'completed' : 'pending';
    onUpdateTask(task.id, { status: next });
  };

  const saveDesc = () => {
    setEditingDesc(false);
    if (editDesc.trim() !== task.description && onUpdateTask) {
      onUpdateTask(task.id, { description: editDesc.trim() });
    }
  };

  const saveNotes = () => {
    setEditingNotes(false);
    if (editNotes !== (task.notes || '') && onUpdateTask) {
      onUpdateTask(task.id, { notes: editNotes || null });
    }
  };

  const setPriority = (p: string) => {
    setShowPriorityMenu(false);
    if (p !== task.priority && onUpdateTask) {
      onUpdateTask(task.id, { priority: p });
    }
  };

  return (
    <div
      style={{
        display: 'flex', gap: 8, padding: '8px 10px',
        borderLeft: `3px solid ${PRIORITY_COLORS[task.priority] || '#6b7280'}`,
        backgroundColor: 'var(--bg-main)', borderRadius: '0 6px 6px 0',
        opacity: task.status === 'completed' ? 0.6 : 1,
        position: 'relative',
      }}
    >
      <div style={{ paddingTop: 1, cursor: onUpdateTask ? 'pointer' : 'default' }} onClick={cycleStatus}>
        <TaskStatusIcon status={task.status} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        {editingDesc && onUpdateTask ? (
          <input
            autoFocus
            value={editDesc}
            onChange={(e) => setEditDesc(e.target.value)}
            onBlur={saveDesc}
            onKeyDown={(e) => { if (e.key === 'Enter') saveDesc(); if (e.key === 'Escape') { setEditDesc(task.description); setEditingDesc(false); } }}
            style={{
              width: '100%', fontSize: 12, padding: '2px 6px', borderRadius: 4,
              border: '1px solid var(--accent)', backgroundColor: 'var(--bg-input)',
              color: 'var(--text-primary)', outline: 'none', boxSizing: 'border-box',
            }}
          />
        ) : (
          <span
            onClick={(e) => { if (onUpdateTask) { e.stopPropagation(); setEditingDesc(true); setEditDesc(task.description); } }}
            style={{
              fontSize: 12, cursor: onUpdateTask ? 'text' : 'default',
              textDecoration: task.status === 'completed' ? 'line-through' : 'none',
              color: task.status === 'completed' ? 'var(--text-secondary)' : 'var(--text-primary)',
            }}>
            {task.description}
          </span>
        )}

        {/* Priority badge (clickable) */}
        {onUpdateTask && (
          <span style={{ position: 'relative', display: 'inline-block', marginLeft: 6 }}>
            <button
              onClick={(e) => { e.stopPropagation(); setShowPriorityMenu(!showPriorityMenu); }}
              style={{
                padding: '1px 6px', borderRadius: 3, fontSize: 9, fontWeight: 600,
                border: 'none', cursor: 'pointer',
                backgroundColor: `${PRIORITY_COLORS[task.priority] || '#6b7280'}22`,
                color: PRIORITY_COLORS[task.priority] || '#6b7280',
              }}
            >
              {task.priority}
            </button>
            {showPriorityMenu && (
              <div style={{
                position: 'absolute', top: '100%', left: 0, zIndex: 20,
                backgroundColor: 'var(--bg-card)', border: '1px solid var(--border)',
                borderRadius: 6, marginTop: 2, overflow: 'hidden',
              }}>
                {['high', 'medium', 'low'].map(p => (
                  <button key={p} onClick={(e) => { e.stopPropagation(); setPriority(p); }}
                    style={{
                      display: 'block', width: '100%', padding: '4px 12px', textAlign: 'left',
                      background: p === task.priority ? 'var(--accent-muted)' : 'none',
                      border: 'none', color: PRIORITY_COLORS[p], cursor: 'pointer', fontSize: 11, fontWeight: 600,
                    }}>
                    {p}
                  </button>
                ))}
              </div>
            )}
          </span>
        )}

        {/* Notes */}
        {(task.notes || onUpdateTask) && (
          <>
            <button
              onClick={(e) => { e.stopPropagation(); onToggleNotes(); }}
              style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 9, marginLeft: 6, padding: 0 }}
            >
              {expandedNotes ? '▼' : '▶'} {t('plans.notes')}
            </button>
            {expandedNotes && (
              editingNotes && onUpdateTask ? (
                <textarea
                  autoFocus
                  value={editNotes}
                  onChange={(e) => setEditNotes(e.target.value)}
                  onBlur={saveNotes}
                  onKeyDown={(e) => { if (e.key === 'Escape') { setEditNotes(task.notes || ''); setEditingNotes(false); } }}
                  rows={2}
                  style={{
                    width: '100%', fontSize: 11, padding: '4px 6px', borderRadius: 4, marginTop: 4,
                    border: '1px solid var(--accent)', backgroundColor: 'var(--bg-input)',
                    color: 'var(--text-secondary)', outline: 'none', resize: 'vertical',
                    fontFamily: 'inherit', boxSizing: 'border-box',
                  }}
                />
              ) : (
                <p
                  onClick={() => { if (onUpdateTask) { setEditingNotes(true); setEditNotes(task.notes || ''); } }}
                  style={{
                    fontSize: 11, color: 'var(--text-secondary)', fontStyle: 'italic', marginTop: 4,
                    cursor: onUpdateTask ? 'text' : 'default',
                  }}>
                  {task.notes || (onUpdateTask ? t('plans.addNotes') : '')}
                </p>
              )
            )}
          </>
        )}
      </div>
    </div>
  );
}

/* ── Main PlansPage ── */

/* ── Create Plan Form ── */

interface NewTask {
  description: string;
  priority: 'high' | 'medium' | 'low';
}

function CreatePlanForm({ onCreated, onCancel }: { onCreated: () => void; onCancel: () => void }) {
  const { t } = useTranslation();
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [tagsInput, setTagsInput] = useState('');
  const [scope, setScope] = useState('global');
  const [newTasks, setNewTasks] = useState<NewTask[]>([{ description: '', priority: 'medium' }]);
  const [saving, setSaving] = useState(false);
  const [selectedTemplate, setSelectedTemplate] = useState('blank');

  const applyTemplate = (tpl: PlanTemplate) => {
    setSelectedTemplate(tpl.id);
    if (tpl.id === 'blank') {
      setTitle('');
      setContent('');
      setTagsInput('');
      setNewTasks([{ description: '', priority: 'medium' }]);
      return;
    }
    setTitle(tpl.titlePattern);
    setContent(tpl.contentStructure);
    setTagsInput(tpl.defaultTags.join(', '));
    setNewTasks(tpl.tasks.length > 0
      ? tpl.tasks.map(t => ({ description: t.description, priority: t.priority }))
      : [{ description: '', priority: 'medium' }]
    );
  };

  const addTask = () => setNewTasks([...newTasks, { description: '', priority: 'medium' }]);

  const removeTask = (index: number) => {
    if (newTasks.length <= 1) return;
    setNewTasks(newTasks.filter((_, i) => i !== index));
  };

  const updateTask = (index: number, field: keyof NewTask, value: string) => {
    setNewTasks(newTasks.map((t, i) => i === index ? { ...t, [field]: value } : t));
  };

  const handleSubmit = async () => {
    if (!title.trim() || !content.trim()) return;
    setSaving(true);
    try {
      const tags = tagsInput.split(',').map((t) => t.trim()).filter(Boolean);
      const tasks = newTasks.filter((t) => t.description.trim()).map((t) => ({
        description: t.description.trim(),
        priority: t.priority,
      }));
      await api.createPlan({ title: title.trim(), content: content.trim(), tags, scope, source: 'dashboard', tasks });
      onCreated();
    } catch {
      /* silent */
    }
    setSaving(false);
  };

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '10px 12px', borderRadius: 8,
    border: '1px solid var(--border)', backgroundColor: 'var(--bg-input)',
    color: 'var(--text-primary)', fontSize: 13, outline: 'none',
    boxSizing: 'border-box',
  };

  return (
    <div style={{ backgroundColor: 'var(--bg-card)', borderRadius: 10, border: '1px solid var(--border)', padding: 20, marginBottom: 20 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <h2 style={{ fontSize: 16, fontWeight: 700 }}>{t('plans.newPlan')}</h2>
        <button onClick={onCancel} style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 18, padding: 0, lineHeight: 1 }}>×</button>
      </div>

      {/* Template Selector */}
      <div style={{ marginBottom: 16 }}>
        <label style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--text-secondary)', display: 'block', marginBottom: 6 }}>
          {t('plans.template')}
        </label>
        <div style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 4 }}>
          {PLAN_TEMPLATES.map((tpl) => (
            <button
              key={tpl.id}
              type="button"
              onClick={() => applyTemplate(tpl)}
              style={{
                padding: '8px 14px', borderRadius: 8, fontSize: 12, fontWeight: 600,
                border: selectedTemplate === tpl.id ? '1px solid var(--accent)' : '1px solid var(--border)',
                backgroundColor: selectedTemplate === tpl.id ? 'var(--accent-muted)' : 'var(--bg-input)',
                color: selectedTemplate === tpl.id ? 'var(--accent)' : 'var(--text-secondary)',
                cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0,
              }}
            >
              {tpl.icon} {tpl.name}
            </button>
          ))}
        </div>
      </div>

      {/* Title */}
      <div style={{ marginBottom: 16 }}>
        <label style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--text-secondary)', display: 'block', marginBottom: 6 }}>
          {t('plans.planTitle')}
        </label>
        <input
          value={title} onChange={(e) => setTitle(e.target.value)}
          placeholder={t('plans.planTitlePlaceholder')}
          style={inputStyle}
        />
      </div>

      {/* Content */}
      <div style={{ marginBottom: 16 }}>
        <label style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--text-secondary)', display: 'block', marginBottom: 6 }}>
          {t('plans.planContent')}
        </label>
        <textarea
          value={content} onChange={(e) => setContent(e.target.value)}
          placeholder={t('plans.planContentPlaceholder')}
          rows={5}
          style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit' }}
        />
      </div>

      {/* Scope + Tags row */}
      <div style={{ display: 'flex', gap: 16, marginBottom: 16 }}>
        <div style={{ flex: 1 }}>
          <label style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--text-secondary)', display: 'block', marginBottom: 6 }}>
            {t('knowledge.scope')}
          </label>
          <ScopeAutocomplete
            value={scope}
            onChange={setScope}
          />
        </div>
        <div style={{ flex: 1 }}>
          <label style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--text-secondary)', display: 'block', marginBottom: 6 }}>
            {t('knowledge.tags')}
          </label>
          <input
            value={tagsInput} onChange={(e) => setTagsInput(e.target.value)}
            placeholder={t('plans.tagsPlaceholder')}
            style={inputStyle}
          />
        </div>
      </div>

      {/* Tasks */}
      <div style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <label style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--text-secondary)' }}>
            {t('plans.tasks')}
          </label>
          <button onClick={addTask} style={{
            padding: '4px 12px', borderRadius: 6, fontSize: 11, fontWeight: 600,
            border: '1px solid var(--border)', backgroundColor: 'var(--bg-input)',
            color: 'var(--text-secondary)', cursor: 'pointer',
          }}>
            + {t('plans.addTask')}
          </button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {newTasks.map((task, i) => (
            <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input
                value={task.description}
                onChange={(e) => updateTask(i, 'description', e.target.value)}
                placeholder={`${t('plans.taskPlaceholder')} ${i + 1}`}
                style={{ ...inputStyle, flex: 1 }}
              />
              <select
                value={task.priority}
                onChange={(e) => updateTask(i, 'priority', e.target.value)}
                style={{ ...inputStyle, width: 100, flex: 'none' }}
              >
                <option value="high">High</option>
                <option value="medium">Medium</option>
                <option value="low">Low</option>
              </select>
              {newTasks.length > 1 && (
                <button onClick={() => removeTask(i)} style={{
                  background: 'none', border: 'none', color: 'var(--text-secondary)',
                  cursor: 'pointer', fontSize: 16, padding: '0 4px', lineHeight: 1,
                }}>×</button>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Actions */}
      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
        <button onClick={onCancel} style={{
          padding: '8px 20px', borderRadius: 8, fontSize: 13, fontWeight: 600,
          border: '1px solid var(--border)', backgroundColor: 'var(--bg-input)',
          color: 'var(--text-secondary)', cursor: 'pointer',
        }}>
          {t('actions.cancel')}
        </button>
        <button
          onClick={handleSubmit}
          disabled={saving || !title.trim() || !content.trim()}
          style={{
            padding: '8px 20px', borderRadius: 8, fontSize: 13, fontWeight: 600,
            border: 'none', backgroundColor: 'var(--accent)',
            color: '#fff', cursor: saving ? 'wait' : 'pointer',
            opacity: (!title.trim() || !content.trim()) ? 0.5 : 1,
          }}
        >
          {saving ? '...' : t('plans.createDraft')}
        </button>
      </div>
    </div>
  );
}

export function PlansPage() {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [scopeFilter, setScopeFilter] = useState<string>('');
  const [allScopes, setAllScopes] = useState<string[]>([]);
  const [selectedPlan, setSelectedPlan] = useState<PlanEntry | null>(null);
  const [tasks, setTasks] = useState<PlanTask[]>([]);
  const [relations, setRelations] = useState<PlanRelation[]>([]);
  const [activePlans, setActivePlans] = useState<PlanEntry[]>([]);
  const [activeTasksMap, setActiveTasksMap] = useState<Record<string, PlanTask[]>>({});
  const [expandedNotes, setExpandedNotes] = useState<Set<string>>(new Set());
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deletingPlan, setDeletingPlan] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval>>();

  // Plan-file preview (collapsible) + open-in-editor. Cached per plan id so the 5s
  // detail poll (which replaces the selectedPlan object) doesn't reset it.
  const [filePreviewOpen, setFilePreviewOpen] = useState(false);
  const [filePreview, setFilePreview] = useState<{ exists: boolean; content?: string; truncated?: boolean } | null>(null);
  const [filePreviewLoading, setFilePreviewLoading] = useState(false);
  const filePreviewPlanIdRef = useRef<string | null>(null);

  // Main plans list — infinite scroll, server-side status + scope filters.
  const list = useInfiniteList<PlanEntry>(
    (offset) => api.listPlans(PAGE_SIZE, statusFilter || undefined, offset, scopeFilter || undefined) as Promise<PlanEntry[]>,
    [statusFilter, scopeFilter],
  );

  // Load available scopes for the scope filter dropdown.
  const loadScopes = useCallback(() => {
    return (api.getStats() as Promise<{ byScope: { scope: string }[] }>)
      .then((stats) => setAllScopes(stats.byScope.map((s) => s.scope)))
      .catch(() => {});
  }, []);

  // Load active plans with tasks (for top section)
  const loadActivePlans = useCallback(async () => {
    try {
      const active = await api.listPlans(10, 'active');
      setActivePlans(active as PlanEntry[]);
      const tasksMap: Record<string, PlanTask[]> = {};
      for (const plan of active as PlanEntry[]) {
        try {
          tasksMap[plan.id] = await api.listPlanTasks(plan.id) as PlanTask[];
        } catch { tasksMap[plan.id] = []; }
      }
      setActiveTasksMap(tasksMap);
    } catch { /* silent */ }
  }, []);

  useEffect(() => { loadActivePlans(); loadScopes(); }, [loadActivePlans, loadScopes]);

  // Poll active plans every 5s (the main list isn't polled to avoid resetting scroll;
  // it refreshes on filter change, create/delete/archive, or selecting a plan).
  useEffect(() => {
    pollRef.current = setInterval(() => { loadActivePlans(); }, 5000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [loadActivePlans]);

  // Deep-link: open plan from ?select=planId
  useEffect(() => {
    const selectId = searchParams.get('select');
    if (selectId && !selectedPlan) {
      api.getPlan(selectId).then((plan) => {
        if (plan) selectPlan(plan as PlanEntry);
      }).catch(() => {});
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Collapse + clear the file preview when a DIFFERENT plan is selected (keyed on
  // id, so the 5s poll replacing the object identity does NOT reset it).
  useEffect(() => {
    setFilePreviewOpen(false);
    setFilePreview(null);
    filePreviewPlanIdRef.current = null;
  }, [selectedPlan?.id]);

  const togglePreview = async () => {
    if (!selectedPlan) return;
    const next = !filePreviewOpen;
    setFilePreviewOpen(next);
    if (next && filePreviewPlanIdRef.current !== selectedPlan.id) {
      setFilePreviewLoading(true);
      try {
        const res = await api.getPlanFile(selectedPlan.id);
        setFilePreview(res);
        filePreviewPlanIdRef.current = selectedPlan.id;
      } catch {
        setFilePreview({ exists: false });
      }
      setFilePreviewLoading(false);
    }
  };

  const openPlanInEditor = async () => {
    if (!selectedPlan) return;
    try {
      const r = await api.openPlanFile(selectedPlan.id);
      if (!r.ok) alert(r.unsupported ? t('planFile.unsupported') : t('planFile.notFound'));
    } catch {
      alert(t('planFile.notFound'));
    }
  };

  // Reset state when nav link clicked for same route
  useEffect(() => {
    if ((location.state as any)?.reset) {
      setSelectedPlan(null);
      setShowCreateForm(false);
      setStatusFilter('');
      setScopeFilter('');
      setSearchParams({}, { replace: true });
      window.history.replaceState({}, '');
      list.reset();
    }
  }, [(location.state as any)?.reset]); // eslint-disable-line react-hooks/exhaustive-deps

  // Refresh selected plan detail (status, tasks, relations)
  const refreshSelectedPlan = useCallback(async (planId: string) => {
    try {
      const [planData, t, r] = await Promise.all([
        api.getPlan(planId),
        api.listPlanTasks(planId),
        api.getPlanRelations(planId),
      ]);
      if (planData) setSelectedPlan(planData as PlanEntry);
      setTasks(t as PlanTask[]);
      setRelations(r as PlanRelation[]);
    } catch { /* silent — don't clear on transient errors */ }
  }, []);

  // Poll selected plan every 5s
  useEffect(() => {
    if (!selectedPlan) return;
    const id = selectedPlan.id;
    const interval = setInterval(() => refreshSelectedPlan(id), 5000);
    return () => clearInterval(interval);
  }, [selectedPlan?.id, refreshSelectedPlan]);

  const selectPlan = async (plan: PlanEntry) => {
    setSelectedPlan(plan);
    try {
      const [t, r] = await Promise.all([
        api.listPlanTasks(plan.id),
        api.getPlanRelations(plan.id),
      ]);
      setTasks(t as PlanTask[]);
      setRelations(r as PlanRelation[]);
    } catch {
      setTasks([]);
      setRelations([]);
    }
  };

  const toggleNotes = (taskId: string) => {
    setExpandedNotes((prev) => {
      const next = new Set(prev);
      next.has(taskId) ? next.delete(taskId) : next.add(taskId);
      return next;
    });
  };

  const handleUpdateTask = async (taskId: string, updates: Record<string, unknown>) => {
    try {
      await api.updatePlanTask(taskId, updates);
      if (selectedPlan) refreshSelectedPlan(selectedPlan.id);
    } catch { /* silent */ }
  };

  const completedTasks = tasks.filter((t) => t.status === 'completed').length;
  const inputRelations = relations.filter((r) => r.relationType === 'input');
  const outputRelations = relations.filter((r) => r.relationType === 'output');
  const statusFilters = ['', 'draft', 'active', 'completed', 'archived'];

  // ── Detail View (full page) ──
  if (selectedPlan) {
    return (
      <div>
        <button
          onClick={() => { setSelectedPlan(null); setSearchParams({}, { replace: true }); }}
          style={{
            display: 'flex', alignItems: 'center', gap: 6, marginBottom: 20,
            background: 'none', border: 'none', color: 'var(--text-secondary)',
            cursor: 'pointer', fontSize: 13, padding: 0,
          }}
        >
          ← {t('plans.backToPlans')}
        </button>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <StatusBadge status={selectedPlan.status} />
            <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{selectedPlan.scope}</span>
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            {selectedPlan.status === 'completed' && (
              <button
                onClick={() => setConfirmArchive(true)}
                style={{
                  padding: '6px 12px', borderRadius: 6, fontSize: 12,
                  border: '1px solid var(--text-secondary)', backgroundColor: 'transparent',
                  color: 'var(--text-secondary)', cursor: 'pointer',
                }}
              >
                {t('plans.archive')}
              </button>
            )}
            <button
              onClick={() => setConfirmDelete(true)}
              style={{
                padding: '6px 12px', borderRadius: 6, fontSize: 12,
                border: '1px solid var(--error, #ef4444)', backgroundColor: 'transparent',
                color: 'var(--error, #ef4444)', cursor: 'pointer',
              }}
            >
              {t('plans.delete')}
            </button>
          </div>
        </div>
        <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 12 }}>{selectedPlan.title}</h1>

        {/* Local plan file path (if this plan was authored from a plan-mode file).
            Click to toggle an inline preview; buttons to open in the OS editor / copy. */}
        {selectedPlan.planFilePath && (
          <div style={{ marginBottom: 12 }}>
            <div
              style={{
                display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px',
                backgroundColor: 'var(--bg-input)', border: '1px solid var(--border)', borderRadius: 8,
                fontFamily: 'monospace', fontSize: 12, color: 'var(--text-secondary)',
              }}
            >
              <span
                onClick={togglePreview}
                title={selectedPlan.planFilePath}
                style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 0, cursor: 'pointer' }}
              >
                <span aria-hidden>{filePreviewOpen ? '▼' : '▶'}</span>
                <span aria-hidden>📄</span>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{selectedPlan.planFilePath}</span>
              </span>
              <button
                onClick={openPlanInEditor}
                title={t('planFile.openInEditor')}
                style={{ background: 'none', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 11, padding: '2px 8px', whiteSpace: 'nowrap' }}
              >
                {t('planFile.openInEditor')}
              </button>
              <button
                onClick={() => navigator.clipboard?.writeText(selectedPlan.planFilePath!)}
                title={t('planFile.copyPath')}
                style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 13 }}
              >
                ⧉
              </button>
            </div>
            {filePreviewOpen && (
              <div
                style={{
                  marginTop: 8, padding: 12, backgroundColor: 'var(--bg-card)',
                  border: '1px solid var(--border)', borderRadius: 8, maxHeight: 360, overflow: 'auto',
                  fontSize: 13,
                }}
              >
                {filePreviewLoading ? (
                  <p style={{ color: 'var(--text-secondary)', fontSize: 12 }}>{t('planFile.preview')}…</p>
                ) : !filePreview?.exists ? (
                  <p style={{ color: 'var(--text-secondary)', fontSize: 12 }}>{t('planFile.notFound')}</p>
                ) : (
                  <>
                    <Markdown remarkPlugins={[remarkGfm]}>{filePreview.content || ''}</Markdown>
                    {filePreview.truncated && (
                      <p style={{ color: 'var(--text-secondary)', fontSize: 11, marginTop: 8, fontStyle: 'italic' }}>{t('planFile.truncated')}</p>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        )}

        {/* Tasks */}
        {tasks.length > 0 && (
          <div style={{ backgroundColor: 'var(--bg-card)', borderRadius: 10, border: '1px solid var(--border)', padding: 20, marginBottom: 20 }}>
            <h3 style={{ fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1, color: 'var(--text-secondary)', marginBottom: 10 }}>
              {t('plans.tasks')}
            </h3>
            <ProgressBar completed={completedTasks} total={tasks.length} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 400, overflowY: 'auto' }}>
              {tasks.map((task) => (
                <TaskItem
                  key={task.id}
                  task={task}
                  expandedNotes={expandedNotes.has(task.id)}
                  onToggleNotes={() => toggleNotes(task.id)}
                  onUpdateTask={handleUpdateTask}
                />
              ))}
            </div>
          </div>
        )}

        {/* Content */}
        <div className="plan-markdown" style={{ backgroundColor: 'var(--bg-card)', borderRadius: 10, border: '1px solid var(--border)', padding: 20, marginBottom: 20 }}>
          <Markdown remarkPlugins={[remarkGfm]}>{selectedPlan.content}</Markdown>
          <div style={{ display: 'flex', gap: 6, marginTop: 16, flexWrap: 'wrap' }}>
            {selectedPlan.tags.map((tag) => (
              <span key={tag} style={{ padding: '3px 10px', borderRadius: 6, fontSize: 11, backgroundColor: 'var(--bg-input)', color: 'var(--accent)' }}>
                {tag}
              </span>
            ))}
          </div>
        </div>

        {/* Relations */}
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 250 }}>
            <h3 style={{ fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1, color: 'var(--text-secondary)', marginBottom: 10 }}>
              {t('plans.input')}
            </h3>
            {inputRelations.length === 0 ? (
              <p style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{t('plans.noRelations')}</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {inputRelations.map((rel) => <RelationCard key={rel.entry.id as string} entry={rel.entry} />)}
              </div>
            )}
          </div>
          <div style={{ flex: 1, minWidth: 250 }}>
            <h3 style={{ fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1, color: 'var(--text-secondary)', marginBottom: 10 }}>
              {t('plans.output')}
            </h3>
            {outputRelations.length === 0 ? (
              <p style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{t('plans.noRelations')}</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {outputRelations.map((rel) => <RelationCard key={rel.entry.id as string} entry={rel.entry} />)}
              </div>
            )}
          </div>
        </div>

        {/* Delete Confirm Modal */}
        <ConfirmModal
          isOpen={confirmDelete}
          onClose={() => setConfirmDelete(false)}
          onConfirm={async () => {
            setDeletingPlan(true);
            try {
              await api.deletePlan(selectedPlan.id);
              setSelectedPlan(null);
              setConfirmDelete(false);
              setSearchParams({}, { replace: true });
              list.reset();
              loadActivePlans();
            } catch { /* silent */ }
            setDeletingPlan(false);
          }}
          title={t('plans.delete')}
          message={t('plans.confirmDelete')}
          loading={deletingPlan}
        />

        {/* Archive Confirm Modal */}
        <ConfirmModal
          isOpen={confirmArchive}
          onClose={() => setConfirmArchive(false)}
          onConfirm={async () => {
            setArchiving(true);
            try {
              await api.updatePlan(selectedPlan.id, { status: 'archived' });
              setSelectedPlan(null);
              setConfirmArchive(false);
              setSearchParams({}, { replace: true });
              list.reset();
              loadActivePlans();
            } catch { /* silent */ }
            setArchiving(false);
          }}
          title={t('plans.archiveTitle')}
          message={t('plans.confirmArchive')}
          loading={archiving}
        />
      </div>
    );
  }

  // ── List View ──
  return (
    <div>
      {showCreateForm ? (
        <>
          <button
            onClick={() => setShowCreateForm(false)}
            style={{
              display: 'flex', alignItems: 'center', gap: 6, marginBottom: 20,
              background: 'none', border: 'none', color: 'var(--text-secondary)',
              cursor: 'pointer', fontSize: 13, padding: 0,
            }}
          >
            ← {t('plans.title')}
          </button>
          <CreatePlanForm
            onCreated={() => { setShowCreateForm(false); list.reset(); loadActivePlans(); }}
            onCancel={() => setShowCreateForm(false)}
          />
        </>
      ) : (
        <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h1 style={{ fontSize: 20, fontWeight: 700 }}>{t('plans.title')}</h1>
      </div>

      {/* ── Active Plans Section ── */}
      {activePlans.length > 0 && (
        <div style={{ marginBottom: 24 }}>
          <h2 style={{ fontSize: 13, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1, color: 'var(--text-secondary)', marginBottom: 10 }}>
            {t('plans.activePlans')}
          </h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(350px, 1fr))', gap: 12 }}>
            {activePlans.map((plan) => {
              const planTasks = activeTasksMap[plan.id] || [];
              const done = planTasks.filter((t) => t.status === 'completed').length;
              return (
                <div
                  key={plan.id}
                  onClick={() => selectPlan(plan)}
                  style={{
                    backgroundColor: 'var(--bg-card)', borderRadius: 10,
                    borderLeft: '3px solid #3b82f6', border: '1px solid #3b82f644',
                    borderLeftWidth: 3, borderLeftColor: '#3b82f6',
                    padding: 16, cursor: 'pointer',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                    <h3 style={{ fontSize: 14, fontWeight: 600, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{plan.title}</h3>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0 }}>
                      <span style={{ fontSize: 10, color: 'var(--text-secondary)' }}>{plan.scope}</span>
                      <StatusBadge status="active" />
                    </div>
                  </div>
                  {planTasks.length > 0 && (
                    <>
                      <ProgressBar completed={done} total={planTasks.length} />
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 200, overflowY: 'auto' }}>
                        {planTasks.map((task) => (
                          <div key={task.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                            <TaskStatusIcon status={task.status} />
                            <span style={{
                              color: task.status === 'completed' ? 'var(--text-secondary)' : 'var(--text-primary)',
                              textDecoration: task.status === 'completed' ? 'line-through' : 'none',
                            }}>
                              {task.description}
                            </span>
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Status + Scope Filters ── */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 20, alignItems: 'center', flexWrap: 'wrap' }}>
        {statusFilters.map((s) => (
          <button
            key={s || 'all'}
            onClick={() => { setStatusFilter(s); setSelectedPlan(null); }}
            style={{
              padding: '6px 14px', borderRadius: 6, fontSize: 12, fontWeight: 600,
              border: statusFilter === s ? '1px solid var(--accent)' : '1px solid var(--border)',
              backgroundColor: statusFilter === s ? 'var(--accent)' : 'var(--bg-card)',
              color: statusFilter === s ? '#fff' : 'var(--text-secondary)',
              cursor: 'pointer',
            }}
          >
            {s ? t(`plans.${s}`) : t('plans.all')}
          </button>
        ))}
        <select
          value={scopeFilter}
          onChange={(e) => { setScopeFilter(e.target.value); setSelectedPlan(null); }}
          style={{
            marginLeft: 'auto', padding: '6px 10px', borderRadius: 6,
            backgroundColor: 'var(--bg-input)', border: '1px solid var(--border)',
            color: scopeFilter ? 'var(--text-primary)' : 'var(--text-secondary)', fontSize: 12,
          }}
        >
          <option value="">{t('plans.allScopes')}</option>
          {allScopes.map((sc) => (
            <option key={sc} value={sc}>{sc}</option>
          ))}
        </select>
      </div>

      <div>
        {/* ── Plans List ── */}
        <div>
          {list.items.length === 0 && list.loadingMore ? (
            <p style={{ color: 'var(--text-secondary)' }}>{t('plans.loading')}</p>
          ) : list.items.length === 0 ? (
            <p style={{ color: 'var(--text-secondary)' }}>{t('plans.empty')}</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {list.items.map((plan) => {
                const planTasks = plan.id === selectedPlan?.id ? tasks : [];
                const done = planTasks.filter((t) => t.status === 'completed').length;
                return (
                  <div
                    key={plan.id}
                    onClick={() => selectPlan(plan)}
                    style={{
                      backgroundColor: selectedPlan?.id === plan.id ? 'var(--accent-bg, rgba(99,102,241,0.1))' : 'var(--bg-card)',
                      borderRadius: 10,
                      border: selectedPlan?.id === plan.id ? '1px solid var(--accent)' : '1px solid var(--border)',
                      padding: 16, cursor: 'pointer', transition: 'all 0.15s',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                      <StatusBadge status={plan.status} />
                      <span style={{ fontSize: 10, color: 'var(--text-secondary)' }}>{plan.scope}</span>
                    </div>
                    <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>
                      {plan.title || 'Untitled Plan'}
                    </h3>
                    <div style={{ display: 'flex', gap: 4, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                      {plan.tags.slice(0, 5).map((tag) => (
                        <span key={tag} style={{ padding: '1px 6px', borderRadius: 3, fontSize: 10, backgroundColor: 'var(--bg-input)', color: 'var(--text-secondary)' }}>
                          {tag}
                        </span>
                      ))}
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 6 }}>
                      <span style={{ fontSize: 10, color: 'var(--text-secondary)' }}>
                        {new Date(plan.createdAt).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'medium' })}
                        {plan.updatedAt && plan.updatedAt !== plan.createdAt && (
                          <> • updated {new Date(plan.updatedAt).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'medium' })}</>
                        )}
                      </span>
                      {planTasks.length > 0 && <MiniProgress completed={done} total={planTasks.length} />}
                    </div>
                  </div>
                );
              })}
              {/* Infinite-scroll sentinel + footer */}
              <div ref={list.sentinelRef} style={{ height: 1 }} />
              {list.loadingMore && (
                <p style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: 12, fontSize: 12 }}>{t('list.loadingMore')}</p>
              )}
              {!list.hasMore && list.items.length > PAGE_SIZE && (
                <p style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: 12, fontSize: 12 }}>{t('list.noMore')}</p>
              )}
            </div>
          )}
        </div>

      </div>

      {/* FAB */}
      <FloatingAddButton onClick={() => setShowCreateForm(true)} />
        </>
      )}
    </div>
  );
}

function RelationCard({ entry }: { entry: Record<string, unknown> }) {
  const type = entry.type as string;
  return (
    <a
      href={`/?edit=${entry.id as string}`}
      style={{
        display: 'block', textDecoration: 'none', color: 'inherit',
        backgroundColor: 'var(--bg-main)', borderRadius: 6, border: '1px solid var(--border)',
        padding: 10, fontSize: 12, cursor: 'pointer', transition: 'border-color 0.15s',
      }}
      onMouseEnter={(e) => (e.currentTarget.style.borderColor = 'var(--accent)')}
      onMouseLeave={(e) => (e.currentTarget.style.borderColor = 'var(--border)')}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
        <span style={{
          padding: '2px 8px', borderRadius: 4, fontSize: 10, fontWeight: 600,
          backgroundColor: TYPE_COLORS[type] || '#6b7280', color: '#fff',
        }}>
          {type}
        </span>
        <span style={{ fontWeight: 600 }}>{(entry.title as string) || (entry.content as string)?.slice(0, 60)}</span>
      </div>
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        {((entry.tags as string[]) || []).slice(0, 4).map((tag) => (
          <span key={tag} style={{ padding: '1px 5px', borderRadius: 3, fontSize: 9, backgroundColor: 'var(--bg-input)', color: 'var(--text-secondary)' }}>
            {tag}
          </span>
        ))}
      </div>
    </a>
  );
}
