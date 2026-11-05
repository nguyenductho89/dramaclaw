"""Overhang bands from Bacon, Heald & James (2001), Manim Community. Colours come from examples/science-humor/series-bible.md.

  uv run --python 3.12 --with manim manim -r 1920,1080 --fps 24 -o overhang.mp4 --media_dir <dir> overhang.py Overhang

Bands in cm of overhang: butter side down 0-0.8 and 2.7-5.1, up in between. Measurements stop at 3.7 cm; the 5.1 cm end is calculated.
"""
import os

from manim import DOWN, UP, Create, FadeIn, Line, Rectangle, Scene, Text, VGroup, config

config.background_color = "#1F2A30"
INK, GOLD, BLUE = "#F4EFE3", "#D9A441", "#5B8DB8"
FONT = os.environ.get("MANIM_FONT", "IBM Plex Sans")
MAX_CM = 5.1
WIDTH = 11.0


def x_at(cm: float) -> float:
    return -WIDTH / 2 + WIDTH * cm / MAX_CM


class Overhang(Scene):
    def label(self, text: str, size: int = 30, color: str = INK) -> Text:
        return Text(text, font=FONT, font_size=size, color=color)

    def band(self, start: float, end: float, color: str) -> Rectangle:
        rect = Rectangle(width=x_at(end) - x_at(start), height=1.0, stroke_width=0, fill_color=color, fill_opacity=1)
        rect.move_to([(x_at(start) + x_at(end)) / 2, 0, 0])
        return rect

    def construct(self):
        title = self.label("How far the board hangs over the edge", 40).to_edge(UP, buff=0.8)
        credit = self.label("Bacon, Heald & James, 2001", 26).next_to(title, DOWN, buff=0.2)
        axis = Line([x_at(0), -0.8, 0], [x_at(MAX_CM), -0.8, 0], color=INK)
        ticks = VGroup(*[self.label(f"{v:g} cm", 26).move_to([x_at(v), -1.2, 0]) for v in (0, 0.8, 2.7, 5.1)])
        self.play(FadeIn(title), FadeIn(credit), Create(axis), FadeIn(ticks), run_time=2)
        self.wait(2)

        down1, up, down2 = self.band(0, 0.8, GOLD), self.band(0.8, 2.7, BLUE), self.band(2.7, MAX_CM, GOLD)
        self.play(FadeIn(down1), FadeIn(up), FadeIn(down2), run_time=2)
        tags = VGroup(self.label("butter side up", 28).move_to(up), self.label("butter side down", 28, "#1F2A30").move_to(down2))
        self.play(FadeIn(tags), run_time=1)
        self.wait(2)

        share = self.label("Butter side down: about 63% of this range", 40, GOLD).move_to([0, 1.5, 0])
        self.play(FadeIn(share), run_time=1)
        self.wait(3)
        note = self.label("Plywood board, no butter. Measured to 3.7 cm; 5.1 cm is calculated.", 26).to_edge(DOWN, buff=0.9)
        self.play(FadeIn(note), run_time=1)
        self.wait(6)
