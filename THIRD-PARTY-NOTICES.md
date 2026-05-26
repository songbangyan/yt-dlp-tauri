# Third-Party Notices

This app can bundle third-party command-line tools under `src-tauri/Tools/win-x64`. Those tools keep their own licenses and redistribution obligations.

## yt-dlp

- Bundled file: `src-tauri/Tools/win-x64/yt-dlp/yt-dlp.exe`
- Source: <https://github.com/yt-dlp/yt-dlp>
- Release URL tracked by this project: <https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe>
- Notice: yt-dlp itself is Unlicense, but the official PyInstaller executable includes GPLv3+ licensed code and should be treated as GPLv3+ for redistribution.

## FFmpeg / ffprobe

- Bundled files:
  - `src-tauri/Tools/win-x64/ffmpeg/bin/ffmpeg.exe`
  - `src-tauri/Tools/win-x64/ffmpeg/bin/ffprobe.exe`
- Source used by this project: <https://github.com/yt-dlp/FFmpeg-Builds>
- Release URL tracked by this project: <https://github.com/yt-dlp/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip>
- Notice: the selected FFmpeg build is the win64 GPL build. Keep the relevant GPL notices and source availability obligations when redistributing.

## Deno

- Bundled file: `src-tauri/Tools/win-x64/deno/deno.exe`
- Source: <https://github.com/denoland/deno>
- Release URL tracked by this project: <https://github.com/denoland/deno/releases/latest/download/deno-x86_64-pc-windows-msvc.zip>
- Purpose: JavaScript runtime for yt-dlp EJS challenge solver support.

## Updating Bundled Tools

When updating tools, refresh `src-tauri/tools-manifest.json` with version, source URL, retrieval time, and SHA-256 hashes. If the restore script still uses `latest` URLs, update the script and manifest in the same change.
