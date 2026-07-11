import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  nextRevision,
  resolveToolchainLock,
} from "../scripts/toolchain/resolve-lock.mjs";

const currentLock = JSON.parse(
  readFileSync("tests/fixtures/toolchain/current-lock.json", "utf8"),
);

const urls = {
  ytDlp:
    "https://github.com/yt-dlp/yt-dlp/releases/download/2026.07.04/yt-dlp.exe",
  ffmpegWindows:
    "https://github.com/yt-dlp/FFmpeg-Builds/releases/download/autobuild-2026-06-30-16-38/ffmpeg-N-125200-gabcdef1234-win64-gpl.zip",
  ffmpegMac:
    "https://ffmpeg.martin-riedl.de/download/macos/arm64/1783011502_8.1.2/ffmpeg.zip",
  ffprobeMac:
    "https://ffmpeg.martin-riedl.de/download/macos/arm64/1783011502_8.1.2/ffprobe.zip",
};

function fixturePolicy() {
  return {
    schemaVersion: 1,
    targets: ["win-x64", "macos-arm64"],
    approvedHosts: ["github.com", "ffmpeg.martin-riedl.de"],
    sources: [
      {
        id: "yt-dlp",
        adapter: "github-release",
        selection: "latest-stable",
        repository: "yt-dlp/yt-dlp",
        assets: [
          {
            target: "win-x64",
            assetName: "yt-dlp.exe",
            kind: "file",
            members: [
              {
                tool: "yt-dlp",
                path: "Tools/win-x64/yt-dlp/yt-dlp.exe",
                licenseNotes: "yt-dlp test license",
              },
            ],
          },
        ],
      },
      {
        id: "ffmpeg-windows",
        adapter: "github-release",
        selection: "previous-complete-month",
        repository: "yt-dlp/FFmpeg-Builds",
        assets: [
          {
            target: "win-x64",
            assetPattern: "^ffmpeg-N-[0-9]+-g[a-f0-9]+-win64-gpl\\.zip$",
            kind: "zip",
            members: [
              {
                tool: "ffprobe",
                path: "Tools/win-x64/ffmpeg/bin/ffprobe.exe",
                archivePathSuffix: "bin/ffprobe.exe",
                licenseNotes: "Windows FFprobe test license",
              },
              {
                tool: "ffmpeg",
                path: "Tools/win-x64/ffmpeg/bin/ffmpeg.exe",
                archivePathSuffix: "bin/ffmpeg.exe",
                licenseNotes: "Windows FFmpeg test license",
              },
            ],
          },
        ],
      },
      {
        id: "ffmpeg-macos-arm64",
        adapter: "redirect-release",
        selection: "latest-redirect",
        assets: [
          {
            target: "macos-arm64",
            url: "https://ffmpeg.martin-riedl.de/redirect/latest/macos/arm64/release/ffprobe.zip",
            kind: "zip",
            members: [
              {
                tool: "ffprobe",
                path: "Tools/macos-arm64/ffmpeg/bin/ffprobe",
                archivePathSuffix: "ffprobe",
                licenseNotes: "macOS FFprobe test license",
              },
            ],
          },
          {
            target: "macos-arm64",
            url: "https://ffmpeg.martin-riedl.de/redirect/latest/macos/arm64/release/ffmpeg.zip",
            kind: "zip",
            members: [
              {
                tool: "ffmpeg",
                path: "Tools/macos-arm64/ffmpeg/bin/ffmpeg",
                archivePathSuffix: "ffmpeg",
                licenseNotes: "macOS FFmpeg test license",
              },
            ],
          },
        ],
      },
    ],
  };
}

const releasesByRepository = {
  "yt-dlp/yt-dlp": [
    {
      id: 11,
      tagName: "2026.07.10-rc.1",
      draft: false,
      prerelease: true,
      publishedAt: "2026-07-10T08:05:00Z",
      htmlUrl: "https://github.com/yt-dlp/yt-dlp/releases/tag/2026.07.10-rc.1",
      assets: [],
    },
    {
      id: 10,
      tagName: "2026.07.04",
      draft: false,
      prerelease: false,
      publishedAt: "2026-07-04T10:05:00Z",
      htmlUrl: "https://github.com/yt-dlp/yt-dlp/releases/tag/2026.07.04",
      assets: [
        {
          id: 100,
          name: "yt-dlp.exe",
          url: urls.ytDlp,
          size: 3,
          sha256: "a".repeat(64),
        },
      ],
    },
  ],
  "yt-dlp/FFmpeg-Builds": [
    {
      id: 31,
      tagName: "autobuild-2026-07-01-16-32",
      draft: false,
      prerelease: false,
      publishedAt: "2026-07-01T16:32:48Z",
      htmlUrl:
        "https://github.com/yt-dlp/FFmpeg-Builds/releases/tag/autobuild-2026-07-01-16-32",
      assets: [],
    },
    {
      id: 30,
      tagName: "autobuild-2026-06-30-16-38",
      draft: false,
      prerelease: false,
      publishedAt: "2026-06-30T16:38:32Z",
      htmlUrl:
        "https://github.com/yt-dlp/FFmpeg-Builds/releases/tag/autobuild-2026-06-30-16-38",
      assets: [
        {
          id: 300,
          name: "ffmpeg-N-125200-gabcdef1234-win64-gpl.zip",
          url: urls.ffmpegWindows,
          size: 30,
          sha256: null,
        },
      ],
    },
  ],
};

const inspections = {
  [urls.ytDlp]: {
    size: 3,
    sha256: "a".repeat(64),
    members: [
      {
        tool: "yt-dlp",
        archivePath: null,
        size: 3,
        sha256: "a".repeat(64),
      },
    ],
  },
  [urls.ffmpegWindows]: {
    size: 30,
    sha256: "b".repeat(64),
    members: [
      {
        tool: "ffprobe",
        archivePath: "ffmpeg-build/bin/ffprobe.exe",
        size: 13,
        sha256: "d".repeat(64),
      },
      {
        tool: "ffmpeg",
        archivePath: "ffmpeg-build/bin/ffmpeg.exe",
        size: 12,
        sha256: "c".repeat(64),
      },
    ],
  },
  [urls.ffmpegMac]: {
    size: 10,
    sha256: "e".repeat(64),
    members: [
      { tool: "ffmpeg", archivePath: "ffmpeg", size: 4, sha256: "1".repeat(64) },
    ],
  },
  [urls.ffprobeMac]: {
    size: 11,
    sha256: "f".repeat(64),
    members: [
      { tool: "ffprobe", archivePath: "ffprobe", size: 5, sha256: "2".repeat(64) },
    ],
  },
};

function fixtureOptions(overrides = {}) {
  return {
    policy: fixturePolicy(),
    now: new Date("2026-07-11T12:00:00Z"),
    tempDirectory: "fixture-temp",
    githubAdapter: async (repository) => structuredClone(releasesByRepository[repository]),
    redirectAdapter: async (url) => {
      const name = new URL(url).pathname.endsWith("ffprobe.zip") ? "ffprobe" : "ffmpeg";
      const resolvedUrl = name === "ffprobe" ? urls.ffprobeMac : urls.ffmpegMac;
      return {
        url: resolvedUrl,
        version: "8.1.2",
        checksumUrl: `${resolvedUrl}.sha256`,
      };
    },
    inspectAsset: async ({ url }) => ({
      ...structuredClone(inspections[String(url)]),
      downloadPath: "/tmp/transient-download",
    }),
    ...overrides,
  };
}

test("nextRevision increments revisions generated on the same UTC day", () => {
  assert.equal(
    nextRevision("20260711.1", new Date("2026-07-11T12:00:00Z")),
    "20260711.2",
  );
  assert.equal(
    nextRevision("20260710.7", new Date("2026-07-11T12:00:00Z")),
    "20260711.1",
  );
});

test("resolver groups ffmpeg and ffprobe from one Windows archive", async () => {
  const lock = await resolveToolchainLock(fixtureOptions());
  const source = lock.sources.find((item) => item.id === "ffmpeg-windows");

  assert.deepEqual(lock.targets, ["macos-arm64", "win-x64"]);
  assert.equal(source.assets.length, 1);
  assert.deepEqual(
    source.assets[0].members.map((member) => member.tool),
    ["ffmpeg", "ffprobe"],
  );
  assert.doesNotMatch(JSON.stringify(lock), /transient-download/);
});

test("unchanged resolved sources preserve revision and generation time", async () => {
  const lock = await resolveToolchainLock(fixtureOptions({ currentLock }));

  assert.deepEqual(lock, currentLock);
});

test("a changed executable digest creates a revision for the current UTC day", async () => {
  const inspectAsset = fixtureOptions().inspectAsset;
  const lock = await resolveToolchainLock(
    fixtureOptions({
      currentLock,
      inspectAsset: async (request) => {
        const result = await inspectAsset(request);
        if (String(request.url) === urls.ffmpegWindows) {
          result.members.find((member) => member.tool === "ffprobe").sha256 = "9".repeat(64);
        }
        return result;
      },
    }),
  );

  assert.equal(lock.revision, "20260711.1");
  assert.equal(lock.generatedAtUtc, "2026-07-11T12:00:00.000Z");
});

test("one redirect source cannot combine assets from different releases", async () => {
  const redirectAdapter = fixtureOptions().redirectAdapter;
  await assert.rejects(
    () =>
      resolveToolchainLock(
        fixtureOptions({
          redirectAdapter: async (url, options) => {
            const result = await redirectAdapter(url, options);
            return String(url).endsWith("ffprobe.zip")
              ? { ...result, version: "8.1.3" }
              : result;
          },
        }),
      ),
    /ffmpeg-macos-arm64.*multiple release versions/,
  );
});
