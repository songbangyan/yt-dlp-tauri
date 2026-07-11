use super::{
    install::verify_sha256, relative_manifest_tool_path, ManifestTarget, ManifestTool, ToolPaths,
    ToolStatus,
};
use std::{ffi::OsStr, path::Path, process::Command};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

pub fn probe_target(paths: &ToolPaths, target: &ManifestTarget) -> Result<Vec<ToolStatus>, String> {
    target
        .tools
        .iter()
        .map(|tool| probe_manifest_tool(&paths.root, tool))
        .collect()
}

pub fn require_tools(tools: &ToolPaths) -> Result<(), String> {
    for path in [&tools.yt_dlp, &tools.ffmpeg, &tools.ffprobe, &tools.deno] {
        if !path.exists() {
            return Err(format!("Missing bundled tool: {}", path.display()));
        }
    }
    Ok(())
}

fn probe_manifest_tool(root: &Path, tool: &ManifestTool) -> Result<ToolStatus, String> {
    let relative_path = relative_manifest_tool_path(tool)?;
    let full_path = root.join(relative_path);
    let mut status = probe_tool(
        &tool.name,
        &tool.path,
        &full_path,
        tool_version_args(&tool.name),
    );
    status.expected_version = tool.version.clone();

    if status.availability == "available" {
        let hash_matches = verify_sha256(&full_path, &tool.sha256).is_ok();
        status.availability = availability_for_manifest_probe(&status.availability, hash_matches);
        if !hash_matches {
            status.error = Some("Installed tool does not match the pinned manifest".to_string());
        }
    }
    Ok(status)
}

fn tool_version_args(name: &str) -> &'static [&'static str] {
    match name {
        "ffmpeg" | "ffprobe" => &["-version"],
        _ => &["--version"],
    }
}

fn availability_for_manifest_probe(availability: &str, sha_matches: bool) -> String {
    if availability == "available" && !sha_matches {
        "outdated".to_string()
    } else {
        availability.to_string()
    }
}

fn probe_tool(
    name: &str,
    relative_path: &str,
    full_path: &Path,
    version_args: &[&str],
) -> ToolStatus {
    if !full_path.exists() {
        return ToolStatus {
            name: name.to_string(),
            relative_path: relative_path.to_string(),
            full_path: full_path.display().to_string(),
            availability: "missing".to_string(),
            version: None,
            expected_version: None,
            error: Some("Bundled tool file is missing".to_string()),
        };
    }

    let mut command = background_command(full_path);
    match command.args(version_args).output() {
        Ok(output) if output.status.success() => ToolStatus {
            name: name.to_string(),
            relative_path: relative_path.to_string(),
            full_path: full_path.display().to_string(),
            availability: "available".to_string(),
            version: first_line(&output.stdout),
            expected_version: None,
            error: None,
        },
        Ok(output) => ToolStatus {
            name: name.to_string(),
            relative_path: relative_path.to_string(),
            full_path: full_path.display().to_string(),
            availability: "cannot_execute".to_string(),
            version: None,
            expected_version: None,
            error: Some(process_failure_message(
                &format!(
                    "{name} at {} failed to report a version",
                    full_path.display()
                ),
                output.status.code(),
                &output.stderr,
                &output.stdout,
            )),
        },
        Err(error) => ToolStatus {
            name: name.to_string(),
            relative_path: relative_path.to_string(),
            full_path: full_path.display().to_string(),
            availability: "cannot_execute".to_string(),
            version: None,
            expected_version: None,
            error: Some(format!(
                "Failed to run {name} at {}: {error}",
                full_path.display()
            )),
        },
    }
}

fn background_command(program: impl AsRef<OsStr>) -> Command {
    #[allow(unused_mut)]
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

fn first_line(bytes: &[u8]) -> Option<String> {
    String::from_utf8_lossy(bytes)
        .lines()
        .find(|line| !line.trim().is_empty())
        .map(|line| line.trim().to_string())
}

fn process_failure_message(
    context: &str,
    exit_code: Option<i32>,
    stderr: &[u8],
    stdout: &[u8],
) -> String {
    let detail = first_line(stderr).or_else(|| first_line(stdout));
    match detail {
        Some(detail) => format!("{context} Exit code {}: {detail}", exit_code.unwrap_or(-1)),
        None => format!("{context} Exit code {}", exit_code.unwrap_or(-1)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn marks_available_tool_outdated_when_manifest_hash_mismatches() {
        assert_eq!(
            availability_for_manifest_probe("available", true),
            "available"
        );
        assert_eq!(
            availability_for_manifest_probe("available", false),
            "outdated"
        );
        assert_eq!(availability_for_manifest_probe("missing", false), "missing");
        assert_eq!(
            availability_for_manifest_probe("cannot_execute", false),
            "cannot_execute"
        );
    }
}
