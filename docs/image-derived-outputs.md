# SVG and GIF Outputs of Image Nodes

The "Vector" and "Animated" buttons in the image top toolbar create standalone result nodes. A node supports preview, download, deletion, and retry; task references are persisted to the canvas, and waiting resumes after a refresh.

- SVG: `POST /projects/{project}/freezone/image/vectorize`, with the request fields `image_url`, `canvas_id`, `node_id`. Converted locally with vtracer, free of charge.
- GIF: `POST /projects/{project}/freezone/image/animate`, with the same request. It first generates a first-frame-locked, 4-second, 720p, silent video, then converts it to a looping GIF. The video is billed per the catalog rules; the transcoding is free.
- Retry only the conversion: `POST /projects/{project}/freezone/image/animate-gif`, with the request fields `video_url`, `canvas_id`, `node_id`. When a video already exists, it is not regenerated.

Paths are prefixed with `/api/v1`. Only media of the current project is accepted. The video task uses the `video` lane, and the two local conversion tasks use the `ffmpeg` lane of the project's home node. EE must also start the corresponding consumers; deployment images must include ffmpeg and vtracer (the Dockerfiles of both repositories already include the installation). Local development needs the directory containing vtracer added to the worker's PATH.

Conversions support timeouts, cleanup on cancel, output size limits, atomic writes, and source path constraints. GIF is limited to 12 fps, 480 pixels wide, at most 15 seconds, and at most 30 MiB; SVG is at most 12 MiB, and complex photos may lose detail.

When the video succeeds but delivery of the GIF subtask fails, the video result is kept and the node can retry the local conversion. When upstream generation fails, the error is shown and regeneration is supported.
