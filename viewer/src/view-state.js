import { FULL, bounded } from './geometry.js';

export function sameAspect(a, b) {
  return a?.length === 2 && b?.length === 2 && [...a, ...b].every(n => Number.isFinite(n) && n > 0)
    && Math.abs(a[0] / a[1] - b[0] / b[1]) < .001;
}

export function restoredView(previous, size) {
  const r = previous?.roi;
  if (!r || previous.mode === 'select' || !['x','y','w','h'].every(k => Number.isFinite(r[k])) || !sameAspect(previous.dimensions, size)) return null;
  const roi = bounded(r);
  return { roi, mode: 'focus' };
}

export function resetForMedia(oldSize, newSize, sourceChanged, sameLesson) {
  if (!newSize.every(n => Number.isFinite(n) && n > 0)) return false;
  return !sameAspect(oldSize, newSize) || (sourceChanged && !sameLesson);
}

export function imageCoversVideo(video, image) {
  const overlapWidth = Math.max(0, Math.min(video.right, image.right) - Math.max(video.left, image.left));
  const overlapHeight = Math.max(0, Math.min(video.bottom, image.bottom) - Math.max(video.top, image.top));
  return video.width > 0 && video.height > 0 && overlapWidth * overlapHeight >= .65 * video.width * video.height;
}

// Comparison only, never persisted: authentication/query refreshes are not camera changes.
export function sameMediaResource(a,b) {
  if(a===b)return true;
  try{const x=new URL(a),y=new URL(b);return x.origin===y.origin&&x.pathname===y.pathname}catch{return false}
}
