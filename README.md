# Recap Studio AI

**Recap Studio AI** is a full-stack AI movie recap video editing platform built with React, TypeScript, Tailwind CSS, Express/Node.js, FFmpeg/FFprobe, SQLite, and Google Gemini AI (`@google/genai`), with an optional Python FastAPI + OpenCV CSRT vision worker.

## Key Capabilities

1. **Chunked Video Upload & Stream Analysis**
   - Supports `.mp4`, `.mov`, and `.mkv` files up to 2 GB via 5 MB chunked uploads.
   - Extracts real metadata (duration, resolution, FPS, video/audio codecs, bitrate, waveform peaks, and thumbnail) via `ffprobe` and `ffmpeg`.
   - Includes a one-click FFmpeg sample clip synthesizer for immediate pipeline testing.

2. **Automatic AI Captions & Subtitles**
   - Extracts audio with `ffmpeg` and transcribes spoken narration via `gemini-3.5-transcribe` + `gemini-4-hydrogen` word-level & sentence-level alignment.
   - Supports TikTok, YouTube Shorts, Cinematic, and Minimal presets, custom fonts, colors, outlines, shadows, background box opacity, and `.srt` / `.vtt` file export.

3. **9-Language AI Translation**
   - Translates timestamped segments into **English, Arabic, French, Spanish, German, Portuguese, Italian, Turkish, and Hindi** while preserving character names and movie terminology.

4. **AI Voiceover & Audio Mixing**
   - Generates real `.wav` voiceover narration via `gemini-3.8-flash-lite-tts` with Male/Female voice selection, custom style direction, speaking speed (`atempo`), and timeline-aligned `adelay` + `amix` dubbing.
   - Supports preserving/ducking original audio, fade-in/fade-out, and custom background music mixing.

5. **4-Mode Advanced Blur Engine**
   - **Full Video Blur**: Time-windowed Gaussian, Box, or Pixelate blur.
   - **Background Blur**: Foreground segmentation alpha-matte composited via FFmpeg `alphamerge`.
   - **Selective Blur**: Interactive draw-on-video rectangular or elliptical blur zones.
   - **Motion Tracking Blur**: Client-side Normalized Cross-Correlation (NCC) object tracker generating time-varying `(t, x, y, w, h)` keyframes rendered smoothly by FFmpeg.

6. **Logo & Watermark Branding**
   - Upload transparent `.png` or `.svg` logos, drag-and-drop/resize on the player, set opacity, preset positions, and permanent or timed display windows.

7. **Background FFmpeg Export Center**
   - Renders H.264 / AAC `.mp4` in `16:9`, `9:16`, or `1:1` aspect ratios at `480p`, `720p`, or `1080p` with live progress percentage, stage updates, ETA, preview, and download.

## Architecture

- **Frontend**: `src/` (React 19, TypeScript, Tailwind CSS v4, Lucide Icons)
- **Backend Services**: `server.ts` + `server/services/`
  - `video_upload_service.ts`
  - `video_analysis_service.ts`
  - `transcription_service.ts`
  - `translation_service.ts`
  - `voice_generation_service.ts`
  - `blur_processing_service.ts`
  - `logo_overlay_service.ts`
  - `subtitle_service.ts`
  - `audio_processing_service.ts`
  - `video_render_service.ts`
  - `export_service.ts`
- **Database**: SQLite (`db/schema.sql`, `server/db.ts`)
- **Optional Python FastAPI + OpenCV Worker**: `python_backend/main.py`

## Environment Variables

Configure via `.env` or the platform Secrets panel (see `.env.example`):

- `GEMINI_API_KEY`: Required for server-side AI transcription, translation, and TTS voice generation.
- `STORAGE_DIR`: Directory for uploaded media, audio, masks, and exported MP4s (default `./storage`).
- `MAX_UPLOAD_SIZE_MB`: Maximum upload limit in MB (default `2048`).
- `TEMP_RETENTION_HOURS`: Automatic temp file cleanup threshold in hours (default `24`).

## Running Locally

```bash
npm install
npm run dev
```

The server listens on `http://localhost:3000`.
