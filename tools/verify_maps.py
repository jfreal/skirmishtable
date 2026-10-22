"""Verify converted maps against the official card images:
  1) terrain overlap F1 (converted rects vs card terrain pixels)
  2) objective positions vs the card's orange skull rings (inches of error)
  3) deployment edge vs the card's coloured drop-zone strips
and write an overlay image per map for visual inspection."""
import argparse, collections, json, math, os, sys
from PIL import Image, ImageDraw

W, H = 30.0, 22.0
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from paths import CARD_DIR, EXPORT_DIR, VERIFY_DIR
ap = argparse.ArgumentParser(description="Check the app's Volkus maps against the card images. "
                             "Run `npm run export:maps` first.")
ap.add_argument("--year", choices=["24", "25"], default="24")
args = ap.parse_args()
maps = json.load(open(os.path.join(EXPORT_DIR, f"maps-{args.year}.json")))
carddir, outdir = CARD_DIR, os.path.join(VERIFY_DIR, args.year)
os.makedirs(outdir, exist_ok=True)

def terrain_px(r, g, b):
    lum = 0.3 * r + 0.59 * g + 0.11 * b
    fill = 40 <= lum <= 140 and g >= r - 5 and b <= g + 10 and b - r < 35
    wall = lum < 40
    return fill or wall

def ring_px(r, g, b):
    return r > 200 and g < 120 and b < 60

report = {}
for i in range(1, 7):
    m = maps[f"v{i}"]
    card = Image.open(os.path.join(carddir, f"Volkus_{args.year}_0{i}.img")).convert("RGB")
    cw, ch = card.size
    sx, sy = cw / W, ch / H
    pix = card.load()
    # 1) terrain F1 on a 0.25" lattice (1-cell tolerance)
    RES = 0.25; GW, GH = int(W / RES), int(H / RES)
    cardset = set()
    for j in range(GH):
        for k in range(GW):
            r, g, b = pix[int((k + 0.5) * RES * sx), int((j + 0.5) * RES * sy)]
            if terrain_px(r, g, b): cardset.add((k, j))
    ours = set()
    for t in m["terrain"] + m.get("decor", []):
        for k in range(int(t["x"] / RES), int((t["x"] + t["w"]) / RES) + 1):
            for j in range(int(t["y"] / RES), int((t["y"] + t["h"]) / RES) + 1):
                if 0 <= k < GW and 0 <= j < GH: ours.add((k, j))
    dil = lambda S: {(a + da, b + db) for a, b in S for da in (-1, 0, 1) for db in (-1, 0, 1)}
    prec = len(ours & dil(cardset)) / max(1, len(ours))
    rec = len(cardset & dil(ours)) / max(1, len(cardset))
    f1 = 2 * prec * rec / (prec + rec)
    # 2) card skull rings -> clusters -> centroids
    ringpts = [(u, v) for v in range(0, ch, 2) for u in range(0, cw, 2) if ring_px(*pix[u, v])]
    clusters = []
    for p in ringpts:
        for c in clusters:
            if abs(c["cx"] - p[0]) < 1.6 * sx and abs(c["cy"] - p[1]) < 1.6 * sy:
                c["pts"].append(p); c["cx"] = sum(q[0] for q in c["pts"]) / len(c["pts"])
                c["cy"] = sum(q[1] for q in c["pts"]) / len(c["pts"]); break
        else:
            clusters.append({"pts": [p], "cx": p[0], "cy": p[1]})
    rings = [(c["cx"] / sx, c["cy"] / sy) for c in clusters if len(c["pts"]) > 40]
    errs = []
    for o in m["objectives"]:
        d = min((math.hypot(o["x"] - rx, o["y"] - ry) for rx, ry in rings), default=99)
        errs.append(round(d, 2))
    # 3) deployment: which edges carry the tinted drop-zone strips
    def edge_tint(box):
        n = tint = 0
        for v in range(box[1], box[3], 3):
            for u in range(box[0], box[2], 3):
                r, g, b = pix[u, v]
                lum = 0.3 * r + 0.59 * g + 0.11 * b
                orange = r > 200 and 140 < g < 200 and b < 190 and r - b > 40
                grey = abs(r - g) < 12 and abs(g - b) < 12 and 150 < lum < 200
                tint += orange or grey; n += 1
        return tint / n
    lr = (edge_tint((2, int(ch * .3), int(cw * .04), int(ch * .7))) +
          edge_tint((int(cw * .96), int(ch * .3), cw - 2, int(ch * .7)))) / 2
    tb = (edge_tint((int(cw * .3), 2, int(cw * .7), int(ch * .04))) +
          edge_tint((int(cw * .3), int(ch * .96), int(cw * .7), ch - 2))) / 2
    card_edge = "short" if lr > tb else "long"
    report[i] = {"F1": round(f1, 3), "precision": round(prec, 3), "recall": round(rec, 3),
                 "objective_err_in": errs, "card_rings": len(rings),
                 "deploy_ours": m["dropEdge"], "deploy_card": card_edge}
    print(f"map {i}: F1 {f1:.3f} (prec {prec:.3f}, rec {rec:.3f}) | objectives off by {errs} in"
          f" ({len(rings)} rings on card) | deploy ours={m['dropEdge']} card={card_edge}"
          f" {'OK' if m['dropEdge'] == card_edge else 'MISMATCH'}")
    # overlay image: faded card + our rects + objectives + drop zones
    S = 26
    base = card.resize((int(W * S), int(H * S))).convert("RGBA")
    fade = Image.new("RGBA", base.size, (255, 255, 255, 120))
    base = Image.alpha_composite(base, fade)
    ov = Image.new("RGBA", base.size, (0, 0, 0, 0)); d = ImageDraw.Draw(ov)
    dd = m["dropDepth"]
    zones = ([(0, 0, dd, H), (W - dd, 0, W, H)] if m["dropEdge"] == "short" else [(0, 0, W, dd), (0, H - dd, W, H)])
    for zx0, zy0, zx1, zy1 in zones:
        d.rectangle([zx0 * S, zy0 * S, zx1 * S - 1, zy1 * S - 1], outline=(30, 90, 220, 255), width=3)
    col = {"wall": (200, 30, 30, 150), "heavy": (150, 30, 160, 150), "light": (20, 140, 60, 150), "step": (230, 160, 0, 150)}
    for t in m["terrain"] + m.get("decor", []):
        d.rectangle([t["x"] * S, t["y"] * S, (t["x"] + t["w"]) * S, (t["y"] + t["h"]) * S], fill=col[t["kind"]])
    for o in m["objectives"]:
        r = 0.787 * S
        d.ellipse([o["x"] * S - r, o["y"] * S - r, o["x"] * S + r, o["y"] * S + r], outline=(0, 0, 255, 255), width=4)
    Image.alpha_composite(base, ov).convert("RGB").save(os.path.join(outdir, f"verify_v{i}.png"))
json.dump(report, open(os.path.join(outdir, "verify_report.json"), "w"), indent=1)
