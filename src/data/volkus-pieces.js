/**
 * Volkus piece keys, rubble templates measured from the map cards, and piece names.
 */
// All twelve Volkus Approved Ops layouts (2024 and 2025) from the KT24 Killzone Mod (Steam Workshop 3573927734),
// kept as the mod's own piece placements: [mesh key, posX, posZ, rotY, scale] per object.
// TTS is Unity: left-handed, OBJ imported with X negated, and from above +z points
// UP the screen — so board = (x, -z), and each piece is a pure rotation of its raw
// OBJ vertices by a = alpha + 180 - rotY. Guide markers give the deployment edge and
// whether the layout sits portrait. Verified against the official map cards.
// FINE_PIECES: each scanned piece's footprint traced from its mesh triangles at 0.1"
// in the piece's own frame — [typical scale, x0, z0, nx, nz, RLE of (class<<4 | height
// in half inches)]. A cell blocks a base only if the scan has geometry at base height
// (0.25"-1.2" up): tall runs are walls, low runs light terrain, and geometry only high
// up is an upper floor you can stand under. Rubble bundles have no readable mesh, so
// they use card-measured templates [w, h, cx, cz, kind, z]; fire steps never block.
export const VOLKUS_PIECES = {objective: "2AA481BF3BB82CD4", guide: "9C8BD76749A0A723", surface: "06EC984208223D38",
  templates: {"D516D672AD00F4E9": [2.42, 0.81, 0, 0, "heavy", 2], "D89DFA2BC6FAF24E": [2.58, 0.82, 0, 0, "heavy", 2],
              "7800BDC2BED78D48": [2.03, 0.64, 0, 0, "light", 1], "FC33155AB0F2D38C": [1.69, 0.59, 0, 0, "light", 1],
              "469DF7AB2CD02822": [2.14, 1.02, 0.18, 0.24, "step", 0], "E6D612B8D6752812": [2.14, 1.02, 0.18, 0.24, "step", 0]},
  names: {"CBEB9D46D0A30182": "Stronghold", "31A59AADFE3AB5A2": "Stronghold", "329CEBBDF7CA55AE": "Large ruin",
          "4D2F38A31D165FA8": "Large ruin", "7EAB718986CB6FCE": "Small ruin", "5B84E393C179222E": "Small ruin",
          "5F6869039198593C": "Light rubble", "F8E4285F7033E562": "Fire step"}};
