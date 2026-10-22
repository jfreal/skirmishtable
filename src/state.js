// Mutable state shared across modules. Anything here is reassigned from more than one
// module (ES module bindings can only be reassigned by the module that declares them).
export const state = {
  sel: null,
  mode: null,
  moveType: "reposition",
  target: null,
  lastSight: null,
  drag: null,
  suppressClick: false,
  rulerPts: [],
};
