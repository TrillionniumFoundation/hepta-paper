import json
import os

import cupy as cp

x = cp.arange(1024, dtype=cp.float32)
y = x * x
value = float(cp.asnumpy(y[17]))
assert value == 289.0
output = os.environ["HEPTA_OUTPUT_DIR"]
with open(os.path.join(output, "results.json"), "w", encoding="utf-8") as handle:
    json.dump(
        {"cupy_square_17": value, "device": int(cp.cuda.runtime.getDevice())},
        handle,
        sort_keys=True,
    )
with open(os.path.join(output, "results.csv"), "w", encoding="utf-8") as handle:
    handle.write(f"metric,value\ncupy_square_17,{value}\n")
