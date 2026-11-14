# The README tour

`docs/crbro-tour.gif` (and `docs/crbro-tour.mp4`) are drawn by code, so they can be regenerated when a feature changes:

- `tour.html` has a deterministic `render(t)`: each scene is a small function of its local time, the data in it is fictional (`acme`, `billing`), and the wording follows the tools' real output.
- `capture.mjs` opens the page in headless Chrome and saves one PNG per frame (15 fps).

```bash
cd docs/media/tour
npm i --no-save puppeteer-core@23.11.1
node capture.mjs --out frames                  # or --stills 5.5,12.9 to check single frames
ffmpeg -framerate 15 -i frames/f%04d.png -vf "palettegen=max_colors=128:stats_mode=diff" palette.png
ffmpeg -framerate 15 -i frames/f%04d.png -i palette.png -lavfi "paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle" -loop 0 ../../crbro-tour.gif
ffmpeg -framerate 15 -i frames/f%04d.png -c:v libx264 -pix_fmt yuv420p -crf 22 -movflags +faststart ../../crbro-tour.mp4
```

`capture.mjs` expects Chrome at its default Windows path; change `executablePath` on other systems. Keep idle elements still: anything that moves in every frame makes the GIF several times larger.
