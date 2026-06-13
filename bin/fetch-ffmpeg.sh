#!/bin/sh
# Download static linux ffmpeg binaries for both Axis architectures:
#   bin/ffmpeg-arm64  — ARTPEC-8/9 (aarch64, e.g. Q1656)
#   bin/ffmpeg-armhf  — ARTPEC-6/7 (armv7 32-bit, e.g. M1137)
# Works with both GNU and BSD (macOS) tar. Run once before zip:package.
set -e
cd "$(dirname "$0")"

fetch() {
    ARCH="$1"; OUT="$2"
    URL="https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-${ARCH}-static.tar.xz"
    echo "Downloading $ARCH ..."
    curl -fL "$URL" -o ff.tar.xz
    rm -rf ff_extract && mkdir ff_extract
    tar -xJf ff.tar.xz -C ff_extract
    FF=$(find ff_extract -type f -name ffmpeg | head -1)
    [ -n "$FF" ] || { echo "ffmpeg not found in $ARCH archive"; exit 1; }
    mv "$FF" "$OUT"
    chmod +x "$OUT"
    rm -rf ff_extract ff.tar.xz
    echo "Done: $(ls -lh "$OUT" | awk '{print $5}') bin/$OUT"
}

fetch arm64 ffmpeg-arm64
fetch armhf ffmpeg-armhf

rm -f ffmpeg   # remove legacy duplicate if present (saves ~78 MB in the zip)
echo "All done. Use 'npm run zip:arm64' / 'npm run zip:armhf' for slim per-camera packages."
