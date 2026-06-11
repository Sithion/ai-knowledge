import { useState, useEffect, useCallback } from 'react';
import { api, type SetupStatus } from '../api/client.js';

declare const __APP_VERSION__: string;

type StepStatus = 'pending' | 'running' | 'done' | 'error';

interface Step {
  id: string;
  label: string;
  status: StepStatus;
  error?: string;
}

export function SetupPage({ onComplete }: { onComplete: () => void }) {
  const [steps, setSteps] = useState<Step[]>([
    { id: 'node', label: 'Installing Node.js v24', status: 'pending' },
    { id: 'ollama', label: 'Installing Ollama', status: 'pending' },
    { id: 'ollama-start', label: 'Starting Ollama', status: 'pending' },
    { id: 'database', label: 'Creating database', status: 'pending' },
    { id: 'model', label: 'Downloading AI model', status: 'pending' },
    { id: 'configure', label: 'Configuring agents', status: 'pending' },
    { id: 'complete', label: 'Finishing setup', status: 'pending' },
  ]);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);

  const updateStep = useCallback((id: string, updates: Partial<Step>) => {
    setSteps(prev => prev.map(s => s.id === id ? { ...s, ...updates } : s));
  }, []);

  const runSetup = useCallback(async () => {
    if (running) return;
    setRunning(true);

    // Reset error steps
    setSteps(prev => prev.map(s => s.status === 'error' ? { ...s, status: 'pending', error: undefined } : s));

    try {
      let status: SetupStatus;
      try { status = await api.getSetupStatus(); }
      catch { status = { nodeReady: false, ollamaInstalled: false, ollamaRunning: false, databaseReady: false, modelAvailable: false, configsReady: false, sdkReady: false, allReady: false }; }

      // Step 0: Install Node.js v24
      if (status.nodeReady) {
        updateStep('node', { status: 'done' });
      } else {
        updateStep('node', { status: 'running' });
        const res = await api.setupNode();
        if (!res.success) { updateStep('node', { status: 'error', error: res.message }); setRunning(false); return; }
        updateStep('node', { status: 'done' });
      }

      // Step 1: Install Ollama
      if (status.ollamaInstalled) {
        updateStep('ollama', { status: 'done' });
      } else {
        updateStep('ollama', { status: 'running' });
        const res = await api.setupOllama();
        if (!res.success) { updateStep('ollama', { status: 'error', error: res.message }); setRunning(false); return; }
        updateStep('ollama', { status: 'done' });
      }

      // Step 2: Start Ollama
      if (status.ollamaRunning) {
        updateStep('ollama-start', { status: 'done' });
      } else {
        updateStep('ollama-start', { status: 'running' });
        const res = await api.setupOllamaStart();
        if (!res.success) { updateStep('ollama-start', { status: 'error', error: res.message }); setRunning(false); return; }
        updateStep('ollama-start', { status: 'done' });
      }

      // Step 3: Create database
      if (status.databaseReady) {
        updateStep('database', { status: 'done' });
      } else {
        updateStep('database', { status: 'running' });
        const res = await api.setupDatabase();
        if (!res.success) { updateStep('database', { status: 'error', error: res.message }); setRunning(false); return; }
        updateStep('database', { status: 'done' });
      }

      // Step 4: Pull model
      if (status.modelAvailable) {
        updateStep('model', { status: 'done' });
      } else {
        updateStep('model', { status: 'running' });
        const res = await api.setupModel();
        if (!res.success) { updateStep('model', { status: 'error', error: res.message }); setRunning(false); return; }
        updateStep('model', { status: 'done' });
      }

      // Step 5: Configure agents
      if (status.configsReady) {
        updateStep('configure', { status: 'done' });
      } else {
        updateStep('configure', { status: 'running' });
        const res = await api.setupConfigure();
        if (!res.success) { updateStep('configure', { status: 'error', error: res.message }); setRunning(false); return; }
        updateStep('configure', { status: 'done' });
      }

      // Step 6: Complete
      updateStep('complete', { status: 'running' });
      const res = await api.setupComplete();
      if (!res.success) { updateStep('complete', { status: 'error', error: res.message }); setRunning(false); return; }
      updateStep('complete', { status: 'done' });

      setDone(true);
    } catch (err) {
      console.error('Setup failed:', err);
    } finally {
      setRunning(false);
    }
  }, [running, updateStep]);

  useEffect(() => { runSetup(); }, []);

  const stepIcon = (status: StepStatus) => {
    switch (status) {
      case 'pending': return '⬜';
      case 'running': return '⏳';
      case 'done': return '✅';
      case 'error': return '❌';
    }
  };

  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      height: '100vh', background: 'var(--bg-main)', flexDirection: 'column', gap: 32,
    }}>
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: 48, marginBottom: 8 }}>🧠</div>
        <h1 style={{ fontSize: 24, fontWeight: 700, color: 'var(--accent)' }}>CogniStore</h1>
        <p style={{ color: 'var(--text-secondary)', fontSize: 11, marginTop: 4, opacity: 0.6 }}>v{__APP_VERSION__}</p>
        <p style={{ color: 'var(--text-secondary)', fontSize: 14, marginTop: 8 }}>Setting up your environment...</p>
      </div>

      <div style={{
        backgroundColor: 'var(--bg-card)', borderRadius: 12,
        border: '1px solid var(--border)', padding: 24,
        minWidth: 400, maxWidth: 500,
      }}>
        {steps.map(step => (
          <div key={step.id} style={{
            display: 'flex', alignItems: 'center', gap: 12,
            padding: '10px 0',
            borderBottom: step.id !== 'complete' ? '1px solid var(--border)' : 'none',
            opacity: step.status === 'pending' ? 0.5 : 1,
          }}>
            <span style={{ fontSize: 18, width: 24, textAlign: 'center' }}>
              {stepIcon(step.status)}
            </span>
            <div style={{ flex: 1 }}>
              <span style={{ fontSize: 14, fontWeight: step.status === 'running' ? 600 : 400 }}>
                {step.label}
              </span>
              {step.error && (
                <p style={{ fontSize: 11, color: 'var(--error)', marginTop: 2, whiteSpace: 'pre-wrap' }}>{step.error}</p>
              )}
            </div>
          </div>
        ))}
      </div>

      {done && (
        <button
          onClick={onComplete}
          style={{
            padding: '12px 32px', borderRadius: 8, border: 'none',
            backgroundColor: 'var(--accent)', color: '#fff',
            fontSize: 16, fontWeight: 600, cursor: 'pointer',
          }}
        >
          Open Dashboard
        </button>
      )}

      {steps.some(s => s.status === 'error') && !running && (
        <button
          onClick={runSetup}
          style={{
            padding: '10px 24px', borderRadius: 8,
            border: '1px solid var(--accent)', backgroundColor: 'transparent',
            color: 'var(--accent)', fontSize: 14, cursor: 'pointer',
          }}
        >
          Retry Setup
        </button>
      )}
    </div>
  );
}
