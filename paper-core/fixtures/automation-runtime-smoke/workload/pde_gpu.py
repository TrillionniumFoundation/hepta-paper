import json
import math
import os

os.environ.setdefault("CUBLAS_WORKSPACE_CONFIG", ":4096:8")

import cupy as cp


def apply_negative_laplacian(field, spacing):
    padded = cp.pad(field, 1, mode="constant")
    return (
        (4.0 * field)
        - padded[:-2, 1:-1]
        - padded[2:, 1:-1]
        - padded[1:-1, :-2]
        - padded[1:-1, 2:]
    ) / (spacing * spacing)


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
grid_size = 64
spacing = 1.0 / (grid_size + 1)
axis = cp.arange(1, grid_size + 1, dtype=cp.float64) * spacing
x, y = cp.meshgrid(axis, axis, indexing="ij")

modes = ((1, 1, 1.0), (2, 3, 0.1), (4, 2, -0.04), (3, 5, 0.02))
exact = cp.zeros_like(x)
forcing = cp.zeros_like(x)
for mode_x, mode_y, amplitude in modes:
    component = cp.sin(mode_x * math.pi * x) * cp.sin(mode_y * math.pi * y)
    exact += amplitude * component
    forcing += amplitude * (math.pi**2) * (mode_x**2 + mode_y**2) * component

# Matrix-free conjugate gradient solves the finite-difference Poisson system on
# the GPU. The analytic manufactured solution remains host-independent oracle
# data and is not used by the iteration itself.
solution = cp.zeros_like(forcing)
residual = forcing.copy()
direction = residual.copy()
residual_energy = cp.vdot(residual, residual).real
initial_energy = float(cp.asnumpy(residual_energy))
iterations = 0
for iteration in range(1, 257):
    image = apply_negative_laplacian(direction, spacing)
    step = residual_energy / cp.vdot(direction, image).real
    solution += step * direction
    residual -= step * image
    next_energy = cp.vdot(residual, residual).real
    iterations = iteration
    if float(cp.asnumpy(next_energy)) <= initial_energy * 1e-22:
        residual_energy = next_energy
        break
    direction = residual + (next_energy / residual_energy) * direction
    residual_energy = next_energy

relative_residual = math.sqrt(float(cp.asnumpy(residual_energy)) / initial_energy)
relative_l2_error = float(cp.asnumpy(cp.linalg.norm(solution - exact) / cp.linalg.norm(exact)))
linf_error = float(cp.asnumpy(cp.max(cp.abs(solution - exact))))
assert relative_residual < 1e-9
assert relative_l2_error < 0.01

output = os.environ["HEPTA_OUTPUT_DIR"]
solution_bytes = cp.asnumpy(solution).astype("<f8", copy=False).tobytes(order="C")
with open(os.path.join(output, "solution.bin"), "wb") as handle:
    handle.write(solution_bytes)

values = {
    "device": int(cp.cuda.runtime.getDevice()),
    "device_uuid": observed_device_uuid,
    "grid_size": grid_size,
    "iterations": iterations,
    "linf_error": linf_error,
    "relative_l2_error": relative_l2_error,
    "relative_residual": relative_residual,
}
with open(os.path.join(output, "results.json"), "w", encoding="utf-8") as handle:
    json.dump(values, handle, sort_keys=True)
with open(os.path.join(output, "results.csv"), "w", encoding="utf-8") as handle:
    handle.write("metric,value\n")
    for name in sorted(values):
        handle.write(f"{name},{values[name]}\n")
