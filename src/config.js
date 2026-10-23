/**
 * Rules constants (inches) and team/weapon definitions.
 */
/* ---------- constants & data (inches) ---------- */
export const S = 32;                 // px per inch
export let BASE_R = 0.551;           // base radius in inches (28mm; set by the ruleset)
export const OBJ_R = 0.787;          // 40mm objective radius
export let CTRL = 1.0;               // control range (set by the ruleset)
export function setBaseRadius(r) { BASE_R = r; }
export function setControlRange(r) { CTRL = r; }
// Bases the miniatures stand on (mm). A base measured off a model snaps to the nearest
// one; a measurement more than 15% off all of them isn't trusted (null).
export const BASE_SIZES = [28, 32, 40];
export function snapBase(mm) {
  if (!(mm > 0)) return null;
  const s = BASE_SIZES.reduce((a, b) => Math.abs(b - mm) < Math.abs(a - mm) ? b : a);
  return Math.abs(s - mm) <= 0.15 * s ? s : null;
}

export const WPN = {
  srgFire:  {name:"Master firearm", type:"R", atk:4, hit:3, dmgN:3, dmgC:4, rules:[]},
  srgBlade: {name:"Power blade",    type:"M", atk:4, hit:3, dmgN:4, dmgC:5, rules:[]},
  firearm:  {name:"Firearm",        type:"R", atk:4, hit:4, dmgN:3, dmgC:4, rules:[]},
  knife:    {name:"Knife",          type:"M", atk:3, hit:4, dmgN:2, dmgC:3, rules:[]},
  blades:   {name:"Heavy blades",   type:"M", atk:4, hit:4, dmgN:4, dmgC:5, rules:["Ceaseless"]},
};
export const TEAMNAME = ["Ash", "Slate"];
export const TEAMCOL  = ["#e0672f", "#5b93a6"];
export const TEAMCOL_LT = ["#f08a4b", "#7fb6c9"];
export const ENGAGE_COL = "#e0302a"; // engagement range: the rings round two models about to fight
export const TEAMGREY = ["#a08a7a", "#83909a"]; // spent: colour drains once an operative has moved
