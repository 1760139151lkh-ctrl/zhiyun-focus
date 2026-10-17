export const PLAYER_CSS=`
:host{all:initial;font:14px/1.5 "Microsoft YaHei","Segoe UI",sans-serif;color:#ededed;color-scheme:dark}
*{box-sizing:border-box}[hidden]{display:none!important}
button,input,select,textarea,a,output{font:inherit;color:inherit}a:visited{color:inherit}
button,select,input[type=text]{background:#303030;border:1px solid #4a4a4a;border-radius:6px;padding:7px 10px}
button{cursor:pointer}button:hover,a.button:hover{background:#3c3c3c}
button:disabled{opacity:.45;cursor:default}
button[aria-current=true],button[aria-pressed=true]{background:#3b3b3b;border-color:#737373}
:is(button,input,select,a,summary):focus-visible{outline:2px solid #e0e0e0;outline-offset:3px}
input{accent-color:#dadada}input[type=checkbox]{width:16px;height:16px;flex:none}
a{color:#e2e2e2;text-decoration:underline;text-underline-offset:3px}
.button,.primary{display:inline-block;background:#3c3c3c;color:#f0f0f0;border:1px solid #555;border-radius:6px;padding:7px 12px;text-decoration:none}
a.button,a.button:visited{color:#f0f0f0}a.button:hover,.primary:hover{background:#494949;color:#fff}
.help,.status{font-size:13px;color:#bdbdbd;line-height:1.6;margin:8px 0}.status:empty{display:none}
#surface{position:fixed;inset:0;pointer-events:auto;touch-action:none;outline:none}
#surface.idle{cursor:none!important}#surface:focus-visible{outline:1px solid #ffffff40;outline-offset:-1px}
#selection{display:none;position:fixed;border:1px solid #fff;background:#ffffff10;pointer-events:none}
#regions{position:fixed;inset:0;pointer-events:none}
.region{position:fixed;pointer-events:auto;border:1px solid #ffffff70;background:transparent;border-radius:2px;text-align:left;padding:6px;display:flex;align-items:flex-start}
.region span{background:#202020e8;padding:3px 7px;border-radius:4px}.region:hover{background:#ffffff10}
#dock{--bottom:14px;--visibility-delay:0s;position:fixed;left:50%;bottom:var(--bottom);transform:translateX(-50%);width:max-content;max-width:min(720px,calc(100% - 24px));pointer-events:none;opacity:1;visibility:visible;transition:opacity .18s ease,transform .18s cubic-bezier(.2,.7,.2,1),visibility 0s var(--visibility-delay)}
#dock.quiet{--visibility-delay:.18s;opacity:0;visibility:hidden;pointer-events:none;transform:translate(-50%,4px)}#dock.quiet *{pointer-events:none!important}
#shot-toast{display:flex;align-items:center;justify-content:flex-end;gap:12px;margin:0 0 7px auto;padding:6px 10px;background:#252525ed;border-radius:5px;max-width:100%;width:max-content;pointer-events:auto;font-size:13px;color:#ccc}
#shot-toast-message{min-width:0;overflow-wrap:anywhere}#shot-preview{flex:none;border:0;background:transparent;padding:3px;color:#eee;font-size:13px}
#bar{width:max-content;max-width:100%;display:grid;grid-template-columns:auto auto auto;align-items:center;gap:4px 12px;padding:8px 10px 6px;background:#202020f5;border:1px solid #ffffff16;border-radius:14px;pointer-events:auto;box-shadow:0 6px 24px #0003}
#seek{--progress:0%;grid-column:1/-1;width:100%;height:14px;margin:0 0 3px;cursor:pointer;appearance:none;background:transparent}
#seek::-webkit-slider-runnable-track{height:3px;border-radius:2px;background:linear-gradient(to right,#ededed var(--progress),#ffffff38 var(--progress))}
#seek::-webkit-slider-thumb{appearance:none;width:11px;height:11px;border-radius:50%;background:#ededed;margin-top:-4px}
#seek::-moz-range-track{height:3px;background:#ffffff38;border:0;border-radius:2px}#seek::-moz-range-progress{height:3px;background:#ededed}#seek::-moz-range-thumb{width:11px;height:11px;border:0;background:#ededed}
.actions{display:flex;align-items:center;gap:4px;min-width:0}
#playback-actions{grid-column:1}#study-actions{grid-column:2;justify-self:end;gap:4px;border-left:1px solid #ffffff20;padding-left:10px}#player-options{grid-column:3;border-left:1px solid #ffffff20;padding-left:10px}
#bar button{height:36px;min-width:36px;padding:6px 8px;background:transparent;border:0;white-space:nowrap;font-size:13px;border-radius:7px}
#bar button:hover,#bar button[aria-expanded=true]{background:#ffffff16}
#bar #play{font-size:0;width:36px;padding:8px}
#play [data-icon=pause],#mark [data-icon=check],#fullscreen [data-icon=fullscreenExit]{display:none}
#play.is-playing [data-icon=play],#mark[data-saved=true] [data-icon=mark],#fullscreen[aria-pressed=true] [data-icon=fullscreen]{display:none}
#play.is-playing [data-icon=pause],#mark[data-saved=true] [data-icon=check],#fullscreen[aria-pressed=true] [data-icon=fullscreenExit]{display:block}
#return-time[hidden]{display:inline-flex!important;visibility:hidden;pointer-events:none}
#time{width:96px;flex:none;text-align:center;font-size:12px;color:#bdbdbd;white-space:nowrap;font-variant-numeric:tabular-nums}
#bar #rate{border:0;padding:6px;background:transparent;font-size:13px;width:48px;min-width:48px;flex:none;height:36px;font-variant-numeric:tabular-nums}
#rate-menu{position:fixed;z-index:9;pointer-events:auto;padding:6px;background:#292929;color:#ededed;border:1px solid #ffffff24;border-radius:10px;box-shadow:0 8px 28px #0005;overflow:auto}
#rate-menu button{display:block;position:relative;width:100%;min-height:34px;background:transparent;border:0;text-align:center;padding:7px 24px;font-size:13px}
#rate-menu button:hover{background:#ffffff12}#rate-menu button[aria-pressed=true]{background:#ffffff1a}#rate-menu button[aria-pressed=true]::after{content:'✓';position:absolute;right:9px;top:50%;transform:translateY(-50%)}
#bar .icon-button{position:relative;display:inline-flex;align-items:center;justify-content:center;font-size:0;flex:none;width:36px;padding:8px}
.icon-button svg{display:block;flex:none;width:20px;height:20px}
.icon-number{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);font:8px/1 "Segoe UI",sans-serif;font-weight:600;font-variant-numeric:tabular-nums}
#mark[data-saved=true]{background:#ffffff14}
#viewer-menu{position:fixed;z-index:8;pointer-events:auto;min-height:0;overflow:auto;overscroll-behavior:contain;background:#292929;color:#ededed;border:1px solid #ffffff24;border-radius:12px;box-shadow:0 8px 28px #0005}
#viewer-menu .panel{padding:8px}.panel h2{font-size:14px;font-weight:500;margin:0}.panel-head{display:flex;align-items:center;justify-content:space-between;gap:12px}.panel-head button{border:0;background:transparent;padding:0;color:#bdbdbd}
.row{display:flex;flex-wrap:wrap;align-items:center;gap:9px;margin:10px 0}.row:last-child{margin-bottom:0}
.setting{justify-content:space-between;flex-wrap:wrap;margin:0;padding:7px 0;gap:8px 12px;font-size:13px}.setting button{font-size:13px;padding:5px 10px}
.choice-row{display:flex;gap:2px;max-width:100%;padding:3px;border-radius:7px;background:#ffffff08}.choice-row button{flex:1;background:transparent;border:0;padding:5px 9px;white-space:nowrap;font-size:12px}.choice-row button[aria-pressed=true]{background:#ffffff18;color:#fff}
#audio{display:flex;align-items:center;justify-content:space-between;width:100%;gap:9px;background:transparent;border:0}#audio::after{content:'';width:25px;height:14px;flex:none;border-radius:10px;background:radial-gradient(circle at 7px 50%,#c2c2c2 0 4px,transparent 4.5px),#555}#audio[aria-checked=true]::after{background:radial-gradient(circle at 18px 50%,#252525 0 4px,transparent 4.5px),#ddd}
.setting-group+.setting-group{margin-top:10px;padding-top:10px;border-top:1px solid #ffffff18}
.utility-actions{border-bottom:1px solid #ffffff18;padding-bottom:8px;margin-bottom:6px}
.utility-actions:not(:has(button:not([hidden]))){display:none}
#audio-status{font-size:12px}#audio-launch,#audio-retry{font-size:13px}
.watch-actions{display:flex;flex-direction:column;gap:3px}.watch-actions button{text-align:left;background:transparent;border:0;padding:9px 10px;min-height:36px}.watch-actions button[aria-current=true]{background:#3b3b3b}
#board-grid{display:grid;gap:5px}#quick-boards{display:contents}#quick-boards:empty{display:none}
#board-grid .board-card{display:flex;flex-direction:column;align-items:stretch;gap:4px;min-width:0;padding:6px;background:transparent;border:1px solid transparent;border-radius:8px;font-size:12px;color:#aaa}
#board-grid .board-card:hover{background:#ffffff09}#board-grid .board-card[aria-current=true]{background:#ffffff0d;border-color:#ffffff38;color:#eee}
.board-mini{display:block;width:100%;aspect-ratio:5/3}.board-mini svg{display:block;width:100%;height:100%}.board-frame{fill:#202020;stroke:#626262;stroke-width:1}.board-area{fill:#ffffff12;stroke:#aaa;stroke-width:1}
.board-card[aria-current=true] .board-area{fill:#ffffff28;stroke:#ddd}.board-card>span:last-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:center}
#boards-toggle{display:flex;align-items:center;justify-content:flex-end;gap:6px;width:100%;margin-top:7px;padding:8px 4px 1px;background:transparent;border:0;border-top:1px solid #ffffff18;border-radius:0;color:#aaa;font-size:12px}#boards-toggle svg{width:15px;height:15px}
.boards{display:flex;gap:6px;flex-wrap:wrap}.boards button{font-size:13px}
#board-chooser{margin:8px 0}#board-chooser summary,#board-reset summary{cursor:pointer;color:#bdbdbd;font-size:13px;padding:5px 0}#board-chooser .boards{padding-top:6px;flex-direction:column}#board-chooser button{text-align:left;background:transparent;border:0}
.board-management,.reset-actions{display:flex;align-items:center;flex-wrap:wrap;gap:4px 8px}.board-management{padding-top:6px;border-top:1px solid #ffffff18}.board-management button,.reset-actions button,.text-action{background:transparent;border:0;text-align:left;padding:6px;color:#bdbdbd;font-size:13px}
#board-reset{margin-top:4px}#board-reset summary{display:list-item;width:max-content;font-size:12px;color:#aaa}#remove{margin-left:auto;color:#d9b0ab}.reset-actions{padding-top:2px}#save-status:empty{display:none}
#boards-panel input[type=text]{min-width:0;flex:1;width:130px}#boards-panel .row button{font-size:13px}
#shot-panel{position:relative;order:4;flex:1;min-height:0;overflow:auto;background:#222;border:0;border-radius:0;pointer-events:auto;padding:14px;display:flex;flex-direction:column;gap:12px}
#shot-panel .panel-head{flex:none}#shot-panel .panel-head h2{font-size:14px;font-weight:500}#shot-time{font:inherit;font-size:12px;color:#aaa;margin-left:8px;font-variant-numeric:tabular-nums}
#shot-image{display:block;flex:1;min-height:0;max-height:none;width:100%;object-fit:contain;cursor:crosshair;background:#171717}
#shot-panel>.row{flex:none;margin:0;min-height:38px;justify-content:flex-end}#shot-panel>.status{margin:0;flex:none}
#shot-panel>#shot-status{display:block;min-height:21px}
#shot-panel #shot-copy,#shot-panel #shot-save,#shot-panel #shot-save:visited{background:transparent;border:0;color:#ddd;padding:7px 10px;text-decoration:none}
#shot-panel #shot-copy:hover,#shot-panel #shot-save:hover{background:#ffffff12}
#done-shot{min-height:32px;padding:5px 0 5px 8px;font-size:13px;background:transparent;border:0;white-space:nowrap}
#shot-source{margin:0;color:#bdbdbd;font-size:13px;line-height:1.5;overflow-wrap:anywhere;white-space:pre-line;flex:none}
#image-selection{position:fixed;border:1px solid white;box-shadow:0 0 0 9999px #0006;pointer-events:none;z-index:10}
#capture-paint{position:fixed;display:grid;grid-template-columns:repeat(32,2px);grid-auto-rows:2px;width:64px;height:8px;pointer-events:none;z-index:11;contain:strict}
#capture-paint i{display:block;width:2px;height:2px}
#shot-crop{background:transparent}#shot-preview{color:#ededed}
#chat-space{position:fixed;right:0;top:0;bottom:0;width:var(--zjf-aside,0px);background:#222;border-left:1px solid #414141;pointer-events:auto;display:flex;flex-direction:column;padding-left:20px;z-index:7}
#workspace-header{position:relative;order:0;flex:0 0 44px;display:flex;align-items:center;justify-content:space-between;padding:0 12px;gap:10px;border-bottom:1px solid #414141}
#workspace-header nav{display:flex;gap:20px;height:100%;align-items:stretch}
#workspace-header nav button{background:transparent;border:0;border-radius:0;padding:0 2px;color:#aaa;min-width:32px;font-size:14px}
#workspace-header nav button[aria-current=true]{color:#eee;border-bottom:2px solid #ddd}
#workspace-tools{order:1;flex:none;min-height:0;overflow:auto;overscroll-behavior:contain;padding:4px 8px;border-bottom:1px solid #414141;scrollbar-width:thin}
#chat-close{width:28px;height:28px;padding:0;border:0;background:transparent;font-size:20px}
#chat-focus{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);padding:0;border:0}
.workspace-actions{display:flex;align-items:center;gap:8px}
#chat-resize{position:absolute;left:0;top:0;bottom:0;width:20px;pointer-events:auto;cursor:col-resize;touch-action:none;outline:none}
#chat-resize::before{content:'';position:absolute;left:9px;top:12px;bottom:12px;width:1px;background:#ffffff20}
#chat-resize:hover::before,#chat-resize:focus-visible::before,#chat-resize.dragging::before{background:#aaa}
#chat-ratio{position:absolute;right:23px;top:12px;color:#eee;background:#303030;padding:3px 6px;border-radius:4px;font-size:12px;opacity:0;pointer-events:none}
#chat-resize.dragging #chat-ratio{opacity:1}
#workspace-status{order:2;flex:none;padding:12px 16px;border-bottom:1px solid #414141;font-size:13px;line-height:1.6;overflow-wrap:anywhere}
#workspace-status p{margin:0 0 8px}#workspace-status button,#workspace-status a{font:inherit;margin-right:12px}
#library-panel{order:3;flex:1;min-height:0;overflow:auto;border:0;padding:0}
#hint{position:fixed;left:50%;bottom:94px;transform:translateX(-50%);max-width:calc(100% - 32px);background:#242424ed;border-radius:6px;padding:7px 12px;font-size:13px;color:#ddd;overflow-wrap:anywhere;pointer-events:none;transition:opacity .18s}
#hint.quiet{opacity:0;visibility:hidden}
#capture-layer{position:fixed;pointer-events:auto;touch-action:none;cursor:crosshair;z-index:4;background:#ffffff02}
#capture-rect{position:fixed;border:1px solid white;box-shadow:0 0 0 9999px #0005;pointer-events:none}
#capture-tools{position:fixed;display:flex;flex-wrap:wrap;align-items:center;gap:6px 14px;pointer-events:none;z-index:5;background:#222222ed;border-radius:6px;padding:6px 10px;font-size:13px;color:#ddd;box-sizing:border-box}
#capture-tools button{background:transparent;border:0;padding:3px 5px;pointer-events:auto}
#protection-strip{position:fixed;top:0;right:0;max-width:calc(100% - 12px);padding:4px 12px;display:flex;flex-direction:column;align-items:flex-end;gap:6px;background:transparent;pointer-events:none;opacity:0;visibility:hidden;transition:opacity .12s ease-out,visibility .12s;z-index:10}
#protection-strip[data-revealed=true],#protection-strip:focus-within,#protection-strip[data-engaged=true]{opacity:1;visibility:visible;pointer-events:auto}
#protection-strip button{pointer-events:auto}
#protection-door{width:168px;max-width:100%;height:36px;display:flex;align-items:center;justify-content:space-between;padding:0 12px;background:linear-gradient(90deg,#555 calc(var(--door-progress,0)*100%),#252525ed 0);border-color:#ffffff35;touch-action:none;user-select:none}
#protection-info{min-width:0;max-width:280px;font-size:12px;line-height:1.4;background:#252525ed;border-radius:5px;padding:5px 8px}#protection-status{overflow-wrap:anywhere}#protection-retry{flex:none;white-space:nowrap}
#dock.compact #bar{gap:4px 8px}#dock.compact #study-actions{gap:2px}#dock.compact #player-options{gap:0;padding-left:6px}#dock.compact #bar button{height:32px;min-width:32px;padding:4px 7px}#dock.compact #bar .icon-button{width:32px;padding:6px}
#dock.narrow #bar{grid-template-columns:1fr auto}#dock.narrow #playback-actions{grid-column:1/-1}#dock.narrow #study-actions{grid-column:1;justify-self:start;padding-left:0;border-left:0}#dock.narrow #player-options{grid-column:2;padding-left:6px}
#dock.tiny #bar{grid-template-columns:minmax(0,1fr);gap:4px}
#dock.tiny #playback-actions,#dock.tiny #study-actions,#dock.tiny #player-options{grid-column:1;justify-self:stretch}
#dock.tiny #playback-actions{flex-wrap:wrap;gap:3px 6px}
#dock.tiny #study-actions,#dock.tiny #player-options{justify-content:space-between}
#dock.tiny #player-options{border-left:0;padding-left:0}
#reconnect{grid-column:1/-1}
:host([data-narrow-video=true]) #dock{position:relative;left:auto!important;bottom:auto!important;width:100%;max-width:none!important;margin:0;transform:none!important;opacity:1;visibility:visible;transition:none}
:host([data-narrow-video=true]) #dock.quiet *{pointer-events:auto!important}
:host([data-narrow-video=true]) #bar{width:100%;box-shadow:none;border:0;padding:4px;background:transparent}
:host([data-narrow-video=true]) :is(#viewer-menu,#rate-menu){position:relative;margin:6px 0 0;box-shadow:none;animation:none!important}
:host([data-narrow-video=true]) #protection-strip{display:none!important}
#dock.tiny #player-options{flex-wrap:wrap;gap:2px}
#viewer-menu:not([hidden]),#rate-menu:not([hidden]){animation:player-menu-in .14s ease-out}
@keyframes player-menu-in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}
#dock.tiny #study-actions{flex-wrap:wrap;justify-content:flex-start}
@media(max-width:500px){#protection-strip{padding:4px 8px}#protection-door{width:150px}#shot-panel>.row{gap:8px}#shot-panel>.row button,#shot-panel>.row a{font-size:13px}}
#bar{gap:4px 6px;border-radius:17px;padding-inline:12px}
#player-options{border-left:0;padding-left:0}#study-actions{padding-left:8px}
#bar svg,#workspace-header svg,#shot-panel svg,#settings-panel svg,#boards-panel svg,#protection-door svg,#capture-cancel svg,#cancel-edit svg{width:22px;height:22px;display:block;flex:none}
#workspace-header{border-bottom:0;padding:0 12px}
#workspace-header nav{gap:5px;align-items:center}
#workspace-header nav button,#chat-close{width:32px;height:32px;display:grid;place-items:center;border-radius:9px}
#workspace-header nav button[aria-current=true]{background:#ffffff10;border:0}
#workspace-header nav button:hover,#chat-close:hover{background:#ffffff14}
#chat-space{background:#202020;border-color:#ffffff16;opacity:1;transform:translateX(0);transition:opacity .22s ease,transform .28s cubic-bezier(.22,1,.36,1),display .28s allow-discrete}
#chat-space[hidden]{opacity:0;transform:translateX(22px)}
@starting-style{#chat-space:not([hidden]){opacity:0;transform:translateX(22px)}}
:host([data-moving=true]) #dock{transition:left .28s cubic-bezier(.22,1,.36,1),bottom .28s cubic-bezier(.22,1,.36,1),opacity .18s,transform .18s,visibility 0s var(--visibility-delay)}
#chat-resize::before{top:42%;bottom:42%;width:2px;border-radius:2px;background:#ffffff25}
#chat-resize:hover::before,#chat-resize.dragging::before{background:#ddd}
#workspace-status,#menu-status,#shot-toast,#shot-status,#audio-status,#save-status,#protection-info,#protection-retry,#audio-retry,#audio-launch,#shot-retry,#shot-launch,#shot-keep{display:none!important}
#shot-panel{background:#202020;padding:14px 16px 20px;gap:14px;overflow:hidden}
#shot-panel .panel-head{flex-direction:row-reverse;justify-content:flex-end;gap:10px}
#shot-panel .panel-head h2{font-size:0}#shot-panel #shot-time{font-size:12px;color:#aaa;margin:0}
#shot-panel .row{flex-wrap:wrap;justify-content:center}
#shot-panel .row :is(button,a),#done-shot{width:36px;height:36px;padding:7px;border:0;border-radius:9px;background:transparent;display:grid;place-items:center}
#shot-image{border-radius:10px;background:#191919}
#board-edit-label{display:none}#boards-toggle{justify-content:center}
#protection-door{width:142px;height:40px;justify-content:space-between;border-radius:20px;padding:8px 12px;border-color:#ffffff30}
#capture-cancel,#cancel-edit{width:34px;height:34px;padding:6px;border-radius:50%}
#settings-panel .setting-group{padding:10px 0}#settings-panel #audio{width:38px;height:38px;border:0;display:grid;place-items:center;padding:8px}
#settings-panel #audio:after{display:none}
#moment-shelf{display:flex;align-items:center;gap:12px;width:max-content;max-width:100%;margin:0 0 10px auto;padding:8px;background:#202020f5;border:1px solid #ffffff18;border-radius:14px;pointer-events:auto;box-shadow:0 6px 22px #0002;animation:moment-arrive .28s cubic-bezier(.22,1,.36,1)}
.moment-shelf-images{display:flex;gap:8px;min-width:0;max-width:460px;overflow-x:auto;scrollbar-width:thin}
.moment-shelf-card{position:relative;flex:none;width:106px}
.moment-shelf-preview{position:relative;width:106px;height:68px;padding:0;border:0;border-radius:8px;overflow:hidden;background:#111}
.moment-shelf-preview img{width:100%;height:100%;object-fit:contain;display:block}
.moment-shelf-preview span{position:absolute;bottom:3px;left:5px;font-size:10px;font-variant-numeric:tabular-nums;color:#eee;background:#151515d9;border-radius:3px;padding:0 4px}
.moment-action{border:0;background:transparent;border-radius:8px;display:grid;place-items:center;width:32px;height:32px;padding:6px}.moment-action svg{width:20px;height:20px;display:block}
.moment-shelf-actions{display:flex;align-items:center;gap:3px;flex:none}.moment-dismiss{position:absolute;right:1px;top:1px;width:24px;height:24px;padding:4px;background:#202020dd;border-radius:50%}.moment-dismiss svg{width:15px;height:15px}
button[aria-busy=true] svg{animation:moment-wait 1.4s ease-in-out infinite}
@keyframes moment-arrive{from{opacity:0;transform:translateY(8px) scale(.97)}to{opacity:1;transform:none}}
@keyframes moment-wait{50%{opacity:.35}}
@media(max-width:420px){.moment-shelf-images{max-width:176px}.moment-shelf-actions{flex-direction:column}#moment-shelf{gap:4px}}
@media(prefers-reduced-motion:reduce){#dock,#hint,#protection-strip,#chat-space{transition:none!important}#dock.quiet{transform:translateX(-50%)}#viewer-menu,#rate-menu,#moment-shelf,button[aria-busy=true] svg{animation:none!important}}
`;
