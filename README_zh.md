# yt-dlp-windows Tauri

`yt-dlp-windows` 的 Tauri 2 重构版：在 Windows 上粘贴视频链接，预览信息，选择清晰度，然后下载 MP4 友好的文件。

[English](./README.md)

## 当前状态

这个文件夹是放在 `~/yt-dlp-windows-tauri` 下的独立 Tauri 重写版本。它保留原应用的核心流程，但把 WinUI/.NET 外壳替换为 Rust + TypeScript 桌面应用。

已实现：

- 通过内嵌 `yt-dlp` 解析视频信息。
- 展示标题、封面、来源 URL、时长、描述和清晰度选项。
- 下载时显示实时进度、速度、ETA，并支持取消。
- 选择、保存、恢复和打开输出目录。
- 检测内嵌 `yt-dlp`、FFmpeg / ffprobe 和 Deno 状态。
- 在应用内安装或修复当前 target 的工具链。
- 写入本地运行日志。

## 技术栈

| 层 | 选择 |
| --- | --- |
| 桌面运行时 | Tauri 2 |
| 后端 | Rust |
| 前端 | Vanilla TypeScript + Vite |
| UI 风格 | 使用 `$impeccable` 控制的产品 UI：克制界面、紧凑工作流、稳定控件 |
| 工具链 | 应用管理的 Windows `yt-dlp.exe`、`ffmpeg.exe`、`ffprobe.exe`、`deno.exe` |
| 打包目标 | NSIS installer |

## 从源码构建

真实应用构建请在 Windows 上执行。应用首次运行时可以自动安装工具链，`scripts/download-tools.ps1` 则保留给开发或离线打包使用。

依赖：

- Windows 10/11
- WebView2 Runtime
- Node.js 20+ 或 22+
- Rust stable，安装 MSVC toolchain
- PowerShell 5+ 或 PowerShell 7+

安装依赖：

```powershell
npm install
```

可选：为开发 checkout 预先还原工具：

```powershell
.\scripts\download-tools.ps1
```

普通使用不需要先执行这个脚本。如果应用检测到工具缺失，在 Toolchain 面板点击 `Install tools` 即可。

开发运行：

```powershell
npm run tauri dev
```

构建安装包：

```powershell
npm run tauri build
```

当前配置的 bundle target 是 `nsis`；输出位于 `src-tauri\target\release\bundle\nsis\`。

## 验证

前端构建：

```powershell
npm run build
```

Rust 后端检查：

```powershell
cargo check --manifest-path .\src-tauri\Cargo.toml
```

WSL 可以跑这些检查。真实 Windows 发布包请在 Windows + Rust MSVC toolchain 环境中构建。

## 运行时数据

视频默认下载到：

```text
%USERPROFILE%\Downloads\yt-dlp-windows\
```

应用状态和日志位于：

```text
%LOCALAPPDATA%\yt-dlp-windows-tauri\state\
%LOCALAPPDATA%\yt-dlp-windows-tauri\logs\app.log
```

开发 checkout 工具可以位于：

```text
src-tauri\Tools\win-x64\yt-dlp\yt-dlp.exe
src-tauri\Tools\win-x64\ffmpeg\bin\ffmpeg.exe
src-tauri\Tools\win-x64\ffmpeg\bin\ffprobe.exe
src-tauri\Tools\win-x64\deno\deno.exe
```

安装后的应用会把工具写入应用数据目录，例如：

```text
%LOCALAPPDATA%\yt-dlp-windows-tauri\Tools\win-x64\
```

工具版本、来源 URL、target 名称和 SHA-256 哈希记录在 [`src-tauri/tools-manifest.json`](./src-tauri/tools-manifest.json)。

## 项目结构

```text
index.html                    应用界面结构
src/main.ts                   Tauri 命令调用和 UI 状态
src/styles.css                产品 UI 样式
src-tauri/src/lib.rs          Rust 后端命令和 yt-dlp 进程控制
src-tauri/tauri.conf.json     Tauri 应用与打包配置
scripts/download-tools.ps1    可选的开发工具链还原脚本
```

## 工具更新说明

应用会从 `src-tauri/tools-manifest.json` 安装当前 target，并对每个解压出的可执行文件做 SHA-256 校验。现在已填充 `win-x64`；manifest 结构已为 `win-arm64` 预留，等所有工具 URL 和 hash 固定后即可补齐。

## 许可证

分发时需要保留原项目的 GPL 义务，因为内嵌的 yt-dlp 可执行文件和 FFmpeg GPL 构建会影响再分发。详见 [`THIRD-PARTY-NOTICES.md`](./THIRD-PARTY-NOTICES.md)。
