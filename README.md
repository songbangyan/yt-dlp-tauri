# yt-dlp-windows Tauri

A Tauri 2 rebuild of `yt-dlp-windows`: paste a video URL, preview metadata, choose a quality, and download an MP4-friendly file on Windows.

[中文](./README_zh.md)

## Status

This folder is a standalone Tauri rewrite created under `~/yt-dlp-windows-tauri`. It keeps the original app's core workflow while replacing the WinUI/.NET shell with a Rust + TypeScript desktop app.

Implemented:

- Parse video metadata through bundled `yt-dlp`.
- Show title, thumbnail, source URL, duration, description, and quality options.
- Download with live progress, speed, ETA, and cancellation.
- Choose, save, reset, and open the output folder.
- Check bundled `yt-dlp`, FFmpeg / ffprobe, and Deno status.
- Install or repair the current target's toolchain from inside the app.
- Keep local operational logs.

## Stack

| Layer | Choice |
| --- | --- |
| Desktop runtime | Tauri 2 |
| Backend | Rust |
| Frontend | Vanilla TypeScript + Vite |
| UI style | Product UI tuned with `$impeccable`: restrained surfaces, dense workflow layout, stable controls |
| Toolchain | App-managed Windows `yt-dlp.exe`, `ffmpeg.exe`, `ffprobe.exe`, `deno.exe` |
| Bundle target | NSIS installer |

## Build From Source

Use Windows for the real app build. The app can install its own toolchain on first run, and `scripts/download-tools.ps1` remains available for development or offline packaging.

Prerequisites:

- Windows 10/11
- WebView2 Runtime
- Node.js 20+ or 22+
- Rust stable with the MSVC toolchain
- PowerShell 5+ or PowerShell 7+

Install dependencies:

```powershell
npm install
```

Optional: pre-restore tools for a development checkout:

```powershell
.\scripts\download-tools.ps1
```

This step is optional for normal app use. If tools are missing, open the app and click `Install tools` in the Toolchain panel.

Run in development:

```powershell
npm run tauri dev
```

Build an installer:

```powershell
npm run tauri build
```

The configured bundle target is `nsis`; output is written under `src-tauri\target\release\bundle\nsis\`.

## Verification

Frontend build:

```powershell
npm run build
```

Rust backend check:

```powershell
cargo check --manifest-path .\src-tauri\Cargo.toml
```

The WSL environment can run those checks. For a real Windows release, build on Windows with the MSVC Rust toolchain.

## Runtime Data

Downloaded videos default to:

```text
%USERPROFILE%\Downloads\yt-dlp-windows\
```

App state and logs are stored under:

```text
%LOCALAPPDATA%\yt-dlp-windows-tauri\state\
%LOCALAPPDATA%\yt-dlp-windows-tauri\logs\app.log
```

Development checkout tools can live at:

```text
src-tauri\Tools\win-x64\yt-dlp\yt-dlp.exe
src-tauri\Tools\win-x64\ffmpeg\bin\ffmpeg.exe
src-tauri\Tools\win-x64\ffmpeg\bin\ffprobe.exe
src-tauri\Tools\win-x64\deno\deno.exe
```

Installed app tools are written under the app data directory instead, for example:

```text
%LOCALAPPDATA%\yt-dlp-windows-tauri\Tools\win-x64\
```

Versions, source URLs, target names, and SHA-256 hashes are tracked in [`src-tauri/tools-manifest.json`](./src-tauri/tools-manifest.json).

## Project Layout

```text
index.html                    app shell markup
src/main.ts                   Tauri command wiring and UI state
src/styles.css                product UI styling
src-tauri/src/lib.rs          Rust backend commands and yt-dlp process control
src-tauri/tauri.conf.json     Tauri app and bundle configuration
scripts/download-tools.ps1    optional development restore script
```

## Tool Update Note

The app installs the current target from `src-tauri/tools-manifest.json` and verifies each extracted executable with SHA-256. `win-x64` is populated now; the manifest structure is ready for `win-arm64` once all tool URLs and hashes are pinned.

## License

Keep the original project's GPL obligations in mind when distributing this app, because the bundled yt-dlp executable and FFmpeg GPL build affect redistribution. See [`THIRD-PARTY-NOTICES.md`](./THIRD-PARTY-NOTICES.md).
