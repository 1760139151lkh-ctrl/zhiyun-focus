export const FULL = Object.freeze({ x: 0, y: 0, w: 1, h: 1 });
export const clamp = (n, low, high) => Math.min(high, Math.max(low, n));

export function bounded(r) {
  if (!r || !['x', 'y', 'w', 'h'].every(k => Number.isFinite(r[k]))) return { ...FULL };
  const w = clamp(r.w, .015, 1), h = clamp(r.h, .015, 1);
  return { x: clamp(r.x, 0, 1 - w), y: clamp(r.y, 0, 1 - h), w, h };
}

export function placement(roi, sw, sh, vw, vh) {
  if (![sw, sh, vw, vh].every(n => Number.isFinite(n) && n > 0)) return null;
  const r = bounded(roi);
  const scale = Math.min(vw / (sw * r.w), vh / (sh * r.h), 8192 / sw, 8192 / sh);
  const width = sw * scale, height = sh * scale;
  const x = (vw - width * r.w) / 2, y = (vh - height * r.h) / 2;
  return { scale, width, height, left: x - width * r.x, top: y - height * r.y,
    crop: [height * r.y, width * (1 - r.x - r.w), height * (1 - r.y - r.h), width * r.x],
    view: { x, y, w: width * r.w, h: height * r.h } };
}

// The history image uses CSS object-fit:contain, including enlarging small
// originals. Video zoom limits do not apply to that displayed image.
export function imagePlacement(sw,sh,vw,vh){
  if(![sw,sh,vw,vh].every(value=>Number.isFinite(value)&&value>0))return null;
  const scale=Math.min(vw/sw,vh/sh),width=sw*scale,height=sh*scale,left=(vw-width)/2,top=(vh-height)/2;
  return {scale,width,height,left,top,crop:[0,0,0,0],view:{x:left,y:top,w:width,h:height}};
}

export function sourcePoint(p, layout) {
  return { x: clamp((p.x - layout.left) / layout.width, 0, 1),
    y: clamp((p.y - layout.top) / layout.height, 0, 1) };
}

export function between(a, b) {
  return bounded({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) });
}

export function pan(r, dx, dy, layout) {
  return bounded({ ...r, x: r.x - dx / layout.width, y: r.y - dy / layout.height });
}

export function zoom(r, anchor, factor) {
  const w = clamp(r.w * factor, .015, 1), h = clamp(r.h * factor, .015, 1);
  return bounded({ x: anchor.x - (anchor.x - r.x) * w / r.w,
    y: anchor.y - (anchor.y - r.y) * h / r.h, w, h });
}
