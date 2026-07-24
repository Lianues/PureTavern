from pathlib import Path

from PIL import Image, ImageDraw

MOBILE_ROOT = Path(__file__).resolve().parents[1]
PROJECT_ROOT = MOBILE_ROOT.parents[1]
SOURCE = PROJECT_ROOT / "apps" / "web" / "src" / "branding" / "pure-tavern-icon.png"
RESOURCES = MOBILE_ROOT / "android" / "app" / "src" / "main" / "res"

DENSITIES = {
    "mdpi": (48, 108),
    "hdpi": (72, 162),
    "xhdpi": (96, 216),
    "xxhdpi": (144, 324),
    "xxxhdpi": (192, 432),
}


def contain(source: Image.Image, size: int, scale: float) -> Image.Image:
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    limit = max(1, round(size * scale))
    image = source.copy()
    image.thumbnail((limit, limit), Image.Resampling.LANCZOS)
    canvas.alpha_composite(image, ((size - image.width) // 2, (size - image.height) // 2))
    return canvas


def write_launcher_icons(source: Image.Image) -> None:
    for density, (legacy_size, foreground_size) in DENSITIES.items():
        directory = RESOURCES / f"mipmap-{density}"
        directory.mkdir(parents=True, exist_ok=True)

        legacy = contain(source, legacy_size, 0.94)
        legacy.save(directory / "ic_launcher.png", optimize=True)

        round_icon = Image.new("RGBA", (legacy_size, legacy_size), (0, 0, 0, 0))
        draw = ImageDraw.Draw(round_icon)
        margin = max(1, round(legacy_size * 0.03))
        draw.ellipse(
            (margin, margin, legacy_size - margin - 1, legacy_size - margin - 1),
            fill=(255, 255, 255, 255),
        )
        round_icon.alpha_composite(contain(source, legacy_size, 0.82))
        round_icon.save(directory / "ic_launcher_round.png", optimize=True)

        contain(source, foreground_size, 0.66).save(
            directory / "ic_launcher_foreground.png",
            optimize=True,
        )


def write_splash_images(source: Image.Image) -> None:
    for path in RESOURCES.glob("drawable*/splash.png"):
        with Image.open(path) as existing:
            size = existing.size
        splash = Image.new("RGBA", size, (255, 255, 255, 255))
        limit = max(1, round(min(size) * 0.46))
        logo = source.copy()
        logo.thumbnail((limit, limit), Image.Resampling.LANCZOS)
        splash.alpha_composite(logo, ((size[0] - logo.width) // 2, (size[1] - logo.height) // 2))
        splash.convert("RGB").save(path, optimize=True)


def main() -> None:
    with Image.open(SOURCE) as image:
        source = image.convert("RGBA")
    write_launcher_icons(source)
    write_splash_images(source)
    print(f"Generated Android branding from {SOURCE.relative_to(PROJECT_ROOT)}")


if __name__ == "__main__":
    main()
