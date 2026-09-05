This directory holds the bundled FFmpeg (LGPL, dynamically linked) that ships
with the Windows installer: ffmpeg.exe, ffprobe.exe and their av*/sw* DLLs.

You may replace them with your own build of FFmpeg - keep ffmpeg and ffprobe
in the same directory. AI Music Cut also prefers any ffmpeg found on your PATH
over this copy, and Settings -> ffmpeg path overrides both.

See THIRD-PARTY-NOTICES.txt for the license and where to get the source.

The binaries themselves are not in version control; CI fetches them with
`node scripts/fetch-ffmpeg.mjs` (pinned URL + sha256) before packaging.
