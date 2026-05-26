# Bundled tools

Large Windows tool binaries are not committed to Git because GitHub rejects files over 100 MB.

Restore them from the Tauri project root with:

```powershell
.\scripts\download-tools.ps1
```

The expected layout and hashes are documented in `src-tauri/tools-manifest.json`.
