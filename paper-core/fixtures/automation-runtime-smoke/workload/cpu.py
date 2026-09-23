import json
import os
import random

import numpy as np
import pandas as pd
from sklearn.linear_model import LinearRegression

random.seed(42)
np.random.seed(42)
x = np.arange(20, dtype=float).reshape(-1, 1)
y = 3 * x[:, 0] + 2
model = LinearRegression().fit(x, y)
output = os.environ["HEPTA_OUTPUT_DIR"]
values = {
    "coefficient": float(model.coef_[0]),
    "intercept": float(model.intercept_),
}
pd.DataFrame({"metric": list(values), "value": list(values.values())}).to_csv(
    os.path.join(output, "results.csv"), index=False
)
with open(os.path.join(output, "results.json"), "w", encoding="utf-8") as handle:
    json.dump(values, handle, sort_keys=True)
