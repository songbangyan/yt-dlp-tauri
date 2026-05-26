import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";

type ToolStatus = {
  name: string;
  relative_path: string;
  full_path: string;
  availability: "available" | "missing" | "cannot_execute";
  version?: string;
  error?: string;
};

type VideoFormatOption = {
  label: string;
  format_selector: string;
  height?: number;
  extension: string;
  is_best: boolean;
};

type VideoMetadata = {
  title: string;
  id?: string;
  webpage_url: string;
  thumbnail_url?: string;
  duration_seconds?: number;
  description?: string;
  format_options: VideoFormatOption[];
};

type AppState = {
  download_directory: string;
  tools_root: string;
};

type DownloadProgress = {
  percent?: number;
  status: string;
  speed?: string;
  eta?: string;
  raw?: string;
};

const state = {
  metadata: null as VideoMetadata | null,
  selectedFormat: null as VideoFormatOption | null,
  busy: false,
  activeOperation: null as "metadata" | "download" | null,
  cancelRequested: false,
  lastUrl: "",
  toolsReady: false,
};

const elements = {
  url: must<HTMLInputElement>("#url"),
  parse: must<HTMLButtonElement>("#parse"),
  download: must<HTMLButtonElement>("#download"),
  cancel: must<HTMLButtonElement>("#cancel"),
  openFolder: must<HTMLButtonElement>("#open-folder"),
  refreshTools: must<HTMLButtonElement>("#refresh-tools"),
  browseFolder: must<HTMLButtonElement>("#browse-folder"),
  resetFolder: must<HTMLButtonElement>("#reset-folder"),
  saveFolder: must<HTMLButtonElement>("#save-folder"),
  folderInput: must<HTMLInputElement>("#folder-input"),
  folderText: must<HTMLElement>("#folder-text"),
  toolRoot: must<HTMLElement>("#tool-root"),
  toolList: must<HTMLElement>("#tool-list"),
  title: must<HTMLElement>("#video-title"),
  details: must<HTMLElement>("#video-details"),
  description: must<HTMLElement>("#video-description"),
  thumbnail: must<HTMLImageElement>("#thumbnail"),
  thumbnailEmpty: must<HTMLElement>("#thumbnail-empty"),
  quality: must<HTMLSelectElement>("#quality"),
  progress: must<HTMLProgressElement>("#progress"),
  progressText: must<HTMLElement>("#progress-text"),
  events: must<HTMLElement>("#events"),
  notice: must<HTMLElement>("#notice"),
};

window.addEventListener("DOMContentLoaded", () => {
  bindEvents();
  listen<DownloadProgress>("download-progress", (event) => updateDownloadProgress(event.payload));
  void bootstrap();
});

function must<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error(`Missing element: ${selector}`);
  }
  return element;
}

function bindEvents() {
  elements.parse.addEventListener("click", () => void parseCurrentUrl());
  elements.download.addEventListener("click", () => void downloadCurrentVideo());
  elements.cancel.addEventListener("click", () => void cancelCurrentDownload());
  elements.refreshTools.addEventListener("click", () => void refreshTools());
  elements.openFolder.addEventListener("click", () => void openDownloadFolder());
  elements.browseFolder.addEventListener("click", () => void browseDownloadFolder());
  elements.saveFolder.addEventListener("click", () => void saveDownloadFolder());
  elements.resetFolder.addEventListener("click", () => void resetDownloadFolder());
  elements.quality.addEventListener("change", () => {
    state.selectedFormat = state.metadata?.format_options[elements.quality.selectedIndex] ?? null;
    updateButtons();
  });
  elements.url.addEventListener("input", () => {
    if (elements.url.value.trim() !== state.lastUrl) {
      state.metadata = null;
      state.selectedFormat = null;
      renderEmptyPreview("Paste a URL and parse it before downloading.");
      renderQualityOptions([]);
    }
    updateButtons();
  });
  elements.url.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void parseCurrentUrl();
    }
  });
}

async function bootstrap() {
  renderEmptyPreview("Paste a video URL to inspect the title, cover, duration and available qualities.");
  logEvent("App booted.");
  await loadAppState();
  await refreshTools();
}

async function loadAppState() {
  const appState = await invoke<AppState>("get_app_state");
  elements.folderText.textContent = appState.download_directory;
  elements.folderInput.value = appState.download_directory;
  elements.toolRoot.textContent = appState.tools_root || "Tools path not resolved yet";
}

async function refreshTools() {
  setBusy(true, "Checking bundled tools...");
  try {
    const tools = await invoke<ToolStatus[]>("check_tools");
    state.toolsReady = tools.every((tool) => tool.availability === "available");
    renderTools(tools);
    showNotice(state.toolsReady ? "Toolchain ready." : "Some bundled tools are missing.", state.toolsReady ? "success" : "warning");
    logEvent(state.toolsReady ? "yt-dlp, ffmpeg, ffprobe and deno are available." : "Tool check found missing tools.");
  } catch (error) {
    state.toolsReady = false;
    showNotice(String(error), "error");
  } finally {
    setBusy(false);
  }
}

async function parseCurrentUrl() {
  const url = elements.url.value.trim();
  if (!url || state.busy) {
    return;
  }

  setBusy(true, "Parsing video metadata...", "metadata");
  renderEmptyPreview("Reading metadata from yt-dlp...");
  try {
    const metadata = await invoke<VideoMetadata>("parse_metadata", { url });
    state.metadata = metadata;
    state.lastUrl = url;
    state.selectedFormat = metadata.format_options[0] ?? null;
    renderMetadata(metadata);
    renderQualityOptions(metadata.format_options);
    showNotice("Metadata parsed.", "success");
    logEvent(`Parsed ${metadata.title}`);
  } catch (error) {
    renderEmptyPreview("Metadata parsing failed. Check the URL and bundled tools.");
    showNotice(String(error), "error");
    logEvent("Metadata parsing failed.");
  } finally {
    setBusy(false);
  }
}

async function downloadCurrentVideo() {
  const metadata = state.metadata;
  const selectedFormat = state.selectedFormat;
  const url = state.lastUrl || elements.url.value.trim();
  if (!metadata || !selectedFormat || !url || state.busy) {
    return;
  }

  setBusy(true, `Starting ${selectedFormat.label} download...`, "download");
  elements.progress.removeAttribute("value");
  try {
    const outputPath = await invoke<string | null>("download_video", {
      request: {
        url,
        format_selector: selectedFormat.format_selector,
        label: selectedFormat.label,
      },
    });
    elements.progress.value = 100;
    elements.progressText.textContent = outputPath ? `Saved to ${outputPath}` : "Download completed. Open the folder to view the file.";
    showNotice("Download completed.", "success");
    logEvent(outputPath ? `Saved ${outputPath}` : "Download completed.");
  } catch (error) {
    const message = String(error);
    elements.progress.value = 0;
    if (message.toLowerCase().includes("cancel")) {
      elements.progressText.textContent = "Download cancelled.";
      showNotice("Download cancelled.", "warning");
      logEvent("Download cancelled.");
    } else {
      elements.progressText.textContent = "Download failed.";
      showNotice(message, "error");
      logEvent("Download failed.");
    }
  } finally {
    setBusy(false);
  }
}

async function cancelCurrentDownload() {
  if (state.activeOperation !== "download" || state.cancelRequested) {
    return;
  }

  state.cancelRequested = true;
  elements.progressText.textContent = "Cancelling download...";
  updateButtons();
  try {
    await invoke("cancel_download");
    logEvent("Cancel requested.");
  } catch (error) {
    showNotice(String(error), "error");
    state.cancelRequested = false;
    updateButtons();
  }
}

async function openDownloadFolder() {
  try {
    await invoke("open_download_directory");
  } catch (error) {
    showNotice(String(error), "error");
  }
}

async function browseDownloadFolder() {
  try {
    const selected = await open({
      title: "Choose download folder",
      directory: true,
      multiple: false,
      defaultPath: elements.folderInput.value || undefined,
    });

    if (typeof selected === "string") {
      elements.folderInput.value = selected;
      await saveDownloadFolder();
    }
  } catch (error) {
    showNotice(String(error), "error");
  }
}

async function saveDownloadFolder() {
  try {
    const appState = await invoke<AppState>("set_download_directory", { directory: elements.folderInput.value });
    elements.folderText.textContent = appState.download_directory;
    elements.folderInput.value = appState.download_directory;
    showNotice("Download folder updated.", "success");
  } catch (error) {
    showNotice(String(error), "error");
  }
}

async function resetDownloadFolder() {
  try {
    const appState = await invoke<AppState>("reset_download_directory");
    elements.folderText.textContent = appState.download_directory;
    elements.folderInput.value = appState.download_directory;
    showNotice("Download folder reset.", "success");
  } catch (error) {
    showNotice(String(error), "error");
  }
}

function renderMetadata(metadata: VideoMetadata) {
  elements.title.textContent = metadata.title;
  elements.details.textContent = [
    metadata.id ? `ID ${metadata.id}` : null,
    metadata.duration_seconds ? formatDuration(metadata.duration_seconds) : null,
    metadata.webpage_url,
  ]
    .filter(Boolean)
    .join(" · ");
  elements.description.textContent = metadata.description?.trim() || "No description returned by yt-dlp.";

  if (metadata.thumbnail_url) {
    elements.thumbnail.src = metadata.thumbnail_url;
    elements.thumbnail.hidden = false;
    elements.thumbnailEmpty.hidden = true;
  } else {
    elements.thumbnail.removeAttribute("src");
    elements.thumbnail.hidden = true;
    elements.thumbnailEmpty.hidden = false;
  }
}

function renderEmptyPreview(message: string) {
  elements.title.textContent = "No video parsed";
  elements.details.textContent = message;
  elements.description.textContent = "";
  elements.thumbnail.removeAttribute("src");
  elements.thumbnail.hidden = true;
  elements.thumbnailEmpty.hidden = false;
}

function renderQualityOptions(options: VideoFormatOption[]) {
  elements.quality.replaceChildren(
    ...options.map((option) => {
      const item = document.createElement("option");
      item.textContent = option.label;
      item.value = option.format_selector;
      return item;
    }),
  );
  elements.quality.disabled = options.length === 0;
}

function renderTools(tools: ToolStatus[]) {
  elements.toolList.replaceChildren(
    ...tools.map((tool) => {
      const row = document.createElement("li");
      row.className = `tool-row is-${tool.availability}`;
      row.innerHTML = `
        <span class="tool-dot"></span>
        <span class="tool-name"></span>
        <span class="tool-version"></span>
      `;
      row.querySelector(".tool-name")!.textContent = tool.name;
      row.querySelector(".tool-version")!.textContent = tool.version || tool.error || tool.relative_path;
      row.title = tool.full_path;
      return row;
    }),
  );
}

function updateDownloadProgress(progress: DownloadProgress) {
  if (typeof progress.percent === "number") {
    elements.progress.value = progress.percent;
  } else {
    elements.progress.removeAttribute("value");
  }

  elements.progressText.textContent = [
    progress.status,
    typeof progress.percent === "number" ? `${progress.percent.toFixed(1)}%` : null,
    progress.speed,
    progress.eta ? `ETA ${progress.eta}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

function setBusy(isBusy: boolean, progressText?: string, operation: "metadata" | "download" | null = null) {
  state.busy = isBusy;
  state.activeOperation = isBusy ? operation : null;
  if (!isBusy) {
    state.cancelRequested = false;
  }
  if (progressText) {
    elements.progressText.textContent = progressText;
  }
  updateButtons();
}

function updateButtons() {
  const hasUrl = elements.url.value.trim().length > 0;
  elements.parse.disabled = state.busy || !hasUrl || !state.toolsReady;
  elements.download.disabled = state.busy || !state.metadata || !state.selectedFormat || !state.toolsReady;
  elements.cancel.disabled = state.activeOperation !== "download" || state.cancelRequested;
  elements.refreshTools.disabled = state.busy;
  elements.browseFolder.disabled = state.busy;
  elements.saveFolder.disabled = state.busy;
  elements.resetFolder.disabled = state.busy;
}

function showNotice(message: string, tone: "success" | "warning" | "error") {
  elements.notice.textContent = message;
  elements.notice.className = `notice is-${tone}`;
}

function logEvent(message: string) {
  const row = document.createElement("li");
  row.textContent = `${new Date().toLocaleTimeString()} ${message}`;
  elements.events.prepend(row);
  while (elements.events.children.length > 8) {
    elements.events.lastElementChild?.remove();
  }
}

function formatDuration(seconds: number) {
  const rounded = Math.max(0, Math.round(seconds));
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const secs = rounded % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`
    : `${minutes}:${String(secs).padStart(2, "0")}`;
}
