# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository layout

The actual application lives in `app/`. The repository root mainly contains documentation and sample media.

## Development commands

Run all app commands from `app/`:

```bash
cd app
npm install
```

### Run in development

```bash
cd app
npm run dev
```

This starts the Electron app through `electron-vite`. In dev, the renderer serves on port `5173`.

### Build

```bash
cd app
npm run build
```

Build output:
- `dist-electron/` for Electron main + preload bundles
- `dist/` for the renderer bundle

### Preview built app

```bash
cd app
npm run start
```

### Package distributables

```bash
cd app
npm run dist
```

Packaged artifacts are written to `app/release/`.

### Unpacked packaging build

```bash
cd app
npm run pack
```

### Manual ASR smoke test

```bash
cd app
node scripts/test-asr.mjs [videoPath] [seconds]
```

This script extracts a short clip, uploads it to OSS, submits a DashScope Paraformer ASR job, and prints recognized sentences.

### Tests and linting

There is currently no automated test runner or lint script configured in `app/package.json`, so there is no supported command for `npm test`, single-test execution, or linting.

## Runtime dependencies and local setup

The app depends on:
- Node 18+
- local `ffmpeg` / `ffprobe`
- DashScope API key
- Aliyun OSS credentials

`electron/services/ffmpeg.ts` resolves binaries from `FFMPEG_PATH` / `FFPROBE_PATH` first, then falls back to the system `PATH`.

User secrets are not read from repo files. They are stored via `electron-store` in the user's app config, managed through the in-app settings modal and `electron/services/config.ts`.

## High-level architecture

This is an Electron desktop app with a strict split between:
- **main process** in `app/electron/`
- **renderer** in `app/src/`
- **preload bridge** in `app/electron/preload.ts`

`app/electron.vite.config.ts` builds those three targets separately and defines the path aliases:
- `@main/*` → `app/electron/*`
- `@renderer/*` → `app/src/*`

### Main-process responsibilities

`app/electron/main.ts` owns application startup, window creation, and a custom `app-media://` protocol.

That protocol is important: local media is not loaded with raw `file://` URLs. Instead, the main process streams files through `app-media://local/...` with explicit `Range` support so Chromium video seeking works correctly.

### Preload and IPC boundary

`app/electron/preload.ts` exposes a single `window.api` surface to the renderer through `contextBridge`.

The renderer does not directly touch Node APIs. All filesystem, FFmpeg, OSS, ASR, subtitle IO, config, and word-book operations go through IPC handlers registered in `app/electron/ipc/register.ts`.

When changing capabilities, keep these three layers aligned:
1. Electron service implementation
2. IPC handler name and payload shape
3. `window.api` method exposed from preload

### Pipeline model

The app is organized around a resumable per-video pipeline:
1. split audio locally with FFmpeg
2. upload segments to OSS
3. run DashScope Paraformer ASR
4. optionally translate subtitles with `qwen-turbo`

This orchestration lives in `app/electron/ipc/register.ts`. The renderer mostly triggers steps and reflects state; the main process owns the actual work.

A "one-click" flow in `app/src/App.tsx` chains those steps and skips already completed ones by reloading saved state.

### Persistence model around each video

The app writes sidecar artifacts next to the source video rather than inside the repo:
- `.<video>.segments/` — temporary WAV chunks for ASR
- `.<video>.state.json` — resumable pipeline state
- `<video>.srt` — ASR output
- `<video>.bilingual.srt` — translated output
- `<video>.words.json` — word-level timing sidecar for karaoke highlighting

`app/electron/services/state.ts` fingerprints the source video with file size and mtime before restoring state, so stale state is ignored if the underlying video changed.

### Service-layer responsibilities

The main-process services are intentionally separated by external system or artifact type:
- `ffmpeg.ts` — duration probing, silence detection, audio extraction, time-based video splitting
- `oss.ts` — upload + signed URLs
- `asr.ts` — DashScope Paraformer async task submission and polling
- `subtitle.ts` — SRT parsing/writing, translation batching, words sidecar merge
- `state.ts` — resumable per-video pipeline state
- `config.ts` — persisted app credentials and defaults
- `db.ts` — SQLite-backed word book

`subtitle.ts` is a key integration point: SRT cannot carry word timestamps, so karaoke timing is persisted separately in `.words.json` and merged back when loading subtitles.

### Renderer state and playback architecture

`app/src/store/player.ts` is the main Zustand store for app state: current video, cues, pipeline step state, uploaded segments, loop mode, subtitle visibility, and worker/progress panels.

`app/src/App.tsx` is the orchestration UI. It wires toolbar actions to `window.api`, restores saved pipeline state when a video is opened, and updates the Zustand store from IPC progress events.

Playback timing is handled outside normal React render flow:
- `Player.tsx` drives a global playback clock from `requestAnimationFrame`
- `hooks/videoTime.ts` broadcasts the current playback time
- subtitle overlay components subscribe to that clock and update DOM directly for karaoke progress

That design is deliberate: high-frequency subtitle highlighting avoids whole-tree React re-renders.

### Concurrency model

Long-running work is concurrent in the main process:
- upload concurrency defaults to 3
- ASR concurrency is configurable and the UI currently requests 6
- translation batches are processed concurrently, defaulting to 3

Worker-level progress is emitted from the main process over IPC (`pipeline:worker` and related events) and rendered in the progress panel.

## Product-specific behavior worth preserving

- ASR uses DashScope `paraformer-v2` and preserves word-level timings when available.
- Translation uses `qwen-turbo` in batches of 40 subtitle cues.
- The app prefers silence-aware audio segmentation before ASR instead of hard fixed cuts.
- The custom media protocol is load-bearing; avoid replacing it with `file://` access.
- Existing subtitle loading prefers saved pipeline state, then `.bilingual.srt`, then `.srt`.

## Files to read first for changes

If you need to understand or modify end-to-end behavior, start with:
- `app/src/App.tsx`
- `app/src/store/player.ts`
- `app/electron/preload.ts`
- `app/electron/ipc/register.ts`
- `app/electron/services/ffmpeg.ts`
- `app/electron/services/subtitle.ts`
- `app/electron/main.ts`
