#!/usr/bin/env bash
# relief_check -- compare the GPU port of Sprite Normals (platform/render/
# relief_glsl.h) with the crate's own CLI, sprite by sprite.
#
#   SPRITE_NORMALS=/path/to/spritefusion-sprite-normals tools/relief_check/run.sh
#
# Makes four test sprites with ImageMagick (hard alpha, as the GBA's), runs the
# CLI on them, extracts the port's shaders from the C sources, and stages the
# page in build/relief_check.  Serve that directory over HTTP and open
# index.html in a WebGL2 browser: it runs the five passes on each sprite and
# prints the largest per-channel difference from the CLI's map (expect 1/255,
# from half-float rounding), with the crate's defaults (the background
# layers' settings) and with --detail-strength 2 (the sprites').  No game data
# is involved.  tune.html, staged alongside, compares lighting settings on
# sprites you capture yourself (see its header).
set -euo pipefail
cd "$(dirname "$0")/../.."
CLI=${SPRITE_NORMALS:-spritefusion-sprite-normals}
OUT=build/relief_check
mkdir -p "$OUT"
cp tools/relief_check/index.html tools/relief_check/tune.html tools/relief_check/tune_variants.json "$OUT"/
python3 -I tools/relief_check/extract_glsl.py . > "$OUT"/glsl.js
cd "$OUT"
magick -size 20x20 xc:none -fill white -draw "circle 9.5,9.5 9.5,0.5" \
    \( -size 20x20 radial-gradient:"#ffd0e0"-"#a02050" \) -compose SrcIn -composite blob20.png
magick -size 36x28 xc:none -fill white -draw "roundrectangle 1,2 34,25 6,6" \
    \( -seed 3 -size 36x28 plasma:fractal -colors 8 \) -compose SrcIn -composite rock36.png
magick -size 48x48 xc:none -fill white -draw "circle 23.5,23.5 23.5,1" \
    \( -size 48x48 gradient:"#90e0ff"-"#203080" \) -compose SrcIn -composite big48.png
magick -size 30x18 xc:none -fill "#c08040" -draw "rectangle 0,4 29,13" \
    -fill "#603010" -draw "line 0,8 29,8" -fill "#f0c080" -draw "rectangle 3,1 8,16" twoparts.png
for f in blob20 rock36 big48 twoparts; do
    magick $f.png -channel A -threshold 50% +channel -depth 8 PNG32:$f.png
    "$CLI" $f.png -o ${f}_n.png --force >/dev/null
    "$CLI" $f.png -o ${f}_n_d2.png --detail-strength 2 --force >/dev/null
done
echo "  staged $OUT -- e.g. python3 -m http.server -d $OUT, then open index.html"
