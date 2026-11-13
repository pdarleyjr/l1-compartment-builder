import { createContext, useContext } from 'react';

/** Toast context (provider lives in Toast.jsx). */
export const ToastCtx = createContext(() => {});
/** @returns {(message:string, kind?:'info'|'success'|'error')=>void} */
export const useToast = () => useContext(ToastCtx);
