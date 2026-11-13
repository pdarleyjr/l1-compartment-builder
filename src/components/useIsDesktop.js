import { useEffect, useState } from 'react';

const DESKTOP_QUERY = '(min-width: 1024px)';

/** True at the `lg` breakpoint and up (the sidebar is persistent there, a drawer below). */
export function useIsDesktop() {
  const [match, setMatch] = useState(() => window.matchMedia?.(DESKTOP_QUERY).matches ?? true);
  useEffect(() => {
    const mq = window.matchMedia?.(DESKTOP_QUERY);
    if (!mq) return undefined;
    const on = e => setMatch(e.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return match;
}
