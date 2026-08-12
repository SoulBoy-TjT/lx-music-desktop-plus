# Song organizer FFmpeg resource

The Windows x64 song organizer uses the pinned BtbN LGPL build below. The binary is fetched at build time, verified, and bundled as an unpacked `extraResource`; it is never downloaded at application runtime.

- Release: `autobuild-2026-08-06-13-39`
- Archive: `ffmpeg-N-125978-g95c43d7df7-win64-lgpl.zip`
- FFmpeg version: `N-125978-g95c43d7df7-20260806`
- FFmpeg commit: `95c43d7df7`
- Archive SHA-256: `79ab2838ff13a71df85ba452d633b964fe5cc681f7eccb1f3e873649974fbe1f`
- `ffmpeg.exe` SHA-256: `e9da9e22d907a996982f18c7ebd7a4b15483d19ca8d581d295b0bd5e08511fec`
- Archive size: `148267877` bytes
- `ffmpeg.exe` size: `115106816` bytes
- Build source: <https://github.com/BtbN/FFmpeg-Builds/tree/2437e7b868da3c11872367b15f3c613b87c24819>
- Corresponding FFmpeg source: <https://github.com/FFmpeg/FFmpeg/tree/95c43d7df7>

The extracted upstream `LICENSE.txt` is bundled beside `ffmpeg.exe`. This build disables GPL-only and nonfree dependencies, including `libx264`, `libx265`, and `libfdk-aac`. The complete configure line is recorded in `docs/progress/PROG-20260807.md`.
