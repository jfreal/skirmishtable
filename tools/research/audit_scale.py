import os, sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import json, sys, os, math
from audit_cards import *
bags = json.load(open(sys.argv[1]))
meshes = {fn[:-4]: load_obj(os.path.join(sys.argv[2], fn)) for fn in os.listdir(sys.argv[2]) if fn.endswith(".obj")}
best = {1: 0, 2: -90, 3: 0, 4: 0, 5: 0, 6: 0}
import audit_cards as A
orig = A.piece_world
for m in (0.9, 0.95, 1.0, 1.05, 1.1):
    A.piece_world = lambda v, s, ry, px, pz, xf, m=m: orig(v, s * m, ry, px, pz, xf)
    scores = []
    for i in range(1, 7):
        card = card_mask(os.path.join(sys.argv[3], f"Volkus_24_0{i}.img"))
        occ, _ = occupancy(bags[f"Volkus 24 0{i}"], meshes, True, best[i])
        hit = len(occ & dilate(card, 1)) / len(occ); cov = len(card & dilate(occ, 1)) / len(card)
        scores.append(2 * hit * cov / (hit + cov))
    print(f"piece scale x{m:.2f}: mean F1 {sum(scores)/6:.3f}  per-map {[round(s,3) for s in scores]}")
A.piece_world = orig
# 5F68 (unlabelled scan) height and the fire-step model height
for k in ("5F6869039198593C", "F8E4285F7033E562", "7EAB718986CB6FCE", "5B84E393C179222E"):
    ys = [v[1] for v in meshes[k]]
    print(k, "height (unscaled):", round(max(ys) - min(ys), 2))
