// Structural diff between the original and edited trees. Every change must
// fall under a path an operation declared as touched; anything else aborts the write.

const isRaw = (v) => JSON.isRawJSON(v);
const isObj = (v) => v !== null && typeof v === 'object' && !isRaw(v);

function same(a, b) {
  if (isRaw(a) || isRaw(b)) return isRaw(a) && isRaw(b) && a.rawJSON === b.rawJSON;
  return a === b;
}

const startsWith = (path, prefix) => prefix.length <= path.length && prefix.every((k, i) => String(path[i]) === String(k));

export function diffTrees(a, b, allowed) {
  const changed = [];
  const unexpected = [];
  const walk = (x, y, path) => {
    if (allowed.some((p) => startsWith(path, p) && p.length === path.length)) {
      if (!deepEqual(x, y)) changed.push(path);
      return;
    }
    if (isObj(x) && isObj(y) && Array.isArray(x) === Array.isArray(y)) {
      const kx = Object.keys(x);
      const ky = Object.keys(y);
      if (kx.length !== ky.length || kx.some((k, i) => k !== ky[i])) {
        if (unexpected.length < 20) unexpected.push(path.join('.') || '(root)');
        return;
      }
      for (const k of kx) walk(x[k], y[k], [...path, Array.isArray(x) ? Number(k) : k]);
      return;
    }
    if (!same(x, y) && unexpected.length < 20) unexpected.push(path.join('.'));
  };
  walk(a, b, []);
  return { changed, unexpected };
}

function deepEqual(x, y) {
  if (isObj(x) && isObj(y)) {
    if (Array.isArray(x) !== Array.isArray(y)) return false;
    const kx = Object.keys(x);
    const ky = Object.keys(y);
    if (kx.length !== ky.length) return false;
    return kx.every((k, i) => k === ky[i] && deepEqual(x[k], y[k]));
  }
  return same(x, y);
}
