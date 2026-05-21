#!/usr/bin/env python3
import argparse
import os
import struct
import subprocess
import tempfile

import numpy as np

# HHT v1
MAGIC = b"HHT1"
VERSION = 1
FLAGS = 0
RESERVED = 0
TIMEBASE_HZ = 1000  # timestamps in ms
KIND_VIBRATE = 0


def run_ffmpeg_to_wav(in_path: str, out_wav: str, sr: int = 22050):
    # mono, 16-bit PCM wav
    cmd = [
        "ffmpeg", "-y",
        "-i", in_path,
        "-ac", "1",
        "-ar", str(sr),
        "-f", "wav",
        out_wav,
    ]
    subprocess.check_call(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def read_wav_mono_16bit(path: str):
    import wave
    with wave.open(path, "rb") as wf:
        nch = wf.getnchannels()
        sampwidth = wf.getsampwidth()
        sr = wf.getframerate()
        nframes = wf.getnframes()
        if nch != 1 or sampwidth != 2:
            raise ValueError("Expected mono PCM16 wav")
        raw = wf.readframes(nframes)
    x = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    return x, sr


def band_energy_envelope(x: np.ndarray, sr: int, f_lo=80.0, f_hi=120.0, win_ms=20, hop_ms=10):
    """
    Lightweight envelope extractor:
    - Frame the signal
    - FFT each frame
    - Average power in 80-120Hz band
    """
    win = max(64, int(sr * win_ms / 1000))
    hop = max(16, int(sr * hop_ms / 1000))

    w = np.hanning(win).astype(np.float32)
    freqs = np.fft.rfftfreq(win, d=1.0 / sr)
    band = (freqs >= f_lo) & (freqs <= f_hi)

    env = []
    times_ms = []
    for start in range(0, len(x) - win, hop):
        frame = x[start:start + win] * w
        spec = np.fft.rfft(frame)
        mag2 = (spec.real * spec.real + spec.imag * spec.imag)
        e = float(np.mean(mag2[band])) if np.any(band) else 0.0
        env.append(e)
        times_ms.append((start / sr) * 1000.0)

    env = np.array(env, dtype=np.float32)
    times_ms = np.array(times_ms, dtype=np.float32)

    # smooth a bit to reduce jitter
    if len(env) >= 5:
        k = 5
        kernel = np.ones(k, dtype=np.float32) / k
        env = np.convolve(env, kernel, mode="same")

    # normalize (robust)
    p95 = np.percentile(env, 95) if len(env) else 1.0
    if p95 <= 1e-9:
        p95 = 1.0
    env_n = np.clip(env / p95, 0.0, 1.0)

    return times_ms, env_n, hop_ms


def envelope_to_pulses(times_ms: np.ndarray, env: np.ndarray):
    """
    Convert envelope -> sparse pulse events to avoid "always-on" buzz.
    """
    events = []
    if len(env) == 0:
        return events

    base_thr = 0.18
    min_gap_ms = 40
    last_t = -1e9

    gamma = 1.6  # >1 suppresses low-level constant rumble

    for t, a in zip(times_ms, env):
        if a < base_thr:
            continue

        strength = float(a) ** gamma
        intensity = int(np.clip(strength * 255.0, 0, 255))

        # short-ish duration (stronger => a bit longer)
        d = int(np.clip(18 + strength * 45, 18, 70))

        if t - last_t < min_gap_ms:
            continue

        events.append((int(round(t)), d, intensity, KIND_VIBRATE))
        last_t = t

    return events


def write_hht(path: str, events):
    os.makedirs(os.path.dirname(path), exist_ok=True)

    header = struct.pack(
        "<4sBBHII",
        MAGIC,
        VERSION,
        FLAGS,
        RESERVED,
        TIMEBASE_HZ,
        len(events),
    )

    with open(path, "wb") as f:
        f.write(header)
        for (t, d, i, kind) in events:
            # event = u32 t, u16 d, u8 i, u8 kind
            f.write(struct.pack("<IHBb", int(t), int(d), int(i), int(kind)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input-dir", required=True)
    ap.add_argument("--output-dir", required=True)
    args = ap.parse_args()

    for root, _, files in os.walk(args.input_dir):
        for fn in files:
            if not fn.lower().endswith(".m4a"):
                continue

            in_path = os.path.join(root, fn)
            base = os.path.splitext(os.path.basename(fn))[0]
            out_path = os.path.join(args.output_dir, base + ".hht")

            with tempfile.TemporaryDirectory() as td:
                wav_path = os.path.join(td, base + ".wav")
                run_ffmpeg_to_wav(in_path, wav_path, sr=22050)
                x, sr = read_wav_mono_16bit(wav_path)

            times_ms, env, _ = band_energy_envelope(x, sr)
            events = envelope_to_pulses(times_ms, env)
            write_hht(out_path, events)
            print(f"wrote {out_path} ({len(events)} events)")


if __name__ == "__main__":
    main()
