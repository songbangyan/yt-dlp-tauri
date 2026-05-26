$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
$TauriRoot = Join-Path $Root 'src-tauri'
$ToolsRoot = Join-Path $TauriRoot 'Tools\win-x64'
$TempRoot = Join-Path $TauriRoot 'Tools\.tmp'

New-Item -ItemType Directory -Force -Path $ToolsRoot, $TempRoot | Out-Null

function Get-FileSha256([string] $Path) {
  return (Get-FileHash -Algorithm SHA256 -Path $Path).Hash.ToLowerInvariant()
}

function Assert-Hash([string] $Path, [string] $Expected) {
  $actual = Get-FileSha256 $Path
  if ($actual -ne $Expected.ToLowerInvariant()) {
    throw "SHA-256 mismatch for $Path. Expected $Expected, got $actual."
  }
}

function Download-File([string] $Url, [string] $Destination) {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Destination) | Out-Null
  Write-Host "Downloading $Url"
  Invoke-WebRequest -Uri $Url -OutFile $Destination
}

$ytDlp = Join-Path $ToolsRoot 'yt-dlp\yt-dlp.exe'
Download-File 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe' $ytDlp
Assert-Hash $ytDlp '3db811b366b2da47337d2fcfdfe5bbd9a258dad3f350c54974f005df115a1545'

$ffmpegZip = Join-Path $TempRoot 'ffmpeg-master-latest-win64-gpl.zip'
Download-File 'https://github.com/yt-dlp/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip' $ffmpegZip
$ffmpegExtract = Join-Path $TempRoot 'ffmpeg'
Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $ffmpegExtract
Expand-Archive -Force -Path $ffmpegZip -DestinationPath $ffmpegExtract
$ffmpegSourceRoot = Get-ChildItem -Path $ffmpegExtract -Directory | Select-Object -First 1
if (-not $ffmpegSourceRoot) { throw 'Unable to find extracted FFmpeg directory.' }
$ffmpegBin = Join-Path $ToolsRoot 'ffmpeg\bin'
New-Item -ItemType Directory -Force -Path $ffmpegBin | Out-Null
Copy-Item -Force (Join-Path $ffmpegSourceRoot.FullName 'bin\ffmpeg.exe') (Join-Path $ffmpegBin 'ffmpeg.exe')
Copy-Item -Force (Join-Path $ffmpegSourceRoot.FullName 'bin\ffprobe.exe') (Join-Path $ffmpegBin 'ffprobe.exe')
Assert-Hash (Join-Path $ffmpegBin 'ffmpeg.exe') '6a059f42b85f54d9a413185d05ec16b7b5e85304af0bddd381d64a91be00adec'
Assert-Hash (Join-Path $ffmpegBin 'ffprobe.exe') 'c9bc6683d2e697be73cf54848374abc1ba7dd7d897697c2a1e2c2e46589dc377'

$denoZip = Join-Path $TempRoot 'deno-x86_64-pc-windows-msvc.zip'
Download-File 'https://github.com/denoland/deno/releases/latest/download/deno-x86_64-pc-windows-msvc.zip' $denoZip
$denoExtract = Join-Path $TempRoot 'deno'
Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $denoExtract
Expand-Archive -Force -Path $denoZip -DestinationPath $denoExtract
$denoDir = Join-Path $ToolsRoot 'deno'
New-Item -ItemType Directory -Force -Path $denoDir | Out-Null
Copy-Item -Force (Join-Path $denoExtract 'deno.exe') (Join-Path $denoDir 'deno.exe')
Assert-Hash (Join-Path $denoDir 'deno.exe') 'b6e83993f1f1ab97075a77043de61118966d719b5450bc631251d47c3a34230b'

Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $TempRoot
Write-Host 'Bundled tools restored successfully.'
