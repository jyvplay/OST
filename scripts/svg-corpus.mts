/** Shared tricky-path / transform corpus for oracle-svg (svgelements) and e2e-vector (Chromium). */
export const PATHS: { d: string; arc: boolean; oracleDeviates?: boolean }[] = [
  { d: "M10 10 L90 10 L90 90 Z", arc: false },
  { d: "M10,10h80v80h-80z", arc: false },
  { d: "M0 0l10 0 0 10 -10 0z", arc: false },                     // implicit lineto repeats
  { d: "M5 5 10 10 20 5", arc: false },                             // implicit lineto after M
  { d: "m5 5 10 10 20-5", arc: false },                             // relative implicit after m
  { d: "M1.5.5L3.25-1.75 6e1 2E1", arc: false },                    // "1.5.5", sign as separator, exponents
  { d: "M0 0C0 100 100 100 100 0", arc: false },
  { d: "M10 80 C40 10 65 10 95 80 S150 150 180 80", arc: false },   // S reflection
  { d: "M10 80 Q52.5 10 95 80 T180 80 T260 80", arc: false },       // T chain
  { d: "M10 80 q42.5-70 85 0 t85 0", arc: false },
  { d: "M10 10 S 50 80 90 10", arc: false },                        // S without previous C: first control = current point
  { d: "M10 10 T 90 10", arc: false },                              // T without previous Q: straight line
  { d: "M10 10 h20 v20 z m40 0 q10 -20 20 0 t20 0", arc: false },  // second subpath starts at closed start
  { d: "M0 0 A50 50 0 0 1 100 0", arc: true },
  { d: "M0 0 A50 50 0 1 0 100 0", arc: true },
  { d: "M0 0 A1 1 0 0 1 100 0", arc: true },                        // radii too small → scaled up (F.6.6)
  { d: "M10 10 a30 15 30 1 1 50 20", arc: true },                    // rotated ellipse, large arc
  { d: "M10 10 a30 15 -45 0 0 50 20", arc: true },
  { d: "M0 0a5 5 0 1010 0", arc: true },                            // compact flags: "10" = large 1, sweep 0
  { d: "M100 100 A60 30 120 1 1 140 60 A10 10 0 0 0 160 80 Z", arc: true },
  { d: "M20 20 A40 40 0 0 1 20 20.0001", arc: true },               // near-full circle
  { d: "M0 0 A0 10 0 0 1 50 50", arc: false, oracleDeviates: true }, // rx = 0 → straight line (SVG F.6.2); svgelements reports length 0 — Chromium arbitrates in e2e-vector
  { d: "M300 200 h-150 a150 150 0 1 0 150 -150 z", arc: true },     // MDN pie
  { d: "M10 315 L 110 215 A 30 50 0 0 1 162.55 162.45 L 172.55 152.45 A 30 50 -45 0 1 215.1 109.9 L 315 10", arc: true }, // MDN arcs
];
export const TRANSFORMS = [
  "translate(10,20)", "translate(5)", "scale(2)", "scale(2 -3)", "rotate(30)", "rotate(30 10 20)", "skewX(10)", "skewY(-25)",
  "matrix(1 2 3 4 5 6)", "translate(10 20) rotate(45) scale(2,0.5)", "rotate(90,50,50) translate(5,0) skewX(30)",
  "matrix(.5,0,0,.5,1e1,-2E1)scale(3)", "  rotate( -120 , 7 , -3 )  ",
];

