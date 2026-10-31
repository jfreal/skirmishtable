// Mutable state shared across modules. Anything here is reassigned from more than one
// module (ES module bindings can only be reassigned by the module that declares them).
export const state = {
  sel: null,
  mode: null,
  moveType: "reposition",
  target: null,
  lastShot: null,
  drag: null,
  suppressClick: false,
  rulerPts: [],
  replay: false,          // a replay is on the table: look, don't touch (net/replayer.js)
};
