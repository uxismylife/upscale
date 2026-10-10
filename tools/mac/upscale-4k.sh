#!/bin/zsh
# Upscale an image to 4K with Real-ESRGAN (AI) on the Mac's GPU.
#
#   ./upscale-4k.sh photo.jpg            → photo-4k.png (long side 3840 px)
#   ./upscale-4k.sh art.png anime        → uses the illustration/anime model
#   SIZE=4096 ./upscale-4k.sh photo.jpg  → DCI 4K instead of UHD
#
# Models: photo (realesrgan-x4plus, default) · anime (realesrgan-x4plus-anime)

set -e
HERE=${0:A:h}
IN=${1:?usage: upscale-4k.sh <image> [photo|anime]}
case "${2:-photo}" in
  photo) MODEL=realesrgan-x4plus ;;
  anime) MODEL=realesrgan-x4plus-anime ;;
  art)   MODEL=digital-art-4x ;;  # best of the free models on 3D/cartoon characters
  *)     MODEL=$2 ;;  # any model in ./models, e.g. digital-art-4x, ultrasharp-4x
esac
[[ -f "$HERE/models/$MODEL.param" ]] || { echo "No model named $MODEL in $HERE/models"; exit 1; }
SIZE=${SIZE:-3840}

[[ -f "$IN" ]] || { echo "Can't find $IN"; exit 1; }
IN=${IN:A}
OUT="${IN:r}-4k.png"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

long_side() {
  local w h
  w=$(sips -g pixelWidth "$1" | awk '/pixelWidth/{print $2}')
  h=$(sips -g pixelHeight "$1" | awk '/pixelHeight/{print $2}')
  (( w > h )) && echo $w || echo $h
}

# Real-ESRGAN reads PNG/JPG/WebP; convert anything else (HEIC, TIFF…) to PNG first.
case "${IN:e:l}" in
  png|jpg|jpeg|webp) SRC="$IN" ;;
  *) SRC="$TMP/src.png"; sips -s format png "$IN" --out "$SRC" >/dev/null ;;
esac

L=$(long_side "$SRC")
echo "Source long side: ${L}px → target ${SIZE}px"

# Pass 1: AI ×4
"$HERE/realesrgan-ncnn-vulkan" -i "$SRC" -o "$TMP/pass1.png" -n $MODEL -m "$HERE/models" >/dev/null 2>&1
CUR="$TMP/pass1.png"

# Pass 2: another AI ×4 only when ×4 is still well short of 4K (very small sources)
if (( $(long_side "$CUR") * 3 < SIZE * 2 )); then
  echo "Source is tiny; running a second AI pass"
  "$HERE/realesrgan-ncnn-vulkan" -i "$CUR" -o "$TMP/pass2.png" -n $MODEL -m "$HERE/models" >/dev/null 2>&1
  CUR="$TMP/pass2.png"
fi

# Final fit to exactly SIZE on the long side
sips -s format png --resampleHeightWidthMax $SIZE "$CUR" --out "$OUT" >/dev/null
echo "Saved $OUT ($(sips -g pixelWidth "$OUT" | awk '/pixelWidth/{print $2}') × $(sips -g pixelHeight "$OUT" | awk '/pixelHeight/{print $2}'))"
