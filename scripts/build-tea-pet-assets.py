#!/usr/bin/env python3
"""Build transparent Tea pet poses from the two user-provided 3x3 sheets."""

from __future__ import annotations

import argparse
from collections import deque
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


GRID_COLUMNS = 3
GRID_ROWS = 3
WEB_POSES = {
    "idle": "s1-r1c1",
    "walk": "s1-r1c2",
    "wave": "s1-r2c3",
    "camera": "s1-r2c1",
    "drink": "s1-r3c2",
    "phone": "s2-r1c3",
    "laptop": "s2-r3c1",
}


def background_mask(image: Image.Image, tolerance: int = 24) -> list[list[bool]]:
    rgb = image.convert("RGB")
    width, height = rgb.size
    pixels = rgb.load()
    corners = [pixels[0, 0], pixels[width - 1, 0], pixels[0, height - 1], pixels[width - 1, height - 1]]
    reference = tuple(sum(color[channel] for color in corners) // len(corners) for channel in range(3))

    def resembles_background(x: int, y: int) -> bool:
        color = pixels[x, y]
        return max(abs(color[channel] - reference[channel]) for channel in range(3)) <= tolerance

    mask = [[False] * width for _ in range(height)]
    queue: deque[tuple[int, int]] = deque()
    for x in range(width):
        if resembles_background(x, 0):
            queue.append((x, 0))
        if resembles_background(x, height - 1):
            queue.append((x, height - 1))
    for y in range(height):
        if resembles_background(0, y):
            queue.append((0, y))
        if resembles_background(width - 1, y):
            queue.append((width - 1, y))

    while queue:
        x, y = queue.popleft()
        if mask[y][x] or not resembles_background(x, y):
            continue
        mask[y][x] = True
        if x > 0:
            queue.append((x - 1, y))
        if x + 1 < width:
            queue.append((x + 1, y))
        if y > 0:
            queue.append((x, y - 1))
        if y + 1 < height:
            queue.append((x, y + 1))
    return mask


def extract_pose(cell: Image.Image) -> Image.Image:
    rgba = cell.convert("RGBA")
    mask = background_mask(cell)
    pixels = rgba.load()
    for y, row in enumerate(mask):
        for x, is_background in enumerate(row):
            if is_background:
                pixels[x, y] = (0, 0, 0, 0)

    alpha = rgba.getchannel("A")
    alpha_pixels = alpha.load()
    width, height = alpha.size
    visited: set[tuple[int, int]] = set()
    components: list[list[tuple[int, int]]] = []
    for y in range(height):
        for x in range(width):
            if alpha_pixels[x, y] == 0 or (x, y) in visited:
                continue
            component: list[tuple[int, int]] = []
            queue = deque([(x, y)])
            visited.add((x, y))
            while queue:
                cx, cy = queue.popleft()
                component.append((cx, cy))
                for nx, ny in ((cx - 1, cy), (cx + 1, cy), (cx, cy - 1), (cx, cy + 1)):
                    if 0 <= nx < width and 0 <= ny < height and alpha_pixels[nx, ny] and (nx, ny) not in visited:
                        visited.add((nx, ny))
                        queue.append((nx, ny))
            components.append(component)
    if components:
        largest = set(max(components, key=len))
        for y in range(height):
            for x in range(width):
                if alpha_pixels[x, y] and (x, y) not in largest:
                    pixels[x, y] = (0, 0, 0, 0)

    alpha = rgba.getchannel("A")
    bbox = alpha.getbbox()
    if not bbox:
        raise ValueError("No foreground pixels found")
    left, top, right, bottom = bbox
    padding = 8
    return rgba.crop((max(0, left - padding), max(0, top - padding), min(rgba.width, right + padding), min(rgba.height, bottom + padding)))


def fit_pose(pose: Image.Image, size: tuple[int, int], padding: int = 10) -> Image.Image:
    target_width, target_height = size
    scale = min((target_width - padding * 2) / pose.width, (target_height - padding * 2) / pose.height)
    resized = pose.resize((max(1, round(pose.width * scale)), max(1, round(pose.height * scale))), Image.Resampling.NEAREST)
    canvas = Image.new("RGBA", size, (0, 0, 0, 0))
    canvas.alpha_composite(resized, ((target_width - resized.width) // 2, target_height - padding - resized.height))
    return canvas


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--sheet", action="append", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    args = parser.parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)

    poses: list[tuple[str, Image.Image]] = []
    pose_by_label: dict[str, Image.Image] = {}
    for sheet_index, path in enumerate(args.sheet, start=1):
        sheet = Image.open(path).convert("RGB")
        for row in range(GRID_ROWS):
            for column in range(GRID_COLUMNS):
                left = round(column * sheet.width / GRID_COLUMNS)
                right = round((column + 1) * sheet.width / GRID_COLUMNS)
                top = round(row * sheet.height / GRID_ROWS)
                bottom = round((row + 1) * sheet.height / GRID_ROWS)
                label = f"s{sheet_index}-r{row + 1}c{column + 1}"
                pose = extract_pose(sheet.crop((left, top, right, bottom)))
                pose.save(args.output_dir / f"{label}.png", optimize=True)
                poses.append((label, pose))
                pose_by_label[label] = pose

    tile_size = (240, 250)
    contact = Image.new("RGB", (tile_size[0] * 6, tile_size[1] * 3), (238, 240, 243))
    draw = ImageDraw.Draw(contact)
    for index, (label, pose) in enumerate(poses):
        x = (index % 6) * tile_size[0]
        y = (index // 6) * tile_size[1]
        for cy in range(y, y + tile_size[1] - 28, 16):
            for cx in range(x, x + tile_size[0], 16):
                color = (220, 224, 229) if ((cx - x) // 16 + (cy - y) // 16) % 2 else (248, 249, 250)
                draw.rectangle((cx, cy, min(cx + 15, x + tile_size[0] - 1), min(cy + 15, y + tile_size[1] - 29)), fill=color)
        fitted = fit_pose(pose, (tile_size[0], tile_size[1] - 28), padding=8)
        contact.paste(fitted, (x, y), fitted)
        draw.rectangle((x, y + tile_size[1] - 28, x + tile_size[0] - 1, y + tile_size[1] - 1), fill=(30, 36, 44))
        draw.text((x + 8, y + tile_size[1] - 22), label, fill=(255, 255, 255), font=ImageFont.load_default())
    contact.save(args.output_dir / "tea-contact-sheet.png", optimize=True)

    frame_size = (128, 128)
    atlas = Image.new("RGBA", (frame_size[0] * len(WEB_POSES), frame_size[1]), (0, 0, 0, 0))
    for frame_index, source_label in enumerate(WEB_POSES.values()):
        frame = fit_pose(pose_by_label[source_label], frame_size, padding=5)
        atlas.alpha_composite(frame, (frame_index * frame_size[0], 0))
    atlas.save(args.output_dir / "tea-pet.webp", format="WEBP", lossless=True, method=6)


if __name__ == "__main__":
    main()
