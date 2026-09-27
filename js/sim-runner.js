// 权威仿真的调用入口：优先放到 Worker 里算，不支持模块 Worker 时退回主线程
import { initPhysics, simulateThrow } from './physics.js';

let worker = null;
let failed = false;
let seq = 0;
const pending = new Map();

function getWorker() {
  if (worker || failed || typeof Worker === 'undefined') return worker;
  try {
    worker = new Worker(new URL('./sim-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const p = pending.get(e.data.id);
      if (!p) return;
      pending.delete(e.data.id);
      e.data.ok ? p.resolve(e.data.result) : p.reject(new Error(e.data.error));
    };
    worker.onerror = (e) => {
      // Worker 无法加载（例如旧版 Safari 不支持模块 Worker）：改用主线程
      e.preventDefault?.();
      failed = true;
      worker = null;
      for (const [id, p] of pending) p.fallback();
      pending.clear();
    };
  } catch {
    failed = true;
    worker = null;
  }
  return worker;
}

/** 预先启动 Worker（加载物理引擎需要一点时间） */
export function warmSim() {
  getWorker();
}

/** @returns {Promise<ReturnType<typeof simulateThrow>>} */
export function runSim(opts) {
  const onMain = async () => {
    await initPhysics();
    return simulateThrow(opts);
  };
  const w = getWorker();
  if (!w) return onMain();
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject, fallback: () => onMain().then(resolve, reject) });
    w.postMessage({ id, opts });
  });
}
