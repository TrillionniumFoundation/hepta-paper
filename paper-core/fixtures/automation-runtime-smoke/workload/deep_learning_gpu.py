import hashlib
import json
import os

os.environ.setdefault("CUBLAS_WORKSPACE_CONFIG", ":4096:8")

import cupy as cp
import numpy as np


device_count = int(cp.cuda.runtime.getDeviceCount())
assert device_count == 1
expected_device_uuid = (
    os.environ["NVIDIA_VISIBLE_DEVICES"]
    .removeprefix("GPU-")
    .replace("-", "")
    .lower()
)
observed_device_uuid = bytes(
    cp.cuda.runtime.getDeviceProperties(0)["uuid"]
).hex().lower()
assert observed_device_uuid == expected_device_uuid

# A deterministic, genuinely nonlinear classification problem. Initial
# parameters are generated on the CPU so their bytes do not depend on a CuPy
# random-generator implementation, then all forward/backward optimization runs
# on the selected GPU.
axis = np.linspace(-1.0, 1.0, 32, dtype=np.float64)
x0, x1 = np.meshgrid(axis, axis, indexing="ij")
features_host = np.column_stack((x0.ravel(), x1.ravel()))
labels_host = ((features_host[:, 0] * features_host[:, 1]) > 0).astype(np.float64).reshape(-1, 1)
features = cp.asarray(features_host)
labels = cp.asarray(labels_host)

rng = np.random.default_rng(42)
parameters = [
    cp.asarray(rng.normal(0.0, 0.35, (2, 16))),
    cp.zeros((1, 16), dtype=cp.float64),
    cp.asarray(rng.normal(0.0, 0.35, (16, 8))),
    cp.zeros((1, 8), dtype=cp.float64),
    cp.asarray(rng.normal(0.0, 0.35, (8, 1))),
    cp.zeros((1, 1), dtype=cp.float64),
]
first_moments = [cp.zeros_like(value) for value in parameters]
second_moments = [cp.zeros_like(value) for value in parameters]

initial_loss = None
epochs = 200
for epoch in range(1, epochs + 1):
    weight1, bias1, weight2, bias2, weight3, bias3 = parameters
    hidden1 = cp.tanh((features @ weight1) + bias1)
    hidden2 = cp.tanh((hidden1 @ weight2) + bias2)
    logits = (hidden2 @ weight3) + bias3
    probabilities = 1.0 / (1.0 + cp.exp(-cp.clip(logits, -30.0, 30.0)))
    loss = -cp.mean(
        (labels * cp.log(probabilities + 1e-12))
        + ((1.0 - labels) * cp.log(1.0 - probabilities + 1e-12))
    )
    if initial_loss is None:
        initial_loss = float(cp.asnumpy(loss))

    delta3 = (probabilities - labels) / features.shape[0]
    grad_weight3 = hidden2.T @ delta3
    grad_bias3 = cp.sum(delta3, axis=0, keepdims=True)
    delta2 = (delta3 @ weight3.T) * (1.0 - (hidden2 * hidden2))
    grad_weight2 = hidden1.T @ delta2
    grad_bias2 = cp.sum(delta2, axis=0, keepdims=True)
    delta1 = (delta2 @ weight2.T) * (1.0 - (hidden1 * hidden1))
    gradients = [
        features.T @ delta1,
        cp.sum(delta1, axis=0, keepdims=True),
        grad_weight2,
        grad_bias2,
        grad_weight3,
        grad_bias3,
    ]
    for index, (parameter, gradient) in enumerate(zip(parameters, gradients)):
        first_moments[index] = (0.9 * first_moments[index]) + (0.1 * gradient)
        second_moments[index] = (0.999 * second_moments[index]) + (0.001 * gradient * gradient)
        corrected_first = first_moments[index] / (1.0 - (0.9**epoch))
        corrected_second = second_moments[index] / (1.0 - (0.999**epoch))
        parameter -= 0.02 * corrected_first / (cp.sqrt(corrected_second) + 1e-8)

weight1, bias1, weight2, bias2, weight3, bias3 = parameters
hidden1 = cp.tanh((features @ weight1) + bias1)
hidden2 = cp.tanh((hidden1 @ weight2) + bias2)
probabilities = 1.0 / (1.0 + cp.exp(-cp.clip((hidden2 @ weight3) + bias3, -30.0, 30.0)))
final_loss = float(cp.asnumpy(-cp.mean(
    (labels * cp.log(probabilities + 1e-12))
    + ((1.0 - labels) * cp.log(1.0 - probabilities + 1e-12))
)))
accuracy = float(cp.asnumpy(cp.mean((probabilities >= 0.5) == labels)))
assert accuracy >= 0.99
assert final_loss < initial_loss * 0.05

checkpoint = b"".join(
    cp.asnumpy(parameter).astype("<f8", copy=False).tobytes(order="C")
    for parameter in parameters
)
checkpoint_hash = hashlib.sha256(checkpoint).hexdigest()
output = os.environ["HEPTA_OUTPUT_DIR"]
with open(os.path.join(output, "model.bin"), "wb") as handle:
    handle.write(checkpoint)

values = {
    "accuracy": accuracy,
    "device": int(cp.cuda.runtime.getDevice()),
    "device_uuid": observed_device_uuid,
    "epochs": epochs,
    "final_loss": final_loss,
    "initial_loss": initial_loss,
    "model_bytes": len(checkpoint),
    "model_sha256_prefix": int(checkpoint_hash[:13], 16),
    "parameter_count": int(sum(parameter.size for parameter in parameters)),
}
with open(os.path.join(output, "results.json"), "w", encoding="utf-8") as handle:
    json.dump(values, handle, sort_keys=True)
with open(os.path.join(output, "results.csv"), "w", encoding="utf-8") as handle:
    handle.write("metric,value\n")
    for name in sorted(values):
        handle.write(f"{name},{values[name]}\n")
