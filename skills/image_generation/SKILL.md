---
name: image_generation
description: GPT Image 2.5/2.6: named images, 1K/2K, reference images, 100-300 points.
---

# Image generation

Use `generate_image` when the user asks to draw or create an image. Give each image a short, concrete `name` and a clear `prompt`. The server displays and stores the image; use the exact returned name and filename when referring to it. Never guess filenames or invent links.

Choose the model for the task:

- `gpt-image-2.5`: 100 points per image; previous generation, still selectable.
- `gpt-image-2.5-flare`: 200 points per image; fast, high-quality everyday generation.
- `gpt-image-2.5-sunburst`: 300 points per image; detailed composition and precision.
- `gpt-image-2.6`: 100 points per image; default for ordinary requests.
- `gpt-image-2.6-flare`: 200 points per image; newer generation, fast high-quality everyday work.
- `gpt-image-2.6-sunburst`: 300 points per image; newer generation, detailed composition and precision.

Call once per image (`batch_size=1`). Supported output sizes include the existing 1K sizes and `2048x2048`, `2048x1152`, and `1152x2048` for 2K output. Every edge is at most 2048 pixels. Do not request auto, 4K or a larger size.

For a reference-image edit or variation, pass `reference_image_file_ids` using image attachment IDs from the current conversation. The server validates ownership and sends those images through the edits endpoint. Never pass external URLs, paths, data from another user, or guessed file IDs.

Points are shared by Web and CX RAI. On `insufficient_points`, tell the user that generation was refused because of insufficient points, and give the returned required/current balance. No image was created or charged. Stop; do not retry or switch to a free model. A failed or cancelled generation is refunded. On success, briefly name the image and state the returned charge. Do not repeat image Markdown already displayed by the server, expose credentials or provider endpoints, or claim success without a successful tool result.
