# Delta Highlight

自动识别《三角洲行动》录像中的本人击杀提示，并使用 ffmpeg 生成可公开播放的精彩集锦。

![Version](https://img.shields.io/badge/version-2.0.8-2563eb)
![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11-4f46e5)
![Node.js](https://img.shields.io/badge/Node.js-22%2B-339933?logo=nodedotjs&logoColor=white)
![Python](https://img.shields.io/badge/Python-3.12-3776AB?logo=python&logoColor=white)
![License](https://img.shields.io/badge/license-MIT-green)

> 当前版本重点识别玩家本人击杀时出现在画面中央偏下的白色骷髅提示，不扫描右上角全局击杀栏。

## 项目简介

Delta Highlight 面向长时间、高码率的游戏录像。它不依赖视频剪辑软件逐帧操作，而是通过 OpenCV 模板匹配自动定位击杀时刻，再调用 ffmpeg 裁剪、拼接和导出成片。

程序提供本地 Web 界面，可在浏览器中完成素材选择、进度查看、镜头编辑、音频混入和成品导出。Windows 发布版已经内置 Node.js、Python、OpenCV、NumPy、ffmpeg 和 ffprobe，用户不需要手动配置运行环境。

## 原作者与来源

- 原作者：Zaphod
- 原项目：<https://gitee.com/Zaphod/delta-force-automatic-video-editing>
- 说明：本项目基于原作者的开源项目进行 Windows 适配、性能优化、资源调度和公开播放兼容性升级；原始项目、模板和相关成果归原作者及对应贡献者所有。

## 功能特性

- 自动扫描录像并识别本人白色骷髅击杀提示。
- 只检查画面中央偏下区域，忽略右上角全局击杀信息。
- 支持多个模板尺寸和横向位置变化，适配 1080P、2K、4K 和常见宽屏比例。
- 按击杀时间自动裁剪片段，默认保留击杀前约 5 秒、击杀后约 2 秒。
- 自动合并同一视频中的连续击杀，生成可编辑的镜头脚本。
- 提供网页操作界面、任务进度、当前阶段和预计剩余时间。
- 支持帧缩略图预览、裁剪范围调整、镜头增删和重新导出。
- 支持背景音乐循环播放、结尾淡出和独立音量控制。
- 自动检测 NVIDIA NVENC、Intel Quick Sync、AMD AMF 和 CPU x264。
- 内置设备性能检测，可自动分配扫描并行数、编码线程和资源占用上限。
- 统一导出 H.264 / AVC + AAC，不使用 HEVC，兼容常见播放器和移动设备。
- Windows 版本支持原生素材目录选择窗口，并保持在当前任务窗口上方。

## 工作流程

```mermaid
flowchart LR
    A[选择录像目录] --> B[OpenCV 扫描击杀提示]
    B --> C[生成镜头脚本]
    C --> D[编辑或确认镜头]
    D --> E[ffmpeg 裁剪与拼接]
    E --> F[H.264 集锦成品]
```

处理细节：

1. 扫描素材目录中的视频文件。
2. 每隔约 0.2 秒读取一帧，只解码画面中央偏下的识别区域。
3. 使用项目原始模板匹配白色骷髅击杀提示。
4. 过滤右上角全局击杀栏、橙色载具击杀和精确击杀模板。
5. 合并短时间内位置相近的重复检测，得到击杀时间点。
6. 根据击杀时间生成镜头脚本。
7. 自动选择本机可用的最佳 H.264 编码器。
8. 使用 ffmpeg 裁剪、拼接并导出最终视频。
9. 使用 ffprobe 验证输出视频流，确认编码格式正确。

## 下载与安装

### 方式一：Windows 安装包

前往 [GitHub Releases](../../releases/latest) 下载最新的单文件安装程序：

```text
DeltaHighlight-Windows-Installer-v2.0.8.exe
```

安装步骤：

1. 双击安装程序。
2. 选择安装目录，默认建议安装到 `D:\DeltaHighlight`。
3. 根据需要选择是否创建桌面快捷方式。
4. 安装完成后启动程序。
5. 浏览器会自动打开本地 Web 界面。

安装包已经内置：

- Node.js 22
- Python 3.12
- OpenCV
- NumPy
- ffmpeg
- ffprobe

目标电脑不需要单独安装这些组件。由于当前安装程序没有商业代码签名证书，首次运行时 Windows SmartScreen 可能提示“未知发布者”。

### 方式二：源码运行

环境要求：

| 组件 | 建议版本 | 说明 |
| --- | --- | --- |
| Windows | 10 / 11 64 位 | 原生素材目录选择窗口仅支持 Windows |
| Node.js | 22 或更高版本 | 运行 Web 服务和任务调度 |
| Python | 3.12 | 运行视频扫描脚本 |
| OpenCV | 当前稳定版 | 安装 `opencv-python` |
| NumPy | 当前稳定版 | Python 数值计算依赖 |
| ffmpeg | 6.x 或更高版本 | 视频裁剪、拼接和编码 |
| ffprobe | 与 ffmpeg 同版本 | 检查输出视频流 |

PowerShell 启动示例：

```powershell
git clone <repository-url>
cd delta-highlight

npm ci
python -m pip install opencv-python numpy
Copy-Item config.example.json config.json

node src/server.js
```

启动后访问：

```text
http://localhost:3456
```

如果 ffmpeg、ffprobe 或 Python 不在系统 `PATH` 中，请在 `config.json` 中填写绝对路径。

## 配置说明

复制 `config.example.json` 为 `config.json` 后按需修改：

```json
{
  "ffmpegPath": "ffmpeg",
  "pythonPath": "python",
  "outputDir": "./output",
  "materialDir": "",
  "port": 3456
}
```

| 字段 | 说明 | 默认值 |
| --- | --- | --- |
| `ffmpegPath` | ffmpeg 可执行文件路径；填写 `ffmpeg` 时从 `PATH` 查找 | `ffmpeg` |
| `pythonPath` | Python 可执行文件路径；填写 `python` 时从 `PATH` 查找 | `python` |
| `outputDir` | 集锦成品输出目录 | `./output` |
| `materialDir` | 默认录像素材目录，可留空 | `""` |
| `port` | Web 服务端口 | `3456` |

## 使用流程

1. 启动程序并打开本地 Web 界面。
2. 点击“选择文件夹”，选择包含游戏录像的素材目录。
3. 根据电脑性能选择输出清晰度和资源上限。
4. 点击“开始自动剪辑”，等待扫描、裁剪和拼接完成。
5. 在镜头编辑区域查看识别结果，必要时调整时间点或删除误判镜头。
6. 可选启用背景音乐并调节原视频与音乐音量。
7. 重新生成或导出最终视频。
8. 在输出目录中查看集锦成品。

建议先用较低清晰度或预览模式快速检查识别结果，确认镜头无误后再导出原画版本。

## 自适应资源调度

程序会检测 CPU 核心数、内存容量、磁盘读取速度、显卡编码器和实际编码性能，并推荐合适的资源档位。

| 模式 | CPU 上限 | GPU 上限 | 适用场景 |
| --- | --- | --- | --- |
| 自动 | 按设备检测结果分配 | 按设备检测结果分配 | 默认推荐 |
| 省资源 | 35% | 50% | 剪辑时仍需办公或玩其他游戏 |
| 平衡 | 65% | 80% | 速度与前台体验兼顾 |
| 满性能 | 95% | 100% | 尽快完成任务 |
| 自定义 | 20% 至 100% | 20% 至 100% | 手动限制 CPU 和 GPU 占用 |

任务运行期间资源档位不会改变，修改后的设置会在下一次任务中生效。

## 输出规格

公开版统一输出兼容性优先的 MP4：

| 项目 | 规格 |
| --- | --- |
| 容器 | MP4 |
| 视频编码 | H.264 / AVC |
| 硬件编码器 | NVIDIA NVENC、Intel Quick Sync、AMD AMF |
| CPU 回退 | libx264 |
| 音频编码 | AAC-LC |
| 像素格式 | yuv420p |
| 色彩标准 | BT.709 |
| 快速播放 | faststart |
| 禁止格式 | HEVC / H.265 |

程序不会因为外部参数误传而导出 HEVC，并会在任务结束后使用 ffprobe 检查最终视频流。

## 项目结构

```text
.
├── src/
│   ├── server.js                  Web API、任务调度和剪辑流程
│   ├── scan_video_only.py         击杀提示扫描与模板匹配
│   └── lib/
│       ├── clipper.js             视频片段裁剪
│       ├── concat.js              视频片段拼接与导出
│       ├── ffmpeg-engine.js       编码器检测和 H.264 参数
│       ├── ffmpeg-runtime.js      ffmpeg / ffprobe 路径解析
│       ├── ffmpeg-progress.js     ffmpeg 进度解析
│       ├── native-folder-dialog.js Windows 原生目录选择窗口
│       ├── performance-profiler.js 设备性能检测
│       ├── resource-manager.js    自适应资源分配
│       └── shotlog.js             镜头脚本生成与合并
├── web/                           本地 Web 操作界面
├── templates/                     击杀提示匹配模板
├── docs/                          开发和需求记录
└── config.example.json
```

## API 概览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/config` | 获取前端配置和设备摘要 |
| `GET` | `/api/performance` | 获取设备性能档案 |
| `GET` | `/api/resources` | 获取资源分配设置 |
| `PUT` | `/api/resources` | 保存资源上限 |
| `POST` | `/api/scan` | 启动扫描与自动剪辑 |
| `POST` | `/api/stop` | 停止当前任务 |
| `GET` | `/api/events` | 通过 SSE 获取实时进度 |
| `GET` | `/api/shotlog` | 获取当前镜头脚本 |
| `PUT` | `/api/shotlog` | 保存编辑后的镜头脚本 |
| `POST` | `/api/reclip` | 重新裁剪和拼接 |
| `POST` | `/api/upload-music` | 上传背景音乐 |
| `GET` | `/api/output` | 获取成品文件信息 |

## 开发与检查

安装依赖：

```powershell
npm ci
python -m pip install opencv-python numpy
```

检查 JavaScript 入口：

```powershell
node --check src/server.js
```

检查 Python 扫描脚本：

```powershell
python -m py_compile src/scan_video_only.py
```

启动开发服务：

```powershell
node src/server.js
```

## 常见问题

### 扫描不到击杀

- 确认识别的是玩家本人击杀时画面中央偏下的白色骷髅提示。
- 当前版本不会把右上角全局击杀栏当作本人击杀。
- 不要使用视频截图替换 `templates/01-kill-white.png`，应使用项目原始模板。
- 如果游戏 UI 缩放、分辨率或显示比例发生变化，请提交录像片段和游戏设置用于复现。

### 提示找不到 ffmpeg 或 Python

将相关程序加入系统 `PATH`，或在 `config.json` 中填写绝对路径。

### 提示缺少 Python 模块

执行：

```powershell
python -m pip install opencv-python numpy
```

### 成品在其他设备无法播放

当前公开版固定输出 H.264 / AVC + AAC、yuv420p 和 faststart，不使用 HEVC。如果播放器仍无法打开，请使用 ffprobe 检查文件是否完整。

### 4K 或长时间录像处理较慢

- 使用“满性能”或“自动”资源模式。
- 确认系统已安装或启用可用的硬件编码器。
- 先用预览模式确认镜头，再进行原画导出。
- 将素材放在读取速度较快的 SSD 上。
- 关闭同时占用 CPU、GPU 和磁盘的其他程序。

### 网页端口被占用

修改 `config.json` 中的 `port`，重新启动程序后访问新端口。

### Windows 提示未知发布者

当前安装程序尚未使用商业代码签名证书。请从官方 Releases 页面下载文件，并使用 SHA256 校验文件检查完整性。

## 参与贡献

提交问题或功能建议时，请尽量附上：

- Windows 版本和硬件配置。
- Node.js、Python、ffmpeg 版本。
- 游戏分辨率、显示比例和 UI 缩放设置。
- 可复现问题的日志。
- 不包含隐私信息的短视频片段。

请勿在公开 Issue 中上传包含个人信息、账号信息或未经授权的录像素材。

## 免责声明

本项目是非官方开源工具，与《三角洲行动》及其开发商、发行商不存在隶属或授权关系。游戏名称、图标和相关素材的权利归其各自权利人所有。

使用者应只处理自己拥有合法处理权限的视频，并遵守游戏服务条款及所在地区的法律法规。

## 许可证

本项目使用 [MIT License](./LICENSE)。
