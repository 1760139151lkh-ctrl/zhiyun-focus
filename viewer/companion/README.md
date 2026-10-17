# Windows 原生组件

本目录提供 x64 .NET Framework 助手：回环 HTTP 服务、浏览器内容区域定位、WebView2 ChatGPT 侧栏、写字保护、原图与草稿保存，以及当前用户的浏览器协议/登录启动注册。它不包含课程视频，也不需要依赖任何 Agent 会话运行。

首次完整安装见 [根 README](../../README.md)，逐文件职责见 [项目地图](../../docs/PROJECT_MAP.md)，存储语义见 [STORAGE.md](../STORAGE.md)。

## 构建

在仓库根目录执行：

```powershell
python -X utf8 viewer/companion/fetch_sdk.py
python -X utf8 viewer/build.py
powershell -NoProfile -File viewer/companion/build.ps1
python -X utf8 viewer/build.py --check
```

需要 Windows x64 的 .NET Framework 编译器、Python、Node.js、WebView2 Evergreen Runtime。`fetch_sdk.py` 恢复 [webview2.lock.json](webview2.lock.json) 固定的两个 SDK DLL；`--check` 只校验，不下载。SDK 与系统 Runtime 不同。

`build.ps1` 从九份 C# 源码构建。它在输出目录中创建独立暂存目录，生成并检查网页脚本，编译带内嵌 `ZjfChatDraft.js` 的 EXE，核对版本、资源摘要和 WebView2 Runtime，再提交整套产物。失败不跳过验证；提交失败按记录恢复已替换文件。成功后删除它自己确认的暂存目录，失败时保留诊断与恢复文件。

默认输出如下，运行或分发组件时必须配套保留：

```text
viewer/companion/
├── StudyCompanion.exe
├── StudyCompanion.exe.build.json
├── Microsoft.Web.WebView2.Core.dll
├── WebView2Loader.dll
├── WebView2.LICENSE.txt
└── WebView2.NOTICE.txt
```

可传 `-OutputPath "viewer/companion/StudyCompanion-1.9.6.exe"`，在不覆盖已有 EXE 的情况下准备候选；DLL 仍与输出 EXE 同目录。独立目录可用于构建核对，但实际启动音频依赖 `viewer/companion` 到仓库根目录的关系，不应只搬走 EXE。单文件原子替换不等于断电时多文件原子提交；异常中断后须校验整套 manifest。

## 正常启动与注册

```powershell
Start-Process .\viewer\companion\StudyCompanion.exe -WindowStyle Hidden
```

无参数启动托盘服务并准备 WebView2/媒体服务，不自动打开课程或发送消息。准备好后可注册 `zhiyun-focus://`：

```powershell
Start-Process .\viewer\companion\StudyCompanion.exe -ArgumentList '--install-browser-link' -WindowStyle Hidden -Wait
```

| 参数 | 意义 |
| --- | --- |
| 无参数 | 正常启动；已有同版本健康实例时复用。 |
| `--install-browser-link` | 首次注册当前 EXE 的浏览器协议，不开启登录启动；要求对应组件已运行且就绪。 |
| `--install-startup` | 注册协议，同时启用当前用户登录启动。 |
| `--remove-startup` | 仅移除指向本 EXE 的登录启动项，保留资料。 |
| `--remove-browser-link` | 仅移除指向本 EXE 的协议入口，保留资料。 |
| `--autostart` | 登录启动入口：开放服务并准备声音，不打开保护或聊天。 |
| `--component-info <JSON路径>` | 输出版本、构建身份和 WebView2 Runtime 信息，不创建聊天 profile。构建器使用它检查依赖。 |
| `--component-check <JSON路径>` | 使用已有诊断入口创建临时 WebView2 controller，输出结果；供有需要的组件诊断使用。 |
| `--replace-build <当前实例构建ID>` | 明确接替相同功能版本、不同构建的实例；只接受被核对的旧身份，不能用任意字符串强行接替。 |

正常新版本先校验自己的 manifest，再请求旧实例保存草稿、排空写入并退出；不能确认就保留旧实例。新组件服务和 WebView 环境就绪后，会接替同目录已有安装的协议和原本已开启的 Run 项，不创建首次安装、不接管其他安装目录、不把较新注册降级。只构建文件不会触发这些行为。

`SystemRegistration.cs` 通过 Windows `StdRegProv` 和当前用户 SID 下的 `HKEY_USERS` 操作真实注册表，避免打包宿主的隔离副本。写入读回确认，失败恢复原值，注册修改使用独立进程间锁。无需管理员权限；不要为图方便改成全机器注册。

## 查看状态与退出

```powershell
$companionHeaders=@{Origin='http://127.0.0.1:8769';'X-ZJF-Protocol'='1'}
Invoke-RestMethod http://127.0.0.1:8772/health -Headers $companionHeaders
```

核对 `build`、`buildId`、`chatRuntimeStatus` 和 `installation`。不能从源码版本推断当前进程已更新。启动异常查看当前 EXE 同目录 `startup.log`。

退出使用系统托盘或：

```powershell
powershell -NoProfile -File viewer/companion/stop.ps1
```

关闭先保护当前草稿并取得持久回执，再等待已接受写入完成。失败恢复输入并保留服务。不要因超时使用任务管理器强杀来宣称完成升级。

## 数据与跨层契约

默认资料库为 `%USERPROFILE%\.zhiyun-focus\StudyLibrary`，ChatGPT profile 为同级 `ChatGPT`。不是 EXE 安装缓存。首次迁移旧 AppData 或宿主隔离目录时采用复制、逐文件摘要核对和原目录保留；不同旧资料冲突时拒绝猜测合并。迁移完成后不依赖原宿主。

HTTP 仅监听 `127.0.0.1:8772`，检查 Host/Origin/协议及必要的实例令牌和会话。敏感 UI 命令在开始前检查截止时间；已经接受的写入有自己的完成租约和结果查询。Token 不能写入日志或截图，不能绕过验证来修连接。

网页与原生桥共同管理页面、路由、编辑器、逻辑问题及每次操作的身份。附图完成、保留旧草稿、已发送、未知和明确撤回是不同结果，不能混用。资料合成/传输不得覆盖原图，备份、索引恢复及原图来源证据以 [STORAGE.md](../STORAGE.md) 为准。

声音代码在 `viewer/audio-helper`，环境默认 `.runtime/audio`，`ZJF_AUDIO_HOME` 可指定外部位置；旧环境有兼容回退。声音不是 EXE 内嵌模型，单独复制组件不会自动安装 GPU 依赖。
