---
name: image_generation
description: Generate named GPT Image 2.5 images at up to 1K for 100-300 points.
---

# Image generation

Use `generate_image` when the user asks to draw or create an image. Give each image a short, concrete `name` and a clear `prompt`. The server displays and stores the image; use the exact returned name and filename when referring to it. Never guess filenames or invent links.

Choose the model for the task:

- `gpt-image-2.5`: 100 points per image; default for ordinary requests.
- `gpt-image-2.5-flare`: 200 points per image; fast, high-quality everyday generation.
- `gpt-image-2.5-sunburst`: 300 points per image; detailed composition and precision.

Call once per image (`batch_size=1`). Supported output sizes: `512x512`, `768x768`, `1024x1024`, `1024x768`, `768x1024`, `1024x640`, `640x1024`. Every edge is at most 1024 pixels. Do not request auto, 2K, 4K or a larger size. Do not pass reference image URLs.

Points are shared by Web and CX RAI. On `insufficient_points`, tell the user that generation was refused because of insufficient points, and give the returned required/current balance. No image was created or charged. Stop; do not retry or switch to a free model. A failed or cancelled generation is refunded. On success, briefly name the image and state the returned charge. Do not repeat image Markdown already displayed by the server, expose credentials or provider endpoints, or claim success without a successful tool result.
