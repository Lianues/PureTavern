from pathlib import Path

from PIL import Image, ImageDraw

MOBILE_ROOT = Path(__file__).resolve().parents[1]
PROJECT_ROOT = MOBILE_ROOT.parents[1]
SOURCE = PROJECT_ROOT / "apps" / "web" / "src" / "branding" / "pure-tavern-icon.png"
ANDROID_RESOURCES = MOBILE_ROOT / "android" / "app" / "src" / "main" / "res"
IOS_ASSETS = MOBILE_ROOT / "ios" / "App" / "App" / "Assets.xcassets"

SPLASH_SIZE = 1024

ANDROID_DENSITIES = {
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


def write_android_branding(source: Image.Image) -> None:
    for density, (legacy_size, foreground_size) in ANDROID_DENSITIES.items():
        directory = ANDROID_RESOURCES / f"mipmap-{density}"
        directory.mkdir(parents=True, exist_ok=True)

        contain(source, legacy_size, 0.94).save(directory / "ic_launcher.png", optimize=True)

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

    for path in ANDROID_RESOURCES.glob("drawable*/splash.png"):
        with Image.open(path) as existing:
            size = existing.size
        splash = Image.new("RGBA", size, (255, 255, 255, 255))
        limit = max(1, round(min(size) * 0.46))
        logo = source.copy()
        logo.thumbnail((limit, limit), Image.Resampling.LANCZOS)
        splash.alpha_composite(logo, ((size[0] - logo.width) // 2, (size[1] - logo.height) // 2))
        splash.convert("RGB").save(path, optimize=True)


def write_ios_branding(source: Image.Image) -> None:
    icon_path = IOS_ASSETS / "AppIcon.appiconset" / "AppIcon-512@2x.png"
    icon_path.parent.mkdir(parents=True, exist_ok=True)
    icon = Image.new("RGBA", (1024, 1024), (255, 255, 255, 255))
    logo = source.copy()
    logo.thumbnail((920, 920), Image.Resampling.LANCZOS)
    icon.alpha_composite(logo, ((1024 - logo.width) // 2, (1024 - logo.height) // 2))
    icon.convert("RGB").save(icon_path, optimize=True)

    # A single unscaled slot. Registering one image as 1x/2x/3x made the system size the launch
    # image against the largest scale: 2732x2732 decodes to ~29.9 MB of RGBA, over splashboardd's
    # 25 MB ceiling, so it refused to generate the launch image and denylisted the bundle id
    # (XBLaunchStoryboardErrorDomain code 6). Without a scale suffix the image is used at its own
    # pixel size, and the logo occupies well under a fifth of the canvas anyway.
    splash_directory = IOS_ASSETS / "Splash.imageset"
    splash = Image.new("RGBA", (SPLASH_SIZE, SPLASH_SIZE), (255, 255, 255, 255))
    splash_logo = source.copy()
    limit = round(SPLASH_SIZE * 0.46)
    splash_logo.thumbnail((limit, limit), Image.Resampling.LANCZOS)
    splash.alpha_composite(
        splash_logo,
        ((SPLASH_SIZE - splash_logo.width) // 2, (SPLASH_SIZE - splash_logo.height) // 2),
    )
    splash.convert("RGB").save(splash_directory / "splash.png", optimize=True)


def main() -> None:
    with Image.open(SOURCE) as image:
        source = image.convert("RGBA")
    write_android_branding(source)
    write_ios_branding(source)
    print(f"Generated Android and iOS branding from {SOURCE.relative_to(PROJECT_ROOT)}")


if __name__ == "__main__":
    main()
