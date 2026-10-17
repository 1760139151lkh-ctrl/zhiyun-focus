# 智云聚焦 · Zhiyun Focus

在浙江大学智云课堂回放中，放大板书、保留课堂材料，并在旁边继续向 ChatGPT 提问。使用原视频和原播放时钟；截图先保存，消息由使用者自己发送。

**A local-first study companion for ZJU lecture replays.** A browser bookmarklet focuses the existing video; a Windows companion keeps original captures and question drafts; an optional local MossFormer2 service enhances speech. This repository contains source code and reproducible dependency setup, not lecture recordings or account data.

当前源码版本 **1.9.6**。完整体验面向 **Windows x64 + Chrome + 智云回放**。它不是浏览器扩展、通用视频下载器或独立课程播放器，也不需要 OpenAI API Key。ChatGPT 侧栏使用你自己登录的网页账号。

## 从哪里开始

- 初次使用：按下方「从源码安装」操作，再看「一次看课流程」。
- 维护或让 Agent 修改：先读 [AGENTS.md](AGENTS.md)，再按 [项目地图](docs/PROJECT_MAP.md) 找功能入口和对应文件。
- 修改保存、恢复或消息交付：[数据与协议约定](viewer/STORAGE.md) 是权威说明。
- 排查本机组件：[组件说明](viewer/companion/README.md)；安装声音模型：[声音说明](viewer/audio-helper/README.md)。

## 可以做什么

| 功能 | 使用方式与边界 |
| --- | --- |
| 板书聚焦 | 在同一个视频上圈选最多六个板位，缩放、拖动、切换并记住阅读位置；按住 F 临时看全景。 |
| 播放与回听 | 原进度、播放/暂停、倍速、短回听和回到回听前位置；切板与调速不自动暂停。 |
| 截图与标记 | 截图保存原图、课堂时刻和当时布局；标记保留时刻。取不到可靠背景时保留已有材料，不拼造板书。 |
| 课堂图片流 | 按课程、讲次和课堂时刻浏览；预览原图、再圈局部、多图选择、复制、下载、明确定位原处。浏览旧图本身不跳视频。 |
| 带图提问 | 主动选择材料后带入 ChatGPT；在原生输入框编辑一份问题，插入图片引用、移出、改序和撤销。截图不自动打开侧栏或发送。 |
| 草稿与恢复 | 保存原文、图片关系、选择和未完成操作；同讲续写，跨讲复用为副本；不能确认发送时保留未知状态。 |
| 全屏与写字保护 | 分别控制。保护针对课程误触，保留聊天输入和退出通道；不负责系统级锁定。 |
| 本地清晰人声 | 可选 MossFormer2_SE_48K / NVIDIA CUDA 路径；处理未就绪或失败时保留原声。不是教师声纹分离。 |

完整截图资料库、内嵌 ChatGPT、原生写字保护需要 Windows 组件。基础聚焦、板位和原视频播放不依赖声音模型。网页、媒体域名及原生窗口定位有明确适配范围；不承诺其他学校、浏览器或任意网页可用。

## 从源码安装

以下命令在 **PowerShell** 中执行，工作目录为仓库根目录。首次安装不需要管理员权限。Python、Node.js、Git 须已加入 PATH；运行目录应可由当前用户写入。

### 1. 准备环境

| 依赖 | 用途 |
| --- | --- |
| [Python 3.13 x64](https://www.python.org/downloads/windows/) | 构建、下载依赖与本机媒体服务；当前使用 3.13。下载脚本最低要求 3.11。 |
| [Node.js 24](https://nodejs.org/en/download) | 构建时检查生成的 JavaScript 语法；无 npm 依赖，不必执行 npm install。 |
| Windows x64 的 .NET Framework 4.8 | 编译并运行原生助手。编译器通常位于 Windows 的 Microsoft.NET/Framework64/v4.0.30319 目录。 |
| [Microsoft Edge WebView2 Evergreen Runtime](https://developer.microsoft.com/en-us/microsoft-edge/webview2/) | 运行内嵌 ChatGPT。SDK 下载不能替代 Runtime 安装。 |
| [Google Chrome](https://www.google.com/chrome/) | 登录并打开自己有权限观看的智云回放。 |

```powershell
git clone https://github.com/1760139151lkh-ctrl/zhiyun-focus.git
cd zhiyun-focus
python --version
node --version
python -X utf8 viewer/companion/fetch_sdk.py
python -X utf8 viewer/build.py
powershell -NoProfile -File viewer/companion/build.ps1
python -X utf8 viewer/build.py --check
```

`fetch_sdk.py` 从官方 NuGet 下载锁定的 WebView2 SDK，校验包和 DLL 的 SHA-256。已有文件与锁定值不同会保留并报错，不能直接忽略校验。构建只生成文件，不注册协议、不添加登录启动项，也不替换正在运行的助手。

主要构建产物：

| 位置 | 用途 |
| --- | --- |
| 根目录 `打开智云聚焦.html` | 安装/更新书签的本地入口；构建后才存在。 |
| `viewer/dist/` | 入口页、完整书签、观看脚本、ChatGPT 接收脚本及构建摘要。 |
| `viewer/companion/StudyCompanion.exe` | 原生助手；与同目录两个 WebView2 DLL、两份许可文件及 `.exe.build.json` 配套使用。 |

请保留仓库目录关系。助手从 `viewer/companion` 定位 `viewer/audio-helper`，单独搬走 EXE 不等于安装了完整项目。

### 2. 启动助手并安装书签

```powershell
Start-Process -FilePath .\viewer\companion\StudyCompanion.exe -WindowStyle Hidden
```

助手会在系统托盘运行。待组件准备好后，首次注册浏览器入口：

```powershell
Start-Process -FilePath .\viewer\companion\StudyCompanion.exe -ArgumentList '--install-browser-link' -WindowStyle Hidden -Wait
Start-Process -FilePath .\打开智云聚焦.html
```

将入口页上的「智云聚焦」拖到 Chrome 书签栏。打开已登录的智云课程回放，等视频画面出现，再点击书签。入口页的「启动助手」以后可以通过 `zhiyun-focus://` 启动已注册组件。

注册前会核对正在运行的组件版本、构建身份和 WebView2 就绪状态。若首次启动仍在准备，稍后重试注册；具体原因查看 `viewer/companion/startup.log`。本机没有模型时，声音准备失败不影响基础观看和 ChatGPT 组件。

如希望随 Windows 登录启动，将注册命令的参数换成 `--install-startup`；它同时注册协议和当前用户的登录启动项。默认步骤不启用登录启动。移除与退出见下文。

### 3. 可选：安装声音与原始帧服务

完整的清晰人声需要 NVIDIA CUDA GPU、FFmpeg/ffprobe、Python 环境和约 **222 MB** 的模型/作者源码；PyTorch 等 Python 依赖另占数 GB。按 [声音安装步骤](viewer/audio-helper/README.md#安装) 准备。默认存放于 `.runtime/audio/`，不会提交 Git。

仅需要原始视频帧读取时，安装 FFmpeg/ffprobe 后即可使用媒体服务；这一能力不依赖 GPU 模型成功加载。当前服务只读取经过浏览器访问校验的指定浙大 HTTPS MP4，MSE/blob、额外认证来源或无法确认同帧时保留可靠的可见截图和已有记录。

## 一次看课流程

1. **圈板位。** 点击板位图标，在全景中新增或重圈；点缩略板位切换。滚轮缩放、拖动画面移动位置。等比适配可能有留白，不拉伸公式。
2. **读和回听。** 底部附近短暂停留可唤起工具栏。控制区、浮层和键盘焦点保持可操作；移开后收起。回听后可返回原来的时刻和视角。
3. **留材料。** 点击截图图标或按 S 框选；保存后尝试复制圈选图。也可以只标记此刻。关闭临时缩略图只收起，原图仍在课堂资料中。
4. **需要时再问。** 点击材料旁的气泡或在图片流中选择材料，主动带入提问。在 ChatGPT 原生输入框写问题；附件上的操作可预览原图、插入引用、移出或撤销。最终点击 ChatGPT 的发送按钮由你完成。
5. **继续看课。** 侧栏左边缘可拖动调宽，双击恢复默认宽度。收起侧栏不暂停视频、不删除草稿。资料里查看历史图不跳转；明确选择定位原处才核对媒体来源并恢复时刻和视角。
6. **保留与备份。** 资料入口中可浏览其他讲次、续写本讲草稿、把其他讲次材料作为副本带入，或导出包含原图、布局和问题的备份。

常用快捷键仅在观看区域生效；输入框、中文输入法组合和浏览器组合键保留原语义。

| 按键 | 动作 |
| --- | --- |
| 空格 | 播放 / 暂停 |
| ← / → | 后退 / 前进 5 秒 |
| 1–6 | 切换已存在的板位 |
| 按住 F / 松开 F | 临时全景 / 回到原视角 |
| R | 重圈当前区域 |
| S | 框选截图 |
| Esc | 取消当前圈选或收起相应界面；写字保护中可长按后松开退出 |
| Tab | 到达控件并保留可见焦点 |

写字保护还可通过右上角入口、触笔按住后右滑或鼠标右键长按解除；系统托盘提供立即解除全部保护。它不替代独立的系统专注程序。

## 数据、隐私与边界

| 位置 | 保存什么 | 更新时如何处理 |
| --- | --- | --- |
| `%USERPROFILE%\.zhiyun-focus\StudyLibrary` | 原图、课堂时刻、布局快照、问题、引用、选择与交付记录 | 用户资料，必须保留；建议从资料界面导出备份。 |
| `%USERPROFILE%\.zhiyun-focus\ChatGPT` | 内嵌 ChatGPT 登录资料 | 用户账号资料，不提交、不共享、不作为构建缓存清理。 |
| 课程站点 localStorage / IndexedDB | 视图偏好、板位、尚未被本地资料库确认的截图等 | 清理站点数据可能丢失未落盘材料；原生库中已确认资料独立保留。 |
| `.runtime/audio` | 下载的模型、作者源码和可选虚拟环境 | 可按锁文件重建；不属于课堂资料。 |
| 组件目录中的 `startup.log` | 本机启动诊断 | 提交问题前人工检查和脱敏，不上传整份账号或课堂目录。 |

声音在本机处理，不使用麦克风，也不向模型托管站上传课堂音频。使用 ChatGPT 时，主动选入的图片和文字会进入你的 ChatGPT 网页草稿，发送由你确认；这与完全离线的观看和声音处理不同。项目不收集遥测，不保存临时签名媒体 URL；课堂资料及其分享权限由使用者管理。

服务仅绑定回环地址：`8772` 为原生组件，`8771` 为媒体服务，`8769` 为可选开发预览。Host、Origin、协议头、会话与令牌检查是实现的一部分。不要开放到局域网，不要为了连接问题关闭来源校验、CSP 或浏览器安全设置。

## 更新、退出与移除

更新前保存当前输入并备份资料。用 `git pull --ff-only` 获取源码，重新下载/校验 SDK、构建网页及组件，并替换书签网址。旧书签内嵌旧代码，不会自动更新。

正在使用的 EXE/DLL 不能覆盖时，先从托盘正常退出，或运行：

```powershell
powershell -NoProfile -File viewer/companion/stop.ps1
```

脚本等草稿保存和接受的写入完成；失败时保留原实例，不能强杀来制造成功。再构建并启动新组件。已安装的同目录组件会在正常接替且就绪后更新协议和原本已开启的登录启动项；首次安装仍按上面的注册步骤操作。

如需移除自动入口，使用当前注册对应的组件：

```powershell
Start-Process -FilePath .\viewer\companion\StudyCompanion.exe -ArgumentList '--remove-startup' -WindowStyle Hidden -Wait
Start-Process -FilePath .\viewer\companion\StudyCompanion.exe -ArgumentList '--remove-browser-link' -WindowStyle Hidden -Wait
python -X utf8 viewer/audio-helper/launcher.py stop
```

再正常退出助手并删除浏览器书签。移除入口不删除 `.zhiyun-focus` 中的资料。刷新课程页面可退出当前网页聚焦。

## 常见问题

| 现象 | 检查顺序 |
| --- | --- |
| 构建缺 SDK | 先执行 `python viewer/companion/fetch_sdk.py`；摘要不匹配时保留文件并核对版本，不能绕过检查。 |
| 构建找不到 WebView2 Runtime | 安装 Evergreen Runtime；SDK 两个 DLL 与系统 Runtime 是不同依赖。 |
| 点击书签无效果 | 确认在允许的智云回放域名、视频已有画面，且用的是本次构建的书签地址。 |
| 不能打开提问或连接助手 | 确认托盘组件、端口 `8772`、当前 EXE 的构建记录和启动日志；不要复制启动多个窗口来代替检查。 |
| 截图背景不完整 | 检查画面遮挡、FFmpeg/ffprobe 和媒体来源；已有局部原图会保留，不能拿当前帧回填历史材料。 |
| 清晰人声未生效 | 查看 [声音排查](viewer/audio-helper/README.md#排查)，确认 CUDA、模型摘要和实际服务状态。勾选偏好不代表已听到增强输出。 |
| 草稿看起来没附上或发送未知 | 保留资料和原操作，先查看当前讲次/对话与已有记录；不要凭文本相同或看到回复就伪造发送确认。 |
| 更新后仍是旧代码 | 更新书签，并核对进程路径、`buildId`、EXE manifest 和协议注册；功能版本相同不代表字节相同。 |

## 开发与贡献

项目由原生 ES modules、Python 标准库构建器和 C#/.NET Framework 组件组成，无前端框架和 npm 依赖。可用 `python viewer/serve.py` 在 `http://127.0.0.1:8769/` 预览生成的安装入口。它只服务 `viewer/dist`，不是课程代理。

修改源码后运行网页构建、`--check` 和相关原生构建。交互改动还必须实际操作受影响的课程流程；构建成功不能证明截图、撤销、输入法、恢复或听感正确。当前公开树不包含独立自动化测试套件，不要把历史私有样本或生成文件当成测试依赖。

提交时更新对应说明和 [逐文件地图](docs/PROJECT_MAP.md)。只提交源码、必要文档及锁文件；`work/`、`artifacts/`、实验副本、模型、虚拟环境、构建产物、账号资料和课堂原图均不进入 Git。发布边界及 Agent 工作要求见 [AGENTS.md](AGENTS.md)。

## 许可

项目原创部分采用 [MIT](LICENSE)。`viewer/audio-helper/mossformer.py` 及下载的 ClearerVoice-Studio 模型代码/权重适用 Apache-2.0；WebView2 SDK 保留其原许可和 notices。详见 [第三方说明](THIRD_PARTY_NOTICES.md)。课堂内容、商标及用户数据不在本仓库授权范围内。
