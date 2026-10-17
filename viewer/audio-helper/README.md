# 本地声音与原始帧服务

本目录为智云聚焦提供可选的 MossFormer2_SE_48K 人声增强和经过来源/时刻核验的原始视频帧。服务使用原课程时钟，不另开播放器、不采集麦克风、不把课堂音频上传到模型站点。基础观看无需安装模型。

产品语义见 [AGENTS.md](../../AGENTS.md)，完整应用安装见 [根 README](../../README.md)，本目录各文件见 [项目地图](../../docs/PROJECT_MAP.md)。当前服务 build 为 **10**，与应用版本 1.9.6 分别管理。

## 安装

以下命令在仓库根目录的 PowerShell 执行。完整增强路径需要 Python 3.13 x64、支持 CUDA 的 NVIDIA GPU/驱动，以及 PATH 中可用的 `ffmpeg` 和 `ffprobe`。从 [FFmpeg 官方下载入口](https://ffmpeg.org/download.html) 选择 Windows 发行包；本仓库不分发解码器二进制。先运行：

```powershell
ffmpeg -version
ffprobe -version
python -X utf8 viewer/audio-helper/fetch_assets.py
python -m venv .runtime/audio/cv-env
& .\.runtime\audio\cv-env\Scripts\python.exe -m pip install torch==2.11.0 torchaudio==2.11.0 --index-url https://download.pytorch.org/whl/cu128
& .\.runtime\audio\cv-env\Scripts\python.exe -m pip install -r viewer/audio-helper/requirements.txt
& .\.runtime\audio\cv-env\Scripts\python.exe -c "import torch; print(torch.__version__); print(torch.cuda.is_available())"
```

PyTorch 安装命令对应 [官方 2.11.0 CUDA 12.8 发行说明](https://pytorch.org/get-started/previous-versions/)。最后一行应显示 CUDA 版本并返回 `True`；为 `False` 时不代表本机模型已经可用。当前实现没有 CPU 增强分支，不应随意把设备字符串改为 CPU 后宣称支持。

模型与作者源码约 222 MB；GPU Python 依赖另占数 GB。下载器只访问锁文件中固定的公开地址，逐文件核对大小及 SHA-256，并以临时文件原子提交。已有文件一致时复用，不一致时保留并停止；网络失败后可重新运行同一命令。`requirements.txt` 锁定直接导入的 Python 包，不是整个环境的传递依赖锁。

默认结构：

```text
.runtime/audio/
├── cv-env/                       # 独立 Python 虚拟环境
├── cv-runtime/
│   ├── LICENSE                   # 作者源码 Apache-2.0
│   └── models/mossformer2_se/     # 锁定的七个作者 Python 文件
└── models/MossFormer2_SE_48K/
    ├── README.md                 # 原始模型卡
    └── last_best_checkpoint.pt   # 固定版本权重
```

可在启动助手前设置 `ZJF_AUDIO_HOME`，指定包含上述三个子目录的绝对路径；设置后，下载器和服务都使用该位置，创建虚拟环境时也要替换示例路径。默认位置缺少模型资产而旧的 `work/immersive_next/audio-lab` 中仍有完整资产时，自动复用旧路径。旧目录是兼容运行环境，不随开源仓库分发，也不能未经确认删除。

## 启动、使用与停止

安装好模型后，Windows 助手会自动准备媒体服务。手工入口等价于：

```powershell
python -X utf8 viewer/audio-helper/launcher.py
python -X utf8 viewer/audio-helper/launcher.py stop
```

根目录 `启用清晰人声.cmd` / `停止清晰人声.cmd` 提供双击入口。启动器自身只需要 Python 标准库，再选择资产目录中的 `cv-env` 启动服务。它通过进程间锁协调启动/停止，并绑定服务实例 ID；不会结束其他 Python 或 FFmpeg 进程。

回到课程后，设置中的声音选项控制是否使用清晰人声。默认偏好开启，但只有有效增强输出准备好后才切换实际声音路径。关闭、seek、倍速变化或输出失效会释放旧片段并归还原声。模型初始化失败不应暂停课程；停止后台服务后，下次明确启用或助手启动可能重新准备它。

首次 HTTP 端口先开放，模型在后台加载和预热。启动器返回时可能仍是 `loading`，这不等于已经能听到增强输出。启动异常记录在 `viewer/audio-helper/startup.log`；运行期错误仅保留固定类别、阶段和耗时，不输出带签名的媒体地址。

## 原始帧能力

仅需 FFmpeg/ffprobe 就能提供 `/frame`，不要求 CUDA 模型初始化成功。服务先读取容器中的视频轨与 PTS 索引，拒绝无法确定浏览器选轨的多视频轨来源，解码不晚于请求时刻的对应帧，返回原始 PNG、实际时刻和下一帧边界。

单边最多 16,384 像素、总像素最多 33,554,432，PNG 二进制最多 72 MiB 减 64 KiB。不会为传输默默缩成低清原图。不能证明同源同帧或超限时，保留此前取得的可靠局部材料；具体数据约定见 [STORAGE.md](../STORAGE.md)。

## 安全与资源契约

- 只监听 `127.0.0.1:8771`，允许的 Origin 与媒体 HTTPS 域名见 `server.py`。媒体仅来自 `vod.cmc.zju.edu.cn` 和 `resource.cmc.zju.edu.cn` 的受支持 MP4，拒绝任意 URL、凭证和 cookies。
- 页面先做真实 CORS/range 探测；本机服务不是绕过课程访问控制的代理。MSE/blob、其他站点或需要额外认证的来源保留原声。
- 声音窗口为 4–24 秒，附加最多 2 秒前文；前端首块较短，后续预取相邻区间。4 秒模型片段交叠处理，FFmpeg 调整倍速并保留音高。
- 音频和原始帧分别串行限流。取消会终止本服务登记的解码子进程，旧 seek/来源/任务不能接管新播放。
- 没有永久音频缓存、声纹库或麦克风入口。模型输出不是无损降噪，也不保证去除与教师重叠的咳嗽或他人说话。

## 排查

用正常只读状态接口查看真实运行实例：

```powershell
$voiceHeaders=@{Origin='http://127.0.0.1:8769';'X-ZJF-Protocol'='1'}
Invoke-RestMethod http://127.0.0.1:8771/health -Headers $voiceHeaders
```

| 状态或错误 | 处理 |
| --- | --- |
| 连接被拒绝 | 确认 Python/启动器路径，查看启动日志；检查端口是否被其他应用占用。 |
| `status: loading` | 模型正在加载/预热，原声继续；稍后读状态，不反复创建进程。 |
| 模型文件缺失 | 检查 `ZJF_AUDIO_HOME` 和 `fetch_assets.py` 输出的位置；再运行下载器校验。 |
| CUDA 不可用 | 用同一个 `cv-env` 查看 `torch.cuda.is_available()`，核对驱动和 GPU 版 PyTorch。 |
| 缺少 Python 包 | 用该环境的 `python -m pip` 安装，不能只在另一个全局 Python 中安装。 |
| `frame_decode: 0` | 服务进程的 PATH 中没有 ffprobe；安装后正常停止并重启服务。 |
| `ready: true` 但页面仍原声 | 模型可用不代表这段媒体可访问；检查允许来源、浏览器访问探针和当前页面任务身份。 |
| 停止未确认 | 保留实例、查看当前状态；不要按 PID 文件强杀，PID 文件不是当前所有权证据。 |

修改模型或特征处理后，须用获准的真实课程片段进行实际听音与同步对比。仅完成权重加载或静音预热不能宣称听感已验证。

## 固定来源

作者代码为 ClearerVoice-Studio commit `6b3774dc79c46ae8bed2a4fa5f706f0ac8c75c61`；模型为 `alibabasglab/MossFormer2_SE_48K` revision `eff8c97925c8bec812af707814b3e5d777fd4503`。所有下载地址和摘要见 [assets.lock.json](assets.lock.json)，许可见 [第三方声明](../../THIRD_PARTY_NOTICES.md)。
