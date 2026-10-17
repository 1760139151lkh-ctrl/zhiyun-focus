const paths={
  play:'<path d="m8 5 11 7-11 7Z" fill="currentColor" stroke="none"/>',
  pause:'<path d="M7 5h4v14H7zm6 0h4v14h-4z" fill="currentColor" stroke="none"/>',
  rewind:'<path d="M4 10a8 8 0 1 1 2 8M4 4v6h6"/>',
  return:'<path d="M20 10a8 8 0 1 0-2 8M20 4v6h-6"/><path d="m10 9 4 3-4 3"/>',
  mark:'<path d="M7 3.5h10v17L12 17l-5 3.5ZM12 7v6M9 10h6"/>',
  check:'<path d="m5 12 4 4L19 6"/>',
  capture:'<path d="M8 3H4v4m12-4h4v4m0 10v4h-4M8 21H4v-4"/><rect x="8" y="8" width="8" height="8" rx="1"/>',
  chat:'<path d="M6 4h12a3 3 0 0 1 3 3v7a3 3 0 0 1-3 3H9l-5 4v-4a2 2 0 0 1-1-2V7a3 3 0 0 1 3-3ZM8 9h8m-8 4h5"/>',
  library:'<rect x="6" y="3" width="15" height="15" rx="3"/><path d="M3 8v11a2 2 0 0 0 2 2h11M6 14l4-4 4 4 3-3 4 4"/><circle cx="16" cy="7" r="1"/>',
  copy:'<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4H4v12h4"/>',
  close:'<path d="m6 6 12 12M18 6 6 18"/>',
  undo:'<path d="m9 4-5 5 5 5M4 9h10a6 6 0 0 1 0 12"/>',
  download:'<path d="M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4"/>',
  more:'<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  select:'<rect x="3" y="3" width="18" height="18" rx="4"/><path d="m7 12 3 3 7-7"/>',
  newChat:'<path d="M11 4H6a3 3 0 0 0-3 3v8a2 2 0 0 0 2 2v4l5-4h8a3 3 0 0 0 3-3v-3M17 2v8m-4-4h8"/>',
  history:'<path d="M4 10a8 8 0 1 1 2 8M4 4v6h6M12 7v6l3 2"/>',
  sound:'<path d="m11 4-5 4H3v8h3l5 4ZM15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/>',
  back:'<path d="M20 12H4m6-6-6 6 6 6"/>',
  forward:'<path d="M4 12h16m-6-6 6 6-6 6"/>',
  trash:'<path d="M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7"/>',
  boards:'<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M11 5v14M3 12h8"/>',
  guard:'<path d="m12 3 8 3v6c0 4-3 7-8 9-5-2-8-5-8-9V6Z"/><rect x="9" y="10" width="6" height="6" rx="1"/><path d="M10 10V8a2 2 0 0 1 4 0v2"/>',
  settings:'<path d="m12 3 8 4.5v9L12 21l-8-4.5v-9Z"/><circle cx="12" cy="12" r="3.3"/>',
  fullscreen:'<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>',
  fullscreenExit:'<path d="M3 8h5V3m8 0v5h5M3 16h5v5m8 0v-5h5"/>',
  edit:'<path d="m4 20 4-1 12-12-3-3L5 16ZM14 7l3 3"/>'
};

export function toolbarIcon(name){
  return `<svg data-icon="${name}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths[name]||''}</svg>`;
}

export function boardMap(roi={x:0,y:0,w:1,h:1}){
  const x=4+roi.x*72,y=4+roi.y*40,w=Math.max(1,roi.w*72),h=Math.max(1,roi.h*40);
  return `<svg viewBox="0 0 80 48" aria-hidden="true" focusable="false"><rect class="board-frame" x="3" y="3" width="74" height="42" rx="3"/><rect class="board-area" x="${x}" y="${y}" width="${w}" height="${h}" rx="1"/></svg>`;
}
