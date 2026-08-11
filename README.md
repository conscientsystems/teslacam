# TeslaCam

A viewer for Tesla dashcam footage at **teslacam.cscloud.dk**. Point it at your
TeslaCam folder, watch all four cameras in step, and export what you are looking
at as an MP4.

**Nothing is uploaded.** The server hosts one static page. Reading the folder,
decoding the video, pulling the telemetry out of the bitstream and composing the
export all happen in your browser, on your machine. The site has no API, no
database and no idea what you are looking at.

## What the car actually records

```
TeslaCam/
  RecentClips/                       flat, a rolling buffer, no event.json
    2026-08-11_12-36-58-front.mp4
    2026-08-11_12-36-58-back.mp4
    2026-08-11_12-36-58-left_repeater.mp4
    2026-08-11_12-36-58-right_repeater.mp4
  SavedClips/2024-05-04_12-25-52/    one folder per event
    event.json  thumb.png  <one-minute segments>
  SentryClips/2024-05-01_09-58-39/
```

Clips are 1280x960 at 36 fps, about a minute each. A segment can be missing
cameras - one saved event in the reference folder has only the back and the
right repeater - so nothing here assumes four files per timestamp.

## Telemetry

Speed, steering angle, gear, indicators, brake, GPS, heading, acceleration and
the autopilot state are carried in **SEI NAL units inside the H.264 bitstream**.
There is no sidecar file and no metadata track, which is why ffprobe reports a
single video stream and nothing else. Field numbers come from Tesla's own
[`dashcam.proto`](https://github.com/teslamotors/dashcam).

Only firmware **2025.44.25 and newer on HW3+** writes it. A 2024 clip has none,
and the app says so rather than showing an empty gauge.

Three things measured on real clips, each of which contradicted an assumption:

- **Telemetry is not continuous.** It stops when the car does. Across one drive
  the per-clip counts ran 2206, 2167, 2164, 1470, 1461, 2186, 424, then 0 as the
  car parked - and one clip has a single 1064-frame gap, half a minute with no
  data in the middle. Samples are therefore indexed by `frame_seq_no`, not by
  position in the array, and a gap reads as a gap rather than a stale number.
- **Speed is signed.** The most negative sample in the reference folder is
  -2.39 m/s with the gear in reverse and the accelerator at 12%. Not noise.
- **Cameras disagree.** The back camera of one minute carries 1830 samples where
  the front carries 2206.

## Running it

```bash
npm install
npm run dev            # http://localhost:5174
npm test               # 14 assertions against a real TeslaCam folder
TESLACAM_DIR=/path/to/TeslaCam npm test
```

The tests read an actual dashcam folder rather than a fixture. A synthetic SEI
packet would only prove the decoder agrees with itself; these assert on physics
and geography - a car in Denmark at a plausible speed, with a frame counter that
only goes forward.

## Two traps worth knowing before changing anything

**mp4box hands over sample data during `appendBuffer`.** `setExtractionOptions`
and `start()` must be called *inside* `onReady`. Arranging them a microtask
later - by awaiting a promise that `onReady` resolves - leaves the file parsed,
the track described, `nb_samples` correct, and not one sample delivered. It
looks exactly like a file with no frames in it.

**Decoded frames must be closed as they are drawn.** The obvious export shape -
decode each camera fully, then compose - deadlocks. A 1280x960 frame is about
1.8 MB and a minute is 2200 of them per camera, so four cameras exhaust the
frame pool; Chrome applies backpressure and `flush()` never resolves. No error,
no timeout, an export stuck at 0% forever. `FrameStream` in `src/lib/export.ts`
keeps each camera at most six frames ahead and the four are pulled in lockstep.

The player is also unmounted during an export, not merely paused: four `<video>`
elements hold four decoders, and the browser allows only so many at once.

## Browser support

Chromium reads the folder directly through `showDirectoryPicker`, which walks
names lazily - a sentry folder is tens of gigabytes and the scan must not read
it. Firefox and Safari fall back to `<input webkitdirectory>`, which works but
loads the tree up front. Export needs **WebCodecs**; where it is missing the app
says so and everything else still works.
