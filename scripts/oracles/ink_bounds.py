"""Test-only exact RGB ink bounds. Own implementation, using Pillow's C loops.

The reference predicate is min(R, G, B) < 230 at EVERY pixel, not a sample,
luminance approximation, or a changed threshold. The returned bounds are inclusive.
"""

_INK = [255 if value < 230 else 0 for value in range(256)] * 3


def ink_bounds(image):
    if image.mode != "RGB":
        raise ValueError("The oracle requires an RGB image")
    # point maps each RGB channel independently. RGB getbbox includes a pixel
    # when ANY channel is nonzero: exactly the original minimum predicate.
    bounds = image.point(_INK).getbbox()
    if bounds is None:
        raise AssertionError("no signature ink")
    left, top, right, bottom = bounds
    return [left, top, right - 1, bottom - 1]
