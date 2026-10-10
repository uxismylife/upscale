"""Convert an ncnn RRDBNet model (.param/.bin) into a small JSON graph + float16 weights for the web app."""
import json, struct, sys
import numpy as np

param_path, bin_path, out_prefix = sys.argv[1:4]
lines = open(param_path).read().split("\n")
assert lines[0].strip() == "7767517"
raw = open(bin_path, "rb").read()
pos = 0

def read_weight(n):
    global pos
    tag = struct.unpack_from("<I", raw, pos)[0]; pos += 4
    if tag == 0x01306B47:  # float16
        a = np.frombuffer(raw, "<f2", n, pos).astype(np.float32); pos += (n * 2 + 3) // 4 * 4
    elif tag == 0:
        a = np.frombuffer(raw, "<f4", n, pos).copy(); pos += n * 4
    else:
        raise SystemExit(f"unsupported weight tag {tag:#x}")
    return a

def read_bias(n):
    global pos
    a = np.frombuffer(raw, "<f4", n, pos).copy(); pos += n * 4
    return a

ops, chunks, offset = [], [], 0
for ln in lines[2:]:
    if not ln.strip(): continue
    p = ln.split()
    typ, name, nin, nout = p[0], p[1], int(p[2]), int(p[3])
    ins, outs = p[4:4 + nin], p[4 + nin:4 + nin + nout]
    kv = {}
    for t in p[4 + nin + nout:]:
        k, v = t.split("=", 1); kv[k] = v
    if typ == "Input":
        ops.append({"op": "input", "out": outs[0]})
    elif typ == "Split":
        ops.append({"op": "split", "in": ins[0], "out": outs})
    elif typ == "Concat":
        assert kv.get("0", "0") == "0"
        ops.append({"op": "concat", "in": ins, "out": outs[0]})
    elif typ == "Convolution":
        oc, k = int(kv["0"]), int(kv["1"])
        assert kv.get("2", "1") == "1" and kv.get("3", "1") == "1" and kv["4"] == "1" and kv["5"] == "1"
        n = int(kv["6"]); ic = n // (oc * k * k)
        w = read_weight(n).reshape(oc, ic, k, k).transpose(2, 3, 1, 0)  # → [kh, kw, in, out]
        b = read_bias(oc)
        act = kv.get("9", "0")
        slope = float(kv["-23310"].split(",")[1]) if act == "2" else None
        assert act in ("0", "2")
        ops.append({"op": "conv", "in": ins[0], "out": outs[0], "k": k, "ic": ic, "oc": oc,
                    "w": offset, "b": offset + w.size, "lrelu": slope})
        chunks += [w.ravel(), b]; offset += w.size + b.size
    elif typ == "Eltwise":
        assert kv["0"] == "1"
        coeffs = [float(x) for x in kv["-23301"].split(",")[1:]]
        ops.append({"op": "add", "in": ins, "out": outs[0], "coeffs": coeffs})
    elif typ == "BinaryOp":
        assert kv.get("0", "0") == "0"
        ops.append({"op": "add", "in": ins, "out": outs[0], "coeffs": [1.0, 1.0]})
    elif typ == "Interp":
        assert kv["0"] == "1"
        ops.append({"op": "up", "in": ins[0], "out": outs[0], "scale": float(kv["1"])})
    else:
        raise SystemExit(f"unsupported layer {typ}")

assert pos == len(raw), (pos, len(raw))
weights = np.concatenate(chunks).astype(np.float16)
weights.tofile(out_prefix + ".bin")
json.dump({"scale": 4, "count": int(weights.size), "ops": ops}, open(out_prefix + ".json", "w"), separators=(",", ":"))
print(f"{len(ops)} ops, {weights.size:,} weights, {weights.nbytes/1e6:.1f} MB")
