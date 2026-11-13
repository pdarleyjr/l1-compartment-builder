import { useEffect, useState } from 'react';

/** Object URL for a Blob that is revoked when the blob changes or the component unmounts. @param {Blob|null|undefined} blob @returns {string|null} */
export function useObjectUrl(blob) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    if (!blob) { setUrl(null); return undefined; }
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [blob]);
  return url;
}
