# Backup clips

Fallback audio for demo day in case live generation fails or the Space is slow/down.

## How to generate them

1. Go to https://huggingface.co/spaces/ResembleAI/Chatterbox
2. Upload your voice sample, type one of your real pitch lines, click Generate.
3. Download the result (there's a download icon on the audio player).
4. Save it here as `clip1.mp3`, `clip2.mp3`, `clip3.mp3` (add `clip4.mp3` if you want a 4th).

Pick 3-4 lines you're most likely to actually use in the pitch/demo, so the fallback
still sounds relevant if you have to use it live.

`app.js` already looks for these exact filenames — no code changes needed once they're here.
