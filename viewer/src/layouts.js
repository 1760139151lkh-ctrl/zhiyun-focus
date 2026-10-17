import { bounded } from './geometry.js';
import { sameAspect } from './view-state.js';
import {studyLessonScope} from './study-context.js';

export const LAYOUT_PREFIX = '__zjf_layout_v1:';
export const MAX_BOARDS = 6;
export function lessonLayoutKey(href, role = 'video-0') {
  try {
    const url = new URL(href), direct = url.searchParams, hash = new URLSearchParams(url.hash.split('?')[1] || '');
    const get = k => direct.get(k) || hash.get(k);
    const values = [get('tenant_code') || '112', get('course_id'), get('sub_id')];
    if (!values.every(x => /^\d{1,12}$/.test(x || ''))) return null;
    return LAYOUT_PREFIX + values.join(':') + ':' + String(role).replace(/[^a-zA-Z0-9_-]/g, '').slice(0,48);
  } catch { return null; }
}
export function cleanLayout(value) {
  if (!value || value.schema !== 1 || !Array.isArray(value.boards) || value.boards.length > MAX_BOARDS) return null;
  if (!Array.isArray(value.dimensions) || value.dimensions.length !== 2 || !value.dimensions.every(x => Number.isFinite(x) && x > 0)) return null;
  if (value.mediaIdentity!==undefined&&!/^[a-f0-9]{64}$/.test(value.mediaIdentity)) return null;
  const ids = new Set(), boards = [];
  for (const b of value.boards) {
    if (!b || typeof b.id !== 'string' || !/^b\d{1,8}$/.test(b.id) || ids.has(b.id)) return null;
    if (!b.roi || !['x','y','w','h'].every(k => Number.isFinite(b.roi[k])) || b.roi.w <= 0 || b.roi.h <= 0) return null;
    const view=b.view&&['x','y','w','h'].every(k=>Number.isFinite(b.view[k]))&&b.view.w>0&&b.view.h>0?bounded(b.view):null;
    // The drawn board stays stable while its latest reading view can move.
    // An invalid optional view must not discard the saved board definition.
    ids.add(b.id); boards.push({ id:b.id, name:String(b.name || '板位').replace(/[\u0000-\u001f]/g,'').slice(0,24), roi:bounded(b.roi), ...(view?{view}:{}) });
  }
  return { schema:1, dimensions:value.dimensions.slice(0,2), duration:Number.isFinite(value.duration)?value.duration:null,
    boards, active:ids.has(value.active)?value.active:boards[0]?.id || null, updated:Number.isFinite(value.updated)?value.updated:0,
    ...(value.mediaIdentity?{mediaIdentity:value.mediaIdentity}:{}) };
}
export function layoutMatches(layout, dimensions, duration) {
  return sameAspect(layout?.dimensions, dimensions) && (!layout.duration || !duration || Math.abs(layout.duration-duration) < Math.max(3,duration*.01));
}
export function layoutRepository(storageProvider, memory) {
  let persistent = true;
  const read = key => {
    if (!key) { persistent=false; return null; }
    if(memory.has(key)&&memory.get(key)===null)return null;
    const cached=cleanLayout(memory.get(key));let disk=null;
    try { const text=storageProvider().getItem(key); if(text) disk=cleanLayout(JSON.parse(text)); }
    catch { persistent=false; }
    const best=cached&&(!disk||cached.updated>=disk.updated)?cached:disk;
    if(best)memory.set(key,best);return best;
  };
  const write = (key, value) => {
    const clean=cleanLayout(value); if (!key || !clean) return false;
    memory.set(key,clean);
    try { storageProvider().setItem(key,JSON.stringify(clean)); return true; }
    catch { persistent=false; return false; }
  };
  const readForMedia = (key, mediaIdentity, dimensions, duration) => {
    const prefix=studyLessonScope(key)+':',keys=new Set([...memory.keys()].filter(value=>value.startsWith(prefix)));
    try{const storage=storageProvider();for(let i=0;i<storage.length;i++){const value=storage.key(i);if(value?.startsWith(prefix))keys.add(value);}}catch{persistent=false;}
    let best=null;for(const candidate of keys){const value=read(candidate);if(value?.mediaIdentity===mediaIdentity&&layoutMatches(value,dimensions,duration)&&(!best||value.updated>best.updated))best=value;}
    return best;
  };
  const clear = key => {
    if(key) memory.set(key,null); else for(const k of memory.keys()) if(k.startsWith(LAYOUT_PREFIX)) memory.set(k,null);
    try {
      const s=storageProvider();
      if(key) s.removeItem(key);
      else { const keys=[];for(let i=0;i<s.length;i++){const k=s.key(i);if(k?.startsWith(LAYOUT_PREFIX))keys.push(k);}keys.forEach(k=>s.removeItem(k)); }
      return true;
    } catch { persistent=false; return false; }
  };
  return {read,readForMedia,write,clear,get persistent(){return persistent;}};
}
