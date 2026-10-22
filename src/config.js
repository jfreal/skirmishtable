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
export const TEAMGREY = ["#a08a7a", "#83909a"]; // spent: colour drains once an operative has moved
