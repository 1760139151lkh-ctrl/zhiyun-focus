const icons={
  quote:'<path d="M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-8l-6 4v-4H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z"/><path d="M8 9h3v4H8zm6 0h3v4h-3z"/>',
  more:'<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  copy:'<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4H4v12h4"/>',
  download:'<path d="M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4"/>',
  close:'<path d="m6 6 12 12M18 6 6 18"/>',
  undo:'<path d="M4 10h10a6 6 0 0 1 0 12M4 10l6-6M4 10l6 6"/>',
  left:'<path d="M20 12H4m6-6-6 6 6 6"/>',
  right:'<path d="M4 12h16m-6-6 6 6-6 6"/>',
  up:'<path d="M12 20V4m-6 6 6-6 6 6"/>',
  down:'<path d="M12 4v16m-6-6 6 6 6-6"/>',
  trash:'<path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7"/>',
  edit:'<path d="m4 20 4-1L20 7l-3-3L5 16ZM14 7l3 3"/>',
  history:'<path d="M3 10a9 9 0 1 1 1 8M3 4v6h6M12 7v6l4 2"/>',
  check:'<path d="m5 12 4 4L19 6"/>',
  locate:'<path d="M9 3H3v6m12-6h6v6M3 15v6h6m12-6v6h-6"/><circle cx="12" cy="12" r="3"/>',
  image:'<rect x="3" y="3" width="18" height="18" rx="3"/><path d="m3 16 5-5 5 5 3-3 5 5"/><circle cx="15" cy="8" r="1"/>',
  imageOff:'<path d="m3 3 18 18M8 3h10a3 3 0 0 1 3 3v10M3 8v10a3 3 0 0 0 3 3h10M3 16l5-5m5 5 3-3"/>',
  removeQuestion:'<path d="M7 3h10v18H7M4 6h16M10 9h4m-4 4h4m-4 4h4M3 3l18 18"/>'
};
export function draftIcon(name){return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">'+(icons[name]||icons.more)+'</svg>';}
