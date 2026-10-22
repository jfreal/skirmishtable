/**
 * Hand-made "Volkus Ruins" map (rect terrain).
 */
// terrain: axis-aligned rects. kind: wall (tall ruin wall), heavy (tall rubble), light (low rubble)
// sight: walls & heavy block; light does not. cover: all can grant. obscure: walls & heavy.
// z = height in inches: drives the cast-shadow length and label; later, climb costs and Vantage rules.
export const VOLKUS_TERRAIN = [
  // eight L-shaped ruins + the centre building; z = wall height in inches (2"-4").
  // Climb over a wall by spending its height from Reposition/Charge movement — never Dash.
  // segs: sections along the wall's length as [length_in_inches, height] — broken
  // walls have a lower stretch that's cheaper to climb over. z = tallest section.
  {id:"W1", kind:"wall", x: 9.75, y: 3.5,  w: 0.25, h: 4.5,  z: 3, segs: [[2.5,3],[2.0,2]]},
  {id:"W2", kind:"wall", x: 9.75, y: 7.75, w: 3.75, h: 0.25, z: 3, segs: [[1.75,2],[2.0,3]]},
  {id:"W3", kind:"wall", x:13.0,  y: 9.0,  w: 4.25, h: 0.25, z: 3, segs: [[1.5,2],[1.5,3],[1.25,2]]},
  {id:"W4", kind:"wall", x:13.0,  y: 9.0,  w: 0.25, h: 4.0,  z: 3, segs: [[2.0,3],[2.0,2]]},
  {id:"W5", kind:"wall", x:15.5,  y:12.75, w: 1.75, h: 0.25, z: 2, segs: [[1.75,2]]},
  {id:"W6", kind:"wall", x:17.0,  y: 9.0,  w: 0.25, h: 2.0,  z: 4, segs: [[2.0,4]]},
  {id:"W7", kind:"wall", x:20.0,  y: 5.5,  w: 3.5,  h: 0.25, z: 4, segs: [[1.5,4],[2.0,3]]},
  {id:"W8", kind:"wall", x:23.25, y: 5.5,  w: 0.25, h: 3.25, z: 4, segs: [[1.75,2],[1.5,4]]},
  {id:"W9", kind:"wall", x: 6.75, y:14.0,  w: 0.25, h: 3.5,  z: 3, segs: [[1.5,2],[2.0,3]]},
  {id:"W10",kind:"wall", x: 6.75, y:14.0,  w: 3.25, h: 0.25, z: 3, segs: [[2.0,3],[1.25,2]]},
  {id:"W11",kind:"wall", x:18.75, y:15.75, w: 3.5,  h: 0.25, z: 3, segs: [[1.25,3],[2.25,2]]},
  {id:"W12",kind:"wall", x:18.75, y:13.0,  w: 0.25, h: 3.0,  z: 3, segs: [[1.5,2],[1.5,3]]},
  {id:"W13",kind:"wall", x:15.5,  y: 3.2,  w: 0.25, h: 2.2,  z: 2, segs: [[2.2,2]]},
  {id:"W14",kind:"wall", x:15.5,  y: 3.2,  w: 2.8,  h: 0.25, z: 3, segs: [[1.3,3],[1.5,2]]},
  {id:"W15",kind:"wall", x:12.2,  y:16.2,  w: 0.25, h: 2.6,  z: 4, segs: [[1.2,4],[1.4,2]]},
  {id:"W16",kind:"wall", x:12.2,  y:18.55, w: 2.8,  h: 0.25, z: 3, segs: [[1.4,2],[1.4,3]]},
  // edge ruins pressed against the drop-zone lines (x=6 and x=24)
  {id:"W17",kind:"wall", x:23.75, y:10.2,  w: 0.25, h: 2.6,  z: 4, segs: [[1.4,4],[1.2,3]]},
  {id:"W18",kind:"wall", x:21.55, y:10.2,  w: 2.45, h: 0.25, z: 4, segs: [[1.2,2],[1.25,4]]},
  {id:"W19",kind:"wall", x: 6.0,  y: 8.6,  w: 0.25, h: 2.6,  z: 2, segs: [[2.6,2]]},
  {id:"W20",kind:"wall", x: 6.0,  y: 8.6,  w: 2.2,  h: 0.25, z: 4, segs: [[1.0,4],[1.2,2]]},
  // rubble against the drop-zone lines — deploy concealed behind these
  {id:"H2", kind:"heavy", x:22.2, y: 2.7,  w: 1.8, h: 1.6, z: 3},
  {id:"H3", kind:"heavy", x: 6.0, y:18.9,  w: 1.8, h: 1.7, z: 2},
  {id:"H5", kind:"heavy", x: 6.0, y: 3.2,  w: 1.7, h: 1.5, z: 2},
  {id:"H6", kind:"heavy", x:22.3, y:17.6,  w: 1.7, h: 1.5, z: 2},
];
