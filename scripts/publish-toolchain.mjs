import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import {
  compareToolchainRevisions,
  parseChannelRecord,
  renderChannelRecord,
} from "./toolchain/channel.mjs";
import { validatePublicationReport } from "./toolchain/validation-report.mjs";

const REVISION_PATTERN = /^[0-9]{8}\.[1-9][0-9]*$/u;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export function createPublicationPlan(input) {
  if (!input || typeof input !== "object") throw new Error("Publication input is required");
  const repository = requireRepository(input.repository);
  const revision = requireRevision(input.revision);
  const commitSha = requireCommit(input.commitSha, "Publication commit");
  validateMergedPullRequest(input.mergedPullRequest, commitSha);
  const release = requireStableRelease(input.release);
  const applicationRelease = requireApplicationRelease(input.applicationRelease);

  const lock = requireLockDescriptor(input.lock);
  if (lock.value?.revision !== revision) throw new Error("Toolchain lock revision does not match");
  const manifestName = `tools-manifest-${revision}.json`;
  const manifest = requireArtifactDescriptor(input.manifest, "Toolchain manifest", manifestName);
  if (manifest.value?.revision !== revision) {
    throw new Error("Toolchain manifest revision does not match");
  }
  const validationName = `toolchain-validation-${revision}.json`;
  const validation = requireArtifactDescriptor(
    input.validation,
    "Toolchain validation",
    validationName,
  );
  if (validation.report?.commitSha !== commitSha) {
    throw new Error("Toolchain validation commit does not match publication commit");
  }
  validatePublicationReport(validation.report, {
    revision,
    commitSha,
    manifestSha256: manifest.sha256,
    lockSha256: lock.sha256,
  });

  const currentChannel = input.currentChannel ?? channelFromReleaseBody(release?.body ?? "");
  if (
    currentChannel &&
    compareToolchainRevisions(revision, currentChannel.revision) <= 0
  ) {
    throw new Error(
      `Toolchain revision ${revision} must be newer than the promoted revision ${currentChannel.revision}`,
    );
  }

  const releaseAssets = release?.assets ?? [];
  const steps = [];
  const ffmpegSource = lock.value.sources?.find((source) => source.id === "ffmpeg-windows");
  const mirrorEligible = ffmpegSource?.redistribution?.mirrorEligible === true;
  if (mirrorEligible) {
    const mirror = requireMirrorCandidate(input.mirrorCandidate, revision, ffmpegSource);
    requireRuntimeMirrorUrl(manifest.value, repository, revision, ffmpegSource, mirror.name);
    steps.push({
      kind: "upload-ffmpeg",
      action: existingAssetAction(releaseAssets, mirror),
      asset: publicAsset(mirror),
    });
    steps.push({ kind: "verify-ffmpeg", asset: publicAsset(mirror) });
    const provenance = {
      name: mirror.provenanceName,
      sha256: mirror.provenanceSha256,
      size: mirror.provenanceSize,
    };
    steps.push({
      kind: "upload-provenance",
      action: existingAssetAction(releaseAssets, provenance),
      asset: provenance,
    });
  } else {
    requireRuntimeUpstreamUrl(manifest.value, ffmpegSource);
  }

  steps.push({
    kind: "upload-manifest",
    action: existingAssetAction(releaseAssets, manifest),
    asset: publicAsset(manifest),
  });
  steps.push({
    kind: "upload-validation",
    action: existingAssetAction(releaseAssets, validation),
    asset: publicAsset(validation),
  });

  const channel = {
    schemaVersion: 1,
    revision,
    manifest: manifest.name,
    sha256: manifest.sha256,
  };
  const releaseBody = release?.body ?? "# Stable toolchain\n\nManaged by automation\n";
  steps.push({
    kind: "promote-channel",
    channel,
    releaseBody: renderChannelRecord(releaseBody, channel),
  });
  steps.push({
    kind: "update-application-compatibility-manifest",
    releaseId: applicationRelease.id,
    releaseTag: applicationRelease.tag_name,
    asset: { ...publicAsset(manifest), name: "tools-manifest.json" },
  });

  return {
    schemaVersion: 1,
    repository,
    revision,
    commitSha,
    pullRequest: input.mergedPullRequest.number,
    createRelease: release == null,
    steps,
  };
}

export function verifyUploadedAsset(asset, expected) {
  if (!asset || typeof asset !== "object") throw new Error("Uploaded asset is missing");
  const normalizedExpected = requireArtifactDescriptor(expected, "Expected asset");
  if (asset.name !== normalizedExpected.name) {
    throw new Error(`Uploaded asset name does not match: ${asset.name}`);
  }
  if (asset.size !== normalizedExpected.size) {
    throw new Error(`Uploaded asset size does not match for ${normalizedExpected.name}`);
  }
  const digest = asset.sha256 ?? String(asset.digest ?? "").replace(/^sha256:/u, "");
  if (digest !== normalizedExpected.sha256) {
    throw new Error(`Uploaded asset digest does not match for ${normalizedExpected.name}`);
  }
  let downloadUrl;
  try {
    downloadUrl = new URL(asset.browser_download_url);
  } catch {
    throw new Error(`Uploaded asset has no valid download URL: ${normalizedExpected.name}`);
  }
  if (downloadUrl.protocol !== "https:" || downloadUrl.username || downloadUrl.password) {
    throw new Error(`Uploaded asset download URL must use HTTPS: ${normalizedExpected.name}`);
  }
}

function requireMirrorCandidate(candidate, revision, ffmpegSource) {
  if (!candidate || typeof candidate !== "object") {
    throw new Error("Mirror-eligible FFmpeg requires a validated mirror candidate");
  }
  const template = ffmpegSource.redistribution.mirrorNameTemplate;
  const expectedName = String(template).replace("{revision}", revision);
  const asset = ffmpegSource.assets?.find((item) => item.target === "win-x64");
  const mirror = requireArtifactDescriptor(candidate, "FFmpeg mirror", expectedName);
  if (!asset || mirror.sha256 !== asset.sha256 || mirror.size !== asset.size) {
    throw new Error("FFmpeg mirror candidate does not match the locked upstream asset");
  }
  const expectedProvenanceName = `ffmpeg-provenance-${revision}.json`;
  if (candidate.provenanceName !== expectedProvenanceName) {
    throw new Error("FFmpeg provenance asset name does not match the revision");
  }
  requireSha256(candidate.provenanceSha256, "FFmpeg provenance SHA-256");
  requirePositiveSize(candidate.provenanceSize, "FFmpeg provenance size");
  const provenance = candidate.provenance;
  if (
    provenance?.schemaVersion !== 1 ||
    provenance.revision !== revision ||
    provenance.binary?.sha256 !== asset.sha256 ||
    provenance.mirrorName !== mirror.name
  ) {
    throw new Error("FFmpeg provenance content does not match the mirror candidate");
  }
  return {
    ...mirror,
    provenanceName: candidate.provenanceName,
    provenanceSha256: candidate.provenanceSha256,
    provenanceSize: candidate.provenanceSize,
  };
}

function requireRuntimeMirrorUrl(manifest, repository, revision, source, mirrorName) {
  const releaseTag = "toolchain-stable";
  const expected = `https://github.com/${repository}/releases/download/${releaseTag}/${mirrorName}`;
  const tools = manifestTools(manifest, "win-x64", ["ffmpeg", "ffprobe"]);
  if (tools.some((tool) => tool.sourceUrl !== expected)) {
    throw new Error(`Runtime FFmpeg manifest must use the project mirror for ${revision}`);
  }
  if (source.assets?.[0]?.sourceUrl === expected) {
    throw new Error("FFmpeg lock must retain the immutable upstream URL");
  }
}

function requireRuntimeUpstreamUrl(manifest, source) {
  if (!source) return;
  const expected = source.assets?.[0]?.sourceUrl;
  const tools = manifestTools(manifest, "win-x64", ["ffmpeg", "ffprobe"]);
  if (tools.some((tool) => tool.sourceUrl !== expected)) {
    throw new Error("Ineligible FFmpeg mirror must retain the upstream runtime URL");
  }
}

function manifestTools(manifest, targetName, names) {
  const target = manifest?.targets?.find((item) => item.target === targetName);
  const tools = target?.tools?.filter((tool) => names.includes(tool.name)) ?? [];
  if (tools.length !== names.length) {
    throw new Error(`Runtime manifest is missing ${targetName} FFmpeg tools`);
  }
  return tools;
}

function existingAssetAction(releaseAssets, expected) {
  const matches = releaseAssets.filter((asset) => asset?.name === expected.name);
  if (matches.length > 1) throw new Error(`Release has duplicate asset ${expected.name}`);
  if (matches.length === 0) return "upload";
  verifyUploadedAsset(matches[0], expected);
  return "reuse";
}

function channelFromReleaseBody(body) {
  if (!body.includes("<!-- toolchain-channel")) return null;
  return parseChannelRecord(body);
}

function validateMergedPullRequest(pullRequest, commitSha) {
  if (
    !pullRequest ||
    pullRequest.merged !== true ||
    !Number.isSafeInteger(pullRequest.number) ||
    pullRequest.number <= 0 ||
    pullRequest.mergeCommitSha !== commitSha
  ) {
    throw new Error("Publication requires an associated merged pull request for exact main");
  }
}

function requireStableRelease(value) {
  if (value == null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Stable release is invalid");
  }
  if (value.tag_name !== "toolchain-stable") {
    throw new Error("Stable release tag must be toolchain-stable");
  }
  if (value.prerelease !== true) throw new Error("Stable release must be a prerelease");
  if (value.draft !== false) throw new Error("Stable release must be published");
  if (!Number.isSafeInteger(value.id) || value.id <= 0) {
    throw new Error("Stable release ID is invalid");
  }
  if (typeof value.body !== "string") throw new Error("Stable release body is invalid");
  if (!Array.isArray(value.assets)) throw new Error("Stable release assets are invalid");
  return value;
}

function requireApplicationRelease(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Application release is required");
  }
  if (value.prerelease !== false || value.draft !== false) {
    throw new Error("Application release must be a published normal release");
  }
  if (!Number.isSafeInteger(value.id) || value.id <= 0) {
    throw new Error("Application release ID is invalid");
  }
  requireString(value.tag_name, "Application release tag");
  return value;
}

function requireArtifactDescriptor(value, label, expectedName) {
  if (!value || typeof value !== "object") throw new Error(`${label} is missing`);
  const name = requireString(value.name, `${label} name`);
  if (expectedName && name !== expectedName) throw new Error(`${label} name must be ${expectedName}`);
  return {
    ...value,
    name,
    sha256: requireSha256(value.sha256, `${label} SHA-256`),
    size: requirePositiveSize(value.size, `${label} size`),
  };
}

function requireLockDescriptor(value) {
  if (!value || typeof value !== "object") throw new Error("Toolchain lock is missing");
  if (!value.value || typeof value.value !== "object") {
    throw new Error("Toolchain lock content is missing");
  }
  return {
    ...value,
    sha256: requireSha256(value.sha256, "Toolchain lock SHA-256"),
  };
}

function publicAsset(value) {
  return { name: value.name, sha256: value.sha256, size: value.size };
}

function requireRepository(value) {
  const repository = requireString(value, "Publication repository");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
    throw new Error("Publication repository is invalid");
  }
  return repository;
}

function requireRevision(value) {
  if (!REVISION_PATTERN.test(value ?? "")) throw new Error(`Invalid revision: ${value}`);
  return value;
}

function requireCommit(value, label) {
  if (!COMMIT_PATTERN.test(value ?? "")) throw new Error(`${label} SHA is invalid`);
  return value;
}

function requireSha256(value, label) {
  if (!SHA256_PATTERN.test(value ?? "")) throw new Error(`${label} is invalid`);
  return value;
}

function requirePositiveSize(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} is invalid`);
  return value;
}

function requireString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function parseCliArguments(argumentsList) {
  const values = new Map();
  for (let index = 0; index < argumentsList.length; index += 2) {
    const flag = argumentsList[index];
    const value = argumentsList[index + 1];
    if (!["--input", "--output"].includes(flag) || value === undefined) {
      throw new Error(`Invalid publication argument: ${flag ?? "missing"}`);
    }
    values.set(flag, value);
  }
  if (!values.has("--input") || !values.has("--output")) {
    throw new Error("--input and --output are required");
  }
  return { input: values.get("--input"), output: values.get("--output") };
}

function isDirectExecution() {
  return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isDirectExecution()) {
  try {
    const cli = parseCliArguments(process.argv.slice(2));
    const input = JSON.parse(await readFile(cli.input, "utf8"));
    const plan = createPublicationPlan(input);
    await writeFile(cli.output, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify({ revision: plan.revision, steps: plan.steps.length })}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
