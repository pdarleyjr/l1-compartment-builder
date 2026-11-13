/** True when a live viewfinder can be offered (API present and not blocked by Permissions-Policy). */
export function canUseLiveCamera() {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) return false;
  const policy = typeof document !== 'undefined' ? document.permissionsPolicy ?? document.featurePolicy : null;
  try { if (policy?.allowsFeature && policy.allowsFeature('camera') === false) return false; } catch { /* ignore */ }
  return true;
}
