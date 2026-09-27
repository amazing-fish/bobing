// Web Worker：在后台线程跑权威物理仿真，避免掷骰时主线程卡顿
import { initPhysics, simulateThrow } from './physics.js';

const ready = initPhysics();

self.onmessage = async (e) => {
  const { id, opts } = e.data;
  try {
    await ready;
    const r = simulateThrow(opts);
    self.postMessage({ id, ok: true, result: r }, [r.frames.buffer]);
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err?.message || err) });
  }
};
