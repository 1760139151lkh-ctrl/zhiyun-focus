export function controlsLocked(s) {
  return !!(s.editing || s.menu || s.hover || s.keyboardFocus || s.scrubbing || s.dragging || s.error);
}
export function pointerIntent(y, height, kind='mouse',buttons=0) {
  return kind === 'touch' || (kind==='pen'&&buttons!==0) || y >= height - 80;
}
export function editableTarget(path) {
  return path.some(n => n && (/^(INPUT|SELECT|TEXTAREA)$/.test(n.tagName || '') || n.isContentEditable || ['textbox','searchbox'].includes(n.getAttribute?.('role'))));
}

// Text/IME and focused controls keep their native keys. Viewing shortcuts only
// act when the user is addressing the viewing surface.
export function viewerShortcutAllowed(event,{protectedInput=false,path=event.composedPath?.()||[]}={}) {
  if(protectedInput||event.defaultPrevented||event.isComposing||event.keyCode===229||['Process','Dead','Unidentified'].includes(event.key))return false;
  if(event.ctrlKey||event.metaKey||event.altKey||editableTarget(path))return false;
  const actionOwnsKey=event.key!=='Escape';
  return !path.some(node=>node&&((actionOwnsKey&&(/^(BUTTON|A|SUMMARY)$/.test(node.tagName||'')||['button','menuitem','menuitemcheckbox','menuitemradio','tab','separator','checkbox','radio','switch'].includes(node.getAttribute?.('role'))))||['slider','combobox','spinbutton','listbox','option','tree','treeitem','grid','gridcell'].includes(node.getAttribute?.('role'))||node.getAttribute?.('data-viewer-shortcuts')==='off'));
}
