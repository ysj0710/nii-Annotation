self.onmessage = (event) => {
  const payload = event?.data || {};
  const id = Number(payload?.id || 0);
  const nx = Math.max(0, Number(payload?.nx || 0));
  const ny = Math.max(0, Number(payload?.ny || 0));
  const nz = Math.max(1, Number(payload?.nz || 1));
  const buffer = payload?.buffer;
  if (!id || !(buffer instanceof ArrayBuffer) || nx < 1 || ny < 1 || nz < 1) {
    self.postMessage({ id, stats: {} });
    return;
  }
  const bitmap = new Uint8Array(buffer);
  const expected = nx * ny * nz;
  const total = Math.min(expected, bitmap.length);
  const stats = Object.create(null);
  for (let i = 0; i < total; i += 1) {
    const value = Number(bitmap[i] || 0);
    if (value <= 0) continue;
    const key = String(value);
    stats[key] = Number(stats[key] || 0) + 1;
  }
  self.postMessage({ id, stats });
};

