#!/bin/bash
# Glass Home: install whisper.cpp + one speech model for the relay's free, local speech-to-text (STT=whisper / auto).
# Everything goes into ~/.glasshome/whisper.cpp (nothing system-wide, no sudo, no Homebrew).
#   Needs: Xcode Command Line Tools (git, clang, make) and cmake. If cmake is missing, the official Kitware
#   universal .tar.gz (~78 MB download) is unpacked into ~/.glasshome/cmake (no installer, no sudo).
#   Model: ggml-small.bin (~488 MB) on Apple Silicon, ggml-base.bin (~148 MB) on Intel. Override: WHISPER_MODEL_NAME=base|small|medium
# Undo: rm -rf ~/.glasshome/whisper.cpp ~/.glasshome/cmake     (and remove WHISPER_* lines from the relay's .env, if any)
set -euo pipefail
ROOT="${GLASSHOME_DIR:-$HOME/.glasshome}"
DIR="$ROOT/whisper.cpp"
TAG="${WHISPER_TAG:-v1.9.5}"
CMAKE_VER="${CMAKE_VER:-3.31.8}"
ARCH="$(uname -m)"
if [ -z "${WHISPER_MODEL_NAME:-}" ]; then
  if [ "$ARCH" = "arm64" ]; then WHISPER_MODEL_NAME=small; else WHISPER_MODEL_NAME=base; fi
fi
say() { printf '\033[1m%s\033[0m\n' "$*"; }

[ "$(uname -s)" = "Darwin" ] || { echo "This script is for macOS."; exit 1; }
if ! xcode-select -p >/dev/null 2>&1; then
  echo "Xcode Command Line Tools are missing. Run:  xcode-select --install   (Apple dialog, ~1-2 GB), then re-run this script."
  exit 1
fi
mkdir -p "$ROOT"

CMAKE="$(command -v cmake || true)"
if [ -z "$CMAKE" ] && [ -x "$ROOT/cmake/CMake.app/Contents/bin/cmake" ]; then CMAKE="$ROOT/cmake/CMake.app/Contents/bin/cmake"; fi
if [ -z "$CMAKE" ]; then
  say "cmake not found: downloading the official Kitware build $CMAKE_VER (~78 MB) into $ROOT/cmake"
  TGZ="cmake-$CMAKE_VER-macos-universal.tar.gz"
  curl -fL --proto '=https' -o "$ROOT/$TGZ" "https://github.com/Kitware/CMake/releases/download/v$CMAKE_VER/$TGZ"
  curl -fsL --proto '=https' -o "$ROOT/cmake-SHA-256.txt" "https://github.com/Kitware/CMake/releases/download/v$CMAKE_VER/cmake-$CMAKE_VER-SHA-256.txt"
  (cd "$ROOT" && grep " $TGZ\$" cmake-SHA-256.txt | shasum -a 256 -c -)
  mkdir -p "$ROOT/cmake" && tar -xzf "$ROOT/$TGZ" -C "$ROOT/cmake" --strip-components 1
  rm -f "$ROOT/$TGZ" "$ROOT/cmake-SHA-256.txt"
  CMAKE="$ROOT/cmake/CMake.app/Contents/bin/cmake"
fi

if [ ! -d "$DIR/.git" ]; then
  say "Cloning whisper.cpp $TAG (~10 MB download, ~45 MB on disk)"
  git clone --depth 1 --branch "$TAG" https://github.com/ggml-org/whisper.cpp.git "$DIR"
else
  say "whisper.cpp already cloned at $DIR (delete it to reinstall)"
fi
cd "$DIR"
say "Building whisper-cli (Metal on Apple Silicon; 2-5 minutes)"
"$CMAKE" -B build -DCMAKE_BUILD_TYPE=Release -DWHISPER_BUILD_EXAMPLES=ON -DWHISPER_BUILD_TESTS=OFF -DBUILD_SHARED_LIBS=OFF >/dev/null
"$CMAKE" --build build -j --config Release --target whisper-cli
[ -x build/bin/whisper-cli ] || { echo "Build failed: build/bin/whisper-cli missing"; exit 1; }

MODEL="models/ggml-$WHISPER_MODEL_NAME.bin"
if [ ! -s "$MODEL" ]; then
  say "Downloading model ggml-$WHISPER_MODEL_NAME.bin (official ggerganov/whisper.cpp Hugging Face repo)"
  sh ./models/download-ggml-model.sh "$WHISPER_MODEL_NAME"
fi

say "Self-test with the bundled sample (jfk.wav)"
./build/bin/whisper-cli -m "$MODEL" -f samples/jfk.wav -nt -np -l en | head -3

echo
say "Done."
echo "  whisper-cli : $DIR/build/bin/whisper-cli"
echo "  model       : $DIR/$MODEL ($(du -h "$MODEL" | cut -f1))"
echo "The relay finds these automatically (STT=auto picks the installed small, base or medium model)."
echo "Restart the relay to use it. Undo: rm -rf $DIR $ROOT/cmake"
