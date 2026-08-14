import json
import math
import os
import subprocess
import sys

os.environ.setdefault("CUBLAS_WORKSPACE_CONFIG", ":4096:8")

import cupy as cp
import numpy as np


GRID_SIZES = (31, 63, 127)
MODES = (
    {"amplitude": 1.0, "kx": 1, "ky": 1},
    {"amplitude": 0.25, "kx": 2, "ky": 3},
)


def fail(message):
    raise RuntimeError(message)


def read_request():
    request = json.load(sys.stdin)
    if request.get("version") != 1 or request.get("kind") != "CanonicalCupyPoisson2dRequest":
        fail("pde_gpu_request_contract_invalid")
    specification = request.get("producerSpecification", {})
    if specification.get("profileId") != "pde_poisson_2d_manufactured_solution_v1":
        fail("pde_gpu_profile_invalid")
    if specification.get("discretization", {}).get("gridSizes") != list(GRID_SIZES):
        fail("pde_gpu_grid_schedule_invalid")
    if specification.get("equation", {}).get("manufacturedModes") != list(MODES):
        fail("pde_gpu_manufactured_modes_invalid")
    if specification.get("runtime", {}).get("cpuFallback") != "forbidden":
        fail("pde_gpu_cpu_fallback_invalid")
    return request


def visible_gpu_uuid():
    completed = subprocess.run(
        ["nvidia-smi", "--query-gpu=uuid", "--format=csv,noheader"],
        check=True,
        capture_output=True,
        text=True,
        timeout=10,
    )
    observed = [line.strip() for line in completed.stdout.splitlines() if line.strip()]
    if len(observed) != 1 or not observed[0].startswith("GPU-"):
        fail("pde_gpu_visible_device_cardinality_invalid")
    if int(cp.cuda.runtime.getDeviceCount()) != 1:
        fail("pde_gpu_cupy_device_cardinality_invalid")
    return observed[0]


def apply_negative_laplacian(field, spacing):
    padded = cp.pad(field, 1, mode="constant")
    return (
        4.0 * field
        - padded[:-2, 1:-1]
        - padded[2:, 1:-1]
        - padded[1:-1, :-2]
        - padded[1:-1, 2:]
    ) / (spacing * spacing)


def solve(grid_size, modes):
    spacing = 1.0 / (grid_size + 1)
    axis = cp.arange(1, grid_size + 1, dtype=cp.float64) * spacing
    x, y = cp.meshgrid(axis, axis, indexing="xy")
    exact = cp.zeros((grid_size, grid_size), dtype=cp.float64)
    forcing = cp.zeros_like(exact)
    for mode in modes:
        basis = cp.sin(mode["kx"] * math.pi * x) * cp.sin(mode["ky"] * math.pi * y)
        eigenvalue = math.pi**2 * (mode["kx"] ** 2 + mode["ky"] ** 2)
        exact += mode["amplitude"] * basis
        forcing += mode["amplitude"] * eigenvalue * basis

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
        if float(cp.asnumpy(next_energy)) <= initial_energy * 1e-24:
            residual_energy = next_energy
            break
        direction = residual + (next_energy / residual_energy) * direction
        residual_energy = next_energy

    cp.cuda.Stream.null.synchronize()
    relative_residual = math.sqrt(float(cp.asnumpy(residual_energy)) / initial_energy)
    relative_error = float(cp.asnumpy(cp.linalg.norm(solution - exact) / cp.linalg.norm(exact)))
    if not math.isfinite(relative_residual) or not math.isfinite(relative_error):
        fail("pde_gpu_nonfinite_diagnostics")
    return (
        cp.asnumpy(solution).astype("<f8", copy=False),
        {
            "gridSize": grid_size,
            "iterations": iterations,
            "relativeContinuousL2Error": relative_error,
            "relativeDiscreteResidual": relative_residual,
        },
    )


def main():
    request = read_request()
    output_root = os.environ.get("HEPTA_OUTPUT_DIR")
    if not output_root:
        fail("pde_gpu_output_root_missing")
    os.makedirs(os.path.join(output_root, "solutions"), mode=0o700, exist_ok=False)
    uuid = visible_gpu_uuid()
    observations = []
    for grid_size in GRID_SIZES:
        solution, observation = solve(
            grid_size,
            request["producerSpecification"]["equation"]["manufacturedModes"],
        )
        target = os.path.join(output_root, "solutions", f"n{grid_size}.f64le")
        with open(target, "wb") as handle:
            handle.write(solution.tobytes(order="C"))
        observations.append(observation)
    diagnostics = {
        "version": 1,
        "kind": "CanonicalCupyPoisson2dProducerDiagnostics",
        "requestHash": request["requestHash"],
        "visibleGpuUuid": uuid,
        "observations": observations,
        "scientificAuthority": "non-authoritative-self-report-v1",
    }
    with open(os.path.join(output_root, "producer-diagnostics.json"), "w", encoding="utf-8") as handle:
        json.dump(diagnostics, handle, separators=(",", ":"), sort_keys=True)
        handle.write("\n")


if __name__ == "__main__":
    main()
