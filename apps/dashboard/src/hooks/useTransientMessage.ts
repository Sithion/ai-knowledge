import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Transient inline message with auto-clear — the app's lightweight alternative
 * to a toast library (generalizes the setMessage + setTimeout pattern).
 *
 * Error-feedback rule for this codebase: USER-INITIATED mutations must surface
 * failure (via this hook or ConfirmModal's errorText); background polls/loads
 * stay silent by design.
 */
export function useTransientMessage(timeoutMs = 5000): [string | null, (msg: string | null) => void] {
  const [message, setMessage] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const set = useCallback((msg: string | null) => {
    if (timer.current) clearTimeout(timer.current);
    setMessage(msg);
    if (msg !== null) {
      timer.current = setTimeout(() => setMessage(null), timeoutMs);
    }
  }, [timeoutMs]);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  return [message, set];
}
