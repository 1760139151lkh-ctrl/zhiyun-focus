import { imageCoversVideo } from './view-state.js';
import { mountViewer } from './viewer-ui.js';

export function activateFocus(resume,attempt) {
  'use strict';
  attempt=Number(attempt)||0;
  const KEY = '__ZJU_FOCUS_LOCAL_V1__';
  const VERSION = '1.9.6';
  const BUILD = '__ZJF_VIEWER_BUILD_ID__';
  const requestKey=location.href;
  function awaitVideo(){
    if(attempt>=12)return;
    clearTimeout(window.__ZJF_FOCUS_WAIT__);
    window.__ZJF_FOCUS_WAIT__=setTimeout(()=>{if(location.href===requestKey)activateFocus(resume,attempt+1);},500);
  }
  let previous = resume || null;
  if (window[KEY]?.close) {
    const current=window[KEY];
    if (current.version === VERSION && current.build === BUILD) { current.reveal(); return; }
    const activeVideo = document.querySelector('video[data-zjf-video]');
    if (activeVideo && activeVideo.readyState < 2) { awaitVideo(); return; }
    previous = current.inspect?.();
    const closing=current.close({preserveFullscreen:true});if(closing?.then)return closing.then(done=>{if(done)activateFocus(current.inspect?.()||previous)});if(closing===false)return;previous=current.inspect?.()||previous;
  }
  const allowed = ['classroom.zju.edu.cn', 'onlineroom.cmc.zju.edu.cn', 'interactivemeta.cmc.zju.edu.cn', 'webvpn.zju.edu.cn', '127.0.0.1', 'localhost'];
  if (!allowed.includes(location.hostname)) { console.debug('[智云聚焦]','请在已获准观看的智云回放页面使用「智云聚焦」。'); return; }
  const visible = v => {
    const b = v.getBoundingClientRect(), s = getComputedStyle(v);
    if (v.checkVisibility && !v.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    return b.width > 150 && b.height > 80 && s.display !== 'none' && s.visibility === 'visible';
  };
  const candidates = [...document.querySelectorAll('video')].filter(v => visible(v) && v.readyState >= 2 && v.videoWidth > 0);
  candidates.sort((a, b) => {
    const r = a.getBoundingClientRect(), q = b.getBoundingClientRect();
    return q.width * q.height - r.width * r.height;
  });
  const video = candidates[0];
  if (!video) { awaitVideo(); return; }
  if (document.fullscreenElement === video && typeof HTMLElement.prototype.showPopover!=='function') { console.debug('[智云聚焦]','当前播放器全屏暂不能显示聚焦操作。课程画面未改动。'); return; }
  const chain = [];
  for (let e = video.parentElement; e; e = e.parentElement) {
    const s = getComputedStyle(e);
    if (s.transform !== 'none' || s.filter !== 'none' || s.perspective !== 'none' || /paint|layout|strict|content/.test(s.contain) || s.clipPath !== 'none') {
      console.debug('[智云聚焦]','这个页面的显示布局暂不适配。请使用原播放器全屏；本次没有改动视频。'); return;
    }
    if (s.position !== 'static') chain.push(e);
  }
  if (getComputedStyle(video).transform !== 'none') { console.debug('[智云聚焦]','视频已有特殊显示变换，请先恢复原播放器再试。'); return; }
  // Refuse an opaque slide/image covering the apparent video rather than selecting hidden media.
  const initialRect = video.getBoundingClientRect();
  const centerX = initialRect.x + initialRect.width / 2, centerY = initialRect.y + initialRect.height / 2;
  const top = centerX >= 0 && centerX < innerWidth && centerY >= 0 && centerY < innerHeight ? document.elementFromPoint(centerX, centerY) : null;
  if (top?.tagName === 'IMG' && !video.parentElement.contains(top) && imageCoversVideo(initialRect, top.getBoundingClientRect())) {
    console.debug('[智云聚焦]','当前主画面是课件图片。请先在原播放器切到要聚焦的视频画面。'); return;
  }
  const token = 'zf' + Math.random().toString(36).slice(2);
  const originalControls = video.controls;
  const oldVideoMark = video.getAttribute('data-zjf-video');
  const oldChain = chain.map(e => [e, e.getAttribute('data-zjf-raise')]);
  const oldPage = [document.documentElement, document.body].map(e => [e, e.getAttribute('data-zjf-page')]);
  const css = document.createElement('style');
  css.id = 'zjf-style';
  css.textContent = `
    [data-zjf-raise="${token}"] { z-index:2147483000!important; }
    [data-zjf-page="${token}"] { overflow:hidden!important; overscroll-behavior:none!important; }
    video[data-zjf-video="${token}"] { position:fixed!important; left:var(--zjf-left)!important; top:var(--zjf-top)!important;
      width:var(--zjf-width)!important;height:var(--zjf-height)!important;min-width:0!important;min-height:0!important;
      max-width:none!important;max-height:none!important;margin:0!important;padding:0!important;border:0!important;
      transform:none!important;object-fit:fill!important;z-index:2147483002!important;clip-path:var(--zjf-clip)!important;
      transition:none!important;animation:none!important;pointer-events:none!important; }
    video[data-zjf-video="${token}"][data-zjf-moving] {transition:left .28s cubic-bezier(.22,1,.36,1),top .28s cubic-bezier(.22,1,.36,1),width .28s cubic-bezier(.22,1,.36,1),height .28s cubic-bezier(.22,1,.36,1),clip-path .28s cubic-bezier(.22,1,.36,1)!important;}
    @media(prefers-reduced-motion:reduce){video[data-zjf-video="${token}"][data-zjf-moving]{transition:none!important;}}
  `;
  const propertyNames = ['--zjf-left', '--zjf-top', '--zjf-width', '--zjf-height', '--zjf-clip'];
  const oldProperties = propertyNames.map(n => [n, video.style.getPropertyValue(n), video.style.getPropertyPriority(n)]);
  const hadStyle = video.hasAttribute('style');
  const background = document.createElement('div');
  background.id = 'zjf-background';
  background.style.cssText = 'position:fixed!important;inset:0!important;background:#191817!important;z-index:2147483001!important;pointer-events:none!important';
  const host = document.createElement('div');
  host.id = 'zjf-root';
  host.style.cssText = 'position:fixed!important;inset:0!important;margin:0!important;padding:0!important;border:0!important;background:transparent!important;overflow:visible!important;width:auto!important;height:auto!important;z-index:2147483003!important;pointer-events:none!important;font:14px/1.5 "Microsoft YaHei","Segoe UI",sans-serif!important;color:#ededed!important;text-align:left!important;letter-spacing:normal!important;direction:ltr!important;';
  mountViewer({video,host,css,background,chain,token,oldPage,oldChain,oldVideoMark,originalControls,oldProperties,hadStyle,KEY,VERSION,BUILD,previous,visible,activateFocus});
}
