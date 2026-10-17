export const DRAFT_PANEL_CSS=`
#zjf-capture-draft,.zjf-attachment-popup,.zjf-native-tools{box-sizing:border-box;font:13px/1.5 system-ui;color:var(--color-token-text-primary,var(--text-primary,CanvasText))}
#zjf-capture-draft *,.zjf-attachment-popup *,.zjf-native-tools *{box-sizing:border-box}
#zjf-capture-draft{flex-shrink:0;min-width:0;width:100%;margin:2px 0;padding:0 2px;border:0;background:transparent}
.zjf-icon{display:inline-grid;place-items:center;flex:none;width:30px;height:30px;min-width:30px;padding:5px;border:0;border-radius:7px;font:inherit;line-height:1;color:inherit;background:transparent;cursor:pointer}
.zjf-icon svg,.zjf-missing-image svg{display:block;width:20px;height:20px;pointer-events:none}
.zjf-icon:hover:not(:disabled){background:color-mix(in srgb,currentColor 10%,transparent)}
.zjf-icon:disabled{opacity:.4;cursor:default}
:is(#zjf-capture-draft,.zjf-attachment-popup,.zjf-native-tools) :is(button,input):focus-visible{outline:2px solid currentColor;outline-offset:2px}
:is(#zjf-capture-draft,.zjf-attachment-popup,.zjf-native-tools) [hidden]{display:none!important}
.zjf-draft-bar{display:flex;align-items:center;gap:4px;min-height:30px;color:var(--text-secondary,var(--color-token-text-secondary,GrayText))}
.zjf-draft-bar .zjf-more{margin-left:auto}
.zjf-draft-warning{padding:2px 3px 6px;overflow-wrap:anywhere;font-size:12px}
.zjf-managed-attachment[data-zjf-referenced]{outline:2px solid var(--color-token-text-primary,var(--text-primary,CanvasText));outline-offset:2px}
.zjf-native-tools{position:absolute;z-index:3;right:2px;bottom:2px;display:flex;gap:2px;max-width:100%;padding:1px;border-radius:8px;background:var(--color-token-main-surface-primary,var(--bg-primary,Canvas));box-shadow:0 1px 5px #0002;opacity:0;pointer-events:none;transform:translateY(2px);transition:opacity .12s ease,transform .12s ease}
.zjf-native-tools .zjf-icon{width:26px;height:26px;min-width:26px;padding:4px;border-radius:6px}
.zjf-native-tools .zjf-icon svg{width:18px;height:18px}
.zjf-managed-attachment:hover>.zjf-native-tools,.zjf-managed-attachment:focus-within>.zjf-native-tools,.zjf-managed-attachment[data-zjf-referenced]>.zjf-native-tools{opacity:1;pointer-events:auto;transform:none}
.zjf-managed-attachment[data-zjf-drop="before"]{box-shadow:-4px 0 0 currentColor}
.zjf-managed-attachment[data-zjf-drop="after"]{box-shadow:4px 0 0 currentColor}
.zjf-pending-images{display:flex;gap:8px;max-width:100%;padding:3px 2px;overflow-x:auto;scrollbar-width:thin}
.zjf-pending-image{display:flex;flex-direction:column;align-items:flex-end;gap:2px;position:relative;flex:0 0 76px}
.zjf-pending-preview{display:grid;place-items:center;width:100%;height:58px;padding:0;border:1px solid color-mix(in srgb,currentColor 20%,transparent);border-radius:7px;color:inherit;background:transparent;cursor:pointer}
.zjf-pending-preview img{width:100%;height:100%;object-fit:contain;border-radius:6px}
.zjf-pending-image>.zjf-icon{width:26px;height:26px;min-width:26px}
.zjf-attachment-popup{position:fixed;z-index:2147483647;inset:auto;margin:0;padding:8px 12px 12px;border:1px solid color-mix(in srgb,currentColor 18%,transparent);border-radius:12px;overflow:auto;overscroll-behavior:contain;scrollbar-width:thin;background:var(--color-token-main-surface-primary,var(--bg-primary,Canvas));box-shadow:0 8px 32px #0003}
.zjf-attachment-popup[popover]:not(:popover-open){display:none}
.zjf-attachment-popup::backdrop{background:transparent}
.zjf-popup-bar{display:flex;align-items:center;gap:4px;margin-bottom:8px}
.zjf-popup-close{margin-left:auto}
.zjf-material-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
.zjf-material-grid:has(>.zjf-material:only-child){grid-template-columns:minmax(0,1fr)}
.zjf-material{position:relative;min-width:0}
.zjf-material-image{display:grid;place-items:center;width:100%;height:100px;padding:0;border:1px solid color-mix(in srgb,currentColor 14%,transparent);border-radius:7px;background:transparent;color:inherit;cursor:pointer}
.zjf-material:only-child .zjf-material-image{height:150px}
.zjf-material-image img{width:100%;height:100%;min-height:0;object-fit:contain;border-radius:6px}
.zjf-material-actions{position:absolute;right:3px;top:3px;display:flex;gap:2px;padding:1px;border-radius:7px;background:var(--color-token-main-surface-primary,var(--bg-primary,Canvas));opacity:0;transition:opacity .12s ease}
.zjf-material:hover .zjf-material-actions,.zjf-material:focus-within .zjf-material-actions{opacity:1}
.zjf-region{position:absolute;left:4px;top:4px;max-width:calc(100% - 75px);padding:1px 4px;border-radius:3px;font-size:11px;line-height:1.5;overflow-wrap:anywhere;background:var(--color-token-main-surface-primary,var(--bg-primary,Canvas));pointer-events:none}
.zjf-missing-image{display:grid;place-items:center;color:var(--text-secondary,var(--color-token-text-secondary,GrayText))}
.zjf-question-excerpt{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;width:100%;margin-top:7px;padding:0;border:0;font:inherit;line-height:1.5;text-align:start;white-space:pre-wrap;overflow-wrap:anywhere;color:inherit;background:transparent;cursor:text}
.zjf-question-actions{display:flex;gap:2px;margin-top:3px;color:var(--text-secondary,var(--color-token-text-secondary,GrayText))}
.zjf-question-actions .zjf-icon:last-child{margin-left:auto}
.zjf-course-fields{display:grid;gap:8px;margin-top:12px;padding-top:10px;border-top:1px solid color-mix(in srgb,currentColor 14%,transparent)}
.zjf-course-fields:empty{display:none}
.zjf-course-fields label{display:grid;grid-template-columns:60px minmax(0,1fr);gap:8px;align-items:center;font-size:12px;color:var(--text-secondary,var(--color-token-text-secondary,GrayText))}
.zjf-course-fields input{min-width:0;width:100%;padding:5px 7px;border:1px solid color-mix(in srgb,currentColor 24%,transparent);border-radius:5px;font:inherit;color:var(--color-token-text-primary,var(--text-primary,CanvasText));background:transparent}
.zjf-recovery-choices{display:grid;gap:5px;max-height:22vh;overflow:auto}
.zjf-recovery-choices>.zjf-icon{display:flex;width:100%;height:auto;gap:8px;min-height:34px;text-align:start;line-height:1.5}
.zjf-recovery-choices span{min-width:0;overflow-wrap:anywhere}
.zjf-review-record{width:100%;padding:8px 0;border:0;border-bottom:1px solid color-mix(in srgb,currentColor 14%,transparent);font:inherit;line-height:1.5;text-align:start;overflow-wrap:anywhere;color:inherit;background:transparent;cursor:pointer}
.zjf-review-record[aria-pressed="true"]{font-weight:600}
.zjf-review-message{padding:8px 0;border-top:1px solid color-mix(in srgb,currentColor 14%,transparent)}
.zjf-review-message p,.zjf-attachment-popup pre{margin:4px 0 8px;font:inherit;white-space:pre-wrap;overflow-wrap:anywhere}
.zjf-review-actions{display:flex;gap:6px;justify-content:flex-end}
[data-zjf-question-editor]{max-height:none!important;height:auto!important;min-height:1.5em!important;overflow:visible!important;white-space:pre-wrap!important;overflow-wrap:anywhere!important;line-height:1.6!important}
.zjf-composer-scroll{display:block!important;min-height:1.6em!important;height:auto!important;max-height:min(28vh,210px)!important;overflow-x:hidden!important;overflow-y:auto!important;overscroll-behavior:contain;scrollbar-width:thin}
.zjf-composer-scroll [data-zjf-question-editor] p{white-space:pre-wrap;overflow-wrap:anywhere;margin:0 0 .5em}
.zjf-attachment-row{display:flex!important;flex-wrap:nowrap!important;gap:9px!important;align-items:flex-start!important;height:auto!important;max-height:none!important;overflow-x:auto!important;overflow-y:hidden!important;scrollbar-width:thin;padding:5px 4px 8px!important}
.zjf-managed-attachment{position:relative!important;flex:0 0 112px!important;width:112px!important;min-width:112px!important;height:108px!important;max-height:108px!important;padding:0 0 31px!important;border-radius:10px!important;overflow:visible!important}
.zjf-managed-attachment .composer-attachment-surface{width:100%!important;height:77px!important;max-height:77px!important;min-height:0!important;border-radius:9px!important;overflow:hidden!important}
.zjf-managed-attachment img{width:100%!important;height:77px!important;object-fit:contain!important;border-radius:8px!important}
.zjf-managed-attachment:after{content:attr(data-zjf-number);position:absolute;top:4px;left:4px;z-index:2;min-width:17px;height:17px;padding:0 3px;border-radius:5px;background:#202020e6;color:#eee;font:10px/17px system-ui;text-align:center;pointer-events:none}
.zjf-native-tools{left:2px;right:2px;bottom:1px;justify-content:space-between;padding:0;background:transparent;box-shadow:none;opacity:1;pointer-events:auto;transform:none}
.zjf-native-tools .zjf-icon{width:26px;height:27px;min-width:26px;padding:5px}.zjf-native-tools .zjf-icon svg{width:16px;height:16px}
.zjf-draft-bar{min-height:28px}.zjf-draft-bar .zjf-icon{height:28px;width:28px;min-width:28px;padding:5px}
.zjf-material-actions{position:static;opacity:1;justify-content:flex-end;background:transparent;padding:4px 0;gap:3px}
.zjf-material-image,.zjf-material:only-child .zjf-material-image{height:136px}
.zjf-image-preview .zjf-preview-image{display:block;width:100%;max-height:280px;object-fit:contain;border-radius:8px;background:#171717}
.zjf-preview-actions{display:flex;justify-content:center;gap:8px;margin-top:10px}
.zjf-attachment-popup{animation:zjf-popup-in .2s cubic-bezier(.22,1,.36,1)}
@keyframes zjf-popup-in{from{opacity:0;transform:translateY(6px) scale(.98)}to{opacity:1;transform:none}}
@media(max-width:280px){.zjf-material-grid{grid-template-columns:minmax(0,1fr)}.zjf-course-fields label{grid-template-columns:48px minmax(0,1fr)}}
@media(hover:none),(pointer:coarse){.zjf-native-tools,.zjf-material-actions{opacity:1;pointer-events:auto;transform:none}.zjf-icon{width:34px;height:34px;min-width:34px}.zjf-managed-attachment{flex-basis:140px!important;width:140px!important;min-width:140px!important;height:116px!important;max-height:116px!important;padding-bottom:39px!important}.zjf-native-tools .zjf-icon{width:32px;height:36px;min-width:32px}.zjf-pending-image>.zjf-icon{width:34px;height:34px;min-width:34px}}
@media(prefers-reduced-motion:reduce){.zjf-native-tools,.zjf-material-actions{transition:none;transform:none}.zjf-attachment-popup{animation:none}}
@media(max-width:360px){button[data-composer-navigation-target="reasoning"]{min-width:36px;max-width:36px;padding-inline:0;gap:0;justify-content:center}button[data-composer-navigation-target="reasoning"]>span,button[data-composer-navigation-target="reasoning"]>svg{display:none}button[data-composer-navigation-target="reasoning"]::after{content:"模型"}}
`;
