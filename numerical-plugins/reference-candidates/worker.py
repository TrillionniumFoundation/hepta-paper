#!/usr/bin/env python3
import argparse
import base64
import hashlib
import json
import math
import os
import random


def normalize_json_number(value):
    if isinstance(value, list):
        return [normalize_json_number(item) for item in value]
    if isinstance(value, dict):
        return {key: normalize_json_number(item) for key, item in value.items()}
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError("canonical_number_not_finite")
        if value == 0:
            return 0
        if value.is_integer() and abs(value) <= 9_007_199_254_740_991:
            return int(value)
    return value


def canonical(value):
    return json.dumps(
        normalize_json_number(value),
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    )


def digest(value):
    return "sha256:" + hashlib.sha256(canonical(value).encode("utf-8")).hexdigest()


def hash_record(kind, value):
    return digest({"kind": kind, "value": value})


def finite_number(value, name):
    selected = float(value)
    if not math.isfinite(selected):
        raise ValueError(f"{name}_not_finite")
    return selected


def finite_vector(value, name):
    if not isinstance(value, list) or not value:
        raise ValueError(f"{name}_invalid")
    return [finite_number(item, name) for item in value]


def square_matrix(value, name):
    if not isinstance(value, list) or not value:
        raise ValueError(f"{name}_invalid")
    rows = [finite_vector(row, name) for row in value]
    if any(len(row) != len(rows) for row in rows):
        raise ValueError(f"{name}_not_square")
    return rows


def solve_linear_system(matrix, vector):
    size = len(matrix)
    if len(vector) != size:
        raise ValueError("linear_algebra_dimension_mismatch")
    augmented = [matrix[row][:] + [vector[row]] for row in range(size)]
    pivots = []
    for column in range(size):
        pivot_row = max(range(column, size), key=lambda row: abs(augmented[row][column]))
        pivot = augmented[pivot_row][column]
        if abs(pivot) <= 1e-12:
            raise ValueError("linear_algebra_singular")
        augmented[column], augmented[pivot_row] = augmented[pivot_row], augmented[column]
        pivots.append(abs(pivot))
        scale = augmented[column][column]
        augmented[column] = [value / scale for value in augmented[column]]
        for row in range(size):
            if row == column:
                continue
            factor = augmented[row][column]
            augmented[row] = [
                augmented[row][index] - factor * augmented[column][index]
                for index in range(size + 1)
            ]
    solution = [augmented[row][-1] for row in range(size)]
    residual = [
        sum(matrix[row][column] * solution[column] for column in range(size)) - vector[row]
        for row in range(size)
    ]
    residual_norm = max(abs(value) for value in residual)
    pivot_ratio = max(pivots) / min(pivots)
    return {
        "solution": solution,
        "residualInfinityNorm": residual_norm,
        "pivotRatio": pivot_ratio,
    }


def linear_algebra(input_value):
    matrix = square_matrix(input_value.get("matrix"), "matrix")
    vector = finite_vector(input_value.get("vector"), "vector")
    solved = solve_linear_system(matrix, vector)
    estimate = {"kind": "LinearAlgebraEstimate", "solution": solved["solution"]}
    uncertainty = {
        "kind": "ResidualAndPivotUncertainty",
        "residualInfinityNorm": solved["residualInfinityNorm"],
        "pivotRatio": solved["pivotRatio"],
    }
    oracle = {
        "kind": "LinearSystemResidualOracle",
        "accepted": solved["residualInfinityNorm"] <= finite_number(
            input_value.get("residualTolerance", 1e-9),
            "residualTolerance",
        ),
        "residualInfinityNorm": solved["residualInfinityNorm"],
    }
    return estimate, uncertainty, oracle


def monte_carlo(input_value, seed):
    sample_count = int(input_value.get("sampleCount", 0))
    if sample_count < 100 or sample_count > 1_000_000:
        raise ValueError("monte_carlo_sample_count_invalid")
    integrand = str(input_value.get("integrand", "exp-neg-square"))
    generator = random.Random(seed)
    observations = []
    for _ in range(sample_count):
        if integrand == "exp-neg-square":
            point = generator.random()
            observations.append(math.exp(-(point * point)))
        elif integrand == "unit-circle":
            left = generator.uniform(-1.0, 1.0)
            right = generator.uniform(-1.0, 1.0)
            observations.append(4.0 if left * left + right * right <= 1.0 else 0.0)
        else:
            raise ValueError("monte_carlo_integrand_invalid")
    estimate_value = sum(observations) / sample_count
    variance = sum((value - estimate_value) ** 2 for value in observations) / (sample_count - 1)
    standard_error = math.sqrt(variance / sample_count)
    estimate = {
        "kind": "MonteCarloEstimate",
        "integrand": integrand,
        "sampleCount": sample_count,
        "value": estimate_value,
    }
    uncertainty = {
        "kind": "MonteCarloNormalApproximation",
        "standardError": standard_error,
        "lower95": estimate_value - 1.96 * standard_error,
        "upper95": estimate_value + 1.96 * standard_error,
    }
    oracle = {
        "kind": "MonteCarloFiniteSampleOracle",
        "accepted": math.isfinite(estimate_value) and math.isfinite(standard_error),
        "sampleCount": sample_count,
        "seed": seed,
    }
    return estimate, uncertainty, oracle


def quadratic_objective(matrix, vector, point):
    quadratic = 0.5 * sum(
        point[row] * matrix[row][column] * point[column]
        for row in range(len(point))
        for column in range(len(point))
    )
    return quadratic + sum(vector[index] * point[index] for index in range(len(point)))


def optimization(input_value):
    matrix = square_matrix(input_value.get("quadratic"), "quadratic")
    vector = finite_vector(input_value.get("linear"), "linear")
    if len(vector) != len(matrix):
        raise ValueError("optimization_dimension_mismatch")
    iterations = int(input_value.get("iterations", 1000))
    step_size = finite_number(input_value.get("stepSize", 0.01), "stepSize")
    if iterations < 1 or iterations > 1_000_000 or step_size <= 0:
        raise ValueError("optimization_budget_invalid")
    point = [0.0 for _ in vector]
    for _ in range(iterations):
        gradient = [
            sum(matrix[row][column] * point[column] for column in range(len(point))) + vector[row]
            for row in range(len(point))
        ]
        point = [point[index] - step_size * gradient[index] for index in range(len(point))]
        if not all(math.isfinite(value) for value in point):
            raise ValueError("optimization_diverged")
    gradient = [
        sum(matrix[row][column] * point[column] for column in range(len(point))) + vector[row]
        for row in range(len(point))
    ]
    gradient_norm = math.sqrt(sum(value * value for value in gradient))
    estimate = {
        "kind": "ConvexQuadraticEstimate",
        "minimizer": point,
        "objective": quadratic_objective(matrix, vector, point),
    }
    uncertainty = {
        "kind": "FirstOrderResidualUncertainty",
        "gradientNorm": gradient_norm,
        "iterations": iterations,
        "stepSize": step_size,
    }
    oracle = {
        "kind": "FirstOrderOptimalityOracle",
        "accepted": gradient_norm <= finite_number(
            input_value.get("gradientTolerance", 1e-6),
            "gradientTolerance",
        ),
        "gradientNorm": gradient_norm,
    }
    return estimate, uncertainty, oracle


def analyze(request):
    family = request.get("analysisFamily")
    input_value = request.get("input")
    if not isinstance(input_value, dict):
        raise ValueError("advanced_numerical_input_invalid")
    seed = int(request.get("seed"))
    if family == "linear-algebra":
        return linear_algebra(input_value)
    if family == "monte-carlo":
        return monte_carlo(input_value, seed)
    if family == "optimization":
        return optimization(input_value)
    raise ValueError("advanced_numerical_reference_family_unsupported")


def build_result(request):
    estimate, uncertainty, oracle = analyze(request)
    estimate_hash = hash_record("AdvancedNumericalEstimateArtifact", estimate)
    replay = {
        "kind": "DeterministicReferenceReplay",
        "analysisFamily": request["analysisFamily"],
        "requestHash": request["advancedNumericalPluginRequestHash"],
        "seed": request["seed"],
        "estimateHash": estimate_hash,
    }
    payload = {
        "version": 1,
        "kind": "AdvancedNumericalPluginResult",
        "status": "advanced_numerical_computation_completed",
        "pluginId": request["pluginId"],
        "analysisFamily": request["analysisFamily"],
        "requestHash": request["advancedNumericalPluginRequestHash"],
        "oracleContractHash": request["assuranceContracts"]["oracle"]["contractHash"],
        "replayContractHash": request["assuranceContracts"]["replay"]["contractHash"],
        "uncertaintyContractHash": request["assuranceContracts"]["uncertainty"]["contractHash"],
        "estimateArtifactHash": estimate_hash,
        "uncertaintyArtifactHash": hash_record("AdvancedNumericalUncertaintyArtifact", uncertainty),
        "oracleReceiptHash": hash_record("AdvancedNumericalOracleReceipt", oracle),
        "replayReceiptHash": hash_record("AdvancedNumericalReplayReceipt", replay),
        "uncertaintyReceiptHash": hash_record(
            "AdvancedNumericalUncertaintyReceipt",
            {"estimate": estimate, "uncertainty": uncertainty},
        ),
        "estimate": estimate,
        "uncertainty": uncertainty,
        "oracle": oracle,
        "replay": replay,
        "qualificationStatus": "reference_candidate_unqualified",
    }
    return {
        **payload,
        "advancedNumericalPluginResultHash": hash_record(
            "AdvancedNumericalPluginResult",
            payload,
        ),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--hepta-request-base64", required=True)
    parser.add_argument("--hepta-output", required=True)
    args = parser.parse_args()
    request = json.loads(base64.b64decode(args.hepta_request_base64).decode("utf-8"))
    result = build_result(request)
    output_path = os.path.abspath(args.hepta_output)
    os.makedirs(os.path.dirname(output_path), mode=0o700, exist_ok=True)
    temporary_path = output_path + ".tmp"
    with open(temporary_path, "x", encoding="utf-8") as output:
        output.write(canonical(result) + "\n")
        output.flush()
        os.fsync(output.fileno())
    os.replace(temporary_path, output_path)


if __name__ == "__main__":
    main()
