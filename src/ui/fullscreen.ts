import { useEffect, useState } from 'react';

/** Browser full screen for the whole Mission Control page (Esc leaves it). */
export function toggleFullscreen(): void {
  try {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen();
  } catch {
    /* not available (e.g. embedded preview) */
  }
}

export function useFullscreen(): boolean {
  const [fs, setFs] = useState(typeof document !== 'undefined' && !!document.fullscreenElement);
  useEffect(() => {
    const on = () => setFs(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', on);
    return () => document.removeEventListener('fullscreenchange', on);
  }, []);
  return fs;
}
