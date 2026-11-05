# Fight previs (Three.js, 9:16, 5 s)

Two adult fighters on a mountain summit: A = red bikini (left), B = blue bikini (right).
Choreography: guard, A straight punch, B parry, B roundhouse kick (A ducks), clinch, B throws A, A gets up, both hold guard (last 0.5 s stable).

Run: `npm install && CHROME="<path to Chrome for Testing>" node render.js` -> `fight_previs.mp4` (768x1344, 124 frames @24fps, no audio) + `fight_f0.png`.

`<Video 1>` wording for the H3 ref2va prompt:
"<Video 1> is a rough low-polygon previsualization of the shot. It defines only the camera path (slow orbit) and the fight choreography; no flat colour, geometry or low-poly look is carried over."
Colours exist only to tell A (red) from B (blue); describe real appearance via the character sheets (<Picture N>).
