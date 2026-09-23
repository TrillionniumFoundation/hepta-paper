import { assertSchedulerPort } from '../../paper-ports/scheduler-port.mjs';

export function createSystemScheduler() {
  return assertSchedulerPort(Object.freeze({
    version: 1,
    kind: 'SystemSchedulerAdapter',
    sleep(milliseconds, { signal = null } = {}) {
      if (signal?.aborted) return Promise.reject(new Error(String(signal.reason || 'scheduler_sleep_aborted')));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          signal?.removeEventListener?.('abort', abort);
          resolve();
        }, Math.max(0, Number(milliseconds) || 0));
        const abort = () => {
          clearTimeout(timer);
          signal?.removeEventListener?.('abort', abort);
          reject(new Error(String(signal.reason || 'scheduler_sleep_aborted')));
        };
        signal?.addEventListener?.('abort', abort, { once: true });
      });
    },
    setInterval(callback, milliseconds) {
      return setInterval(callback, Math.max(1, Number(milliseconds) || 1));
    },
    clearInterval(handle) {
      clearInterval(handle);
    },
    unref(handle) {
      handle?.unref?.();
    },
  }));
}
