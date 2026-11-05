#!/usr/bin/env python3
"""Recompute every derived number in ep01 from the tumbling-toast model (Matthews 1995, Eur. J. Phys. 16:172).

Model: spin w^2 = (6g/a) * [n / (1 + 3n^2)] * sin(p), fall time t = sqrt(2(h - 2a)/g), butter-up needs w*t > 3pi/2 - p.
a is half the toast length, n is overhang divided by a, p is the tip angle (pi/2 at the limit), h is table height.
Symbols were read from an OCR copy of the paper; check them against the PDF before publishing.
"""
import math

G = 9.81
A = 0.05       # half-length of toast, m
H = 0.75       # table height, m
ETA = 0.015    # Matthews' measured overhang parameter for toast
PHI = math.pi / 2


def spin(a: float, eta: float = ETA, phi: float = PHI) -> float:
    return math.sqrt(6 * G / a * eta / (1 + 3 * eta**2) * math.sin(phi))


def fall_time(h: float, a: float) -> float:
    return math.sqrt(2 * (h - 2 * a) / G)


w, t = spin(A), fall_time(H, A)
air_deg = math.degrees(w * t)
print(f"overhang past centre: {ETA * A * 1000:.2f} mm")
print(f"spin: {w:.2f} rad/s = {math.degrees(w):.0f} deg/s")
print(f"time in the air at 75 cm: {t:.3f} s")
print(f"turn in the air: {air_deg:.0f} deg; with 90 deg of tipping: {air_deg + 90:.0f} deg")

need = 3 * math.pi / 2 - PHI
t_min = need / w
h_min = G * t_min**2 / 2 + 2 * A
print(f"minimum table height for butter-up: {h_min:.2f} m = {h_min * 3.28084:.1f} ft; time in the air {t_min:.2f} s")

small = 0.0125
w_s, t_s = spin(small), fall_time(H, small)
print(f"toast 2.5 cm across: {w_s:.2f} rad/s, {t_s:.3f} s, turn {math.degrees(w_s * t_s):.0f} deg in the air (needs > 180): "
      f"{'butter up' if w_s * t_s > need else 'butter down'}")

print(f"1.6 m/s = {1.6 * 2.23694:.1f} mph")
print(f"plywood: butter-down share of overhang range 0-5.1 cm = {(0.8 + (5.1 - 2.7)) / 5.1:.0%}")
print(f"76 cm = {76 / 30.48:.1f} ft")
