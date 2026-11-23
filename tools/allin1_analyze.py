#!/usr/bin/env python3
"""
Music-structure analysis with all-in-one (https://github.com/mir-aidj/all-in-one, MIT).

    python tools/allin1_analyze.py <input media> <output json>

Writes: {"analyzer":"allin1","model":..., "duration":..., "bpm":..., "beats":[...], "downbeats":[...],
         "segments":[{"start":..,"end":..,"label":..}, ...]}

Setup (not bundled — install in your own Python env; Linux/WSL2 recommended, Windows needs NATTEN built from source):
    pip install torch            # see pytorch.org for the right build
    # NATTEN: see all-in-one README
    pip install git+https://github.com/CPJKU/madmom
    pip install allin1

The input is first converted to WAV with FFmpeg, as the all-in-one README recommends (MP3 decoding offsets).
Only run this on clip files you are licensed to use.
"""
import json
import os
import subprocess
import sys
import tempfile


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    src, out = sys.argv[1], sys.argv[2]
    try:
        import allin1  # noqa: WPS433
    except ImportError:
        sys.exit("allin1 is not installed in this Python environment (see the header of this script).")

    with tempfile.TemporaryDirectory() as tmp:
        wav = os.path.join(tmp, "audio.wav")
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", src, "-vn", "-ac", "2", "-ar", "44100", wav], check=True)
        result = allin1.analyze(wav)
        if isinstance(result, (list, tuple)):
            result = result[0]
        probe = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", wav],
                               check=True, capture_output=True, text=True)
        data = {
            "analyzer": "allin1",
            "model": getattr(result, "model", None) or "harmonix-all (default)",
            "file": os.path.basename(src),
            "duration": float(probe.stdout.strip() or 0),
            "bpm": float(result.bpm) if result.bpm is not None else None,
            "beats": [float(x) for x in result.beats],
            "downbeats": [float(x) for x in result.downbeats],
            "segments": [{"start": float(s.start), "end": float(s.end), "label": str(s.label)} for s in result.segments],
        }
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    with open(out, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=1)
    print(out)


if __name__ == "__main__":
    main()
