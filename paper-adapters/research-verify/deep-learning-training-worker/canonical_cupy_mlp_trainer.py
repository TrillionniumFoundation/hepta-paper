#!/usr/bin/env python3
"""Fixed declarative CuPy MLP trainer.

This executable deliberately has no module, source, callback, pickle, custom
operator, or custom CUDA loading surface.  It consumes one exact JSON request
from stdin and emits a fixed set of non-executable artifacts.
"""

import argparse
import hashlib
import json
import math
import os
import re
import struct
import subprocess
import sys

os.environ["CUBLAS_WORKSPACE_CONFIG"] = ":4096:8"
os.environ["NVIDIA_TF32_OVERRIDE"] = "0"

import cupy as cp
import numpy as np


MAXIMUM_REQUEST_BYTES = 64 * 1024 * 1024
MAXIMUM_PARAMETER_COUNT = 2_000_000
MAXIMUM_TRAINING_STEPS = 1_000_000
FLOAT32_BYTES = 4
INT64_BYTES = 8
CUDA_RUNTIME_RESERVE_BYTES = 512 * 1024 ** 2
MINIMUM_UNALLOCATED_HEADROOM_BYTES = 1024 ** 3
PARAMETER_STATE_MULTIPLIER = 12
WORKSPACE_TENSOR_MULTIPLIER = 8
GPU_UUID = re.compile(
    r"^GPU-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
)
SHA256 = re.compile(r"^sha256:[0-9a-f]{64}$")


def fail(message):
    raise ValueError(message)


def exact_keys(value, keys, error):
    if type(value) is not dict or set(value.keys()) != set(keys):
        fail(error)


def duplicate_safe_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            fail("deep_learning_worker_duplicate_json_key")
        result[key] = value
    return result


def parse_json_bytes(data):
    if len(data) == 0 or len(data) > MAXIMUM_REQUEST_BYTES:
        fail("deep_learning_worker_request_size_invalid")
    return json.loads(
        data.decode("utf-8"),
        object_pairs_hook=duplicate_safe_object,
        parse_constant=lambda value: fail(
            "deep_learning_worker_non_finite_json_number"
        ),
    )


def sha256_bytes(data):
    return "sha256:" + hashlib.sha256(data).hexdigest()


def hash_record(kind, value):
    return sha256_bytes(
        json.dumps(
            {"kind": kind, "value": value},
            allow_nan=False,
            ensure_ascii=True,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")
    )


def write_exclusive(path, data):
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    descriptor = os.open(path, flags, 0o600)
    try:
        view = memoryview(data)
        while len(view):
            written = os.write(descriptor, view)
            if written <= 0:
                fail("deep_learning_worker_artifact_write_failed")
            view = view[written:]
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def canonical_json_bytes(value):
    return json.dumps(
        value,
        allow_nan=False,
        ensure_ascii=True,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8") + b"\n"


def write_json_exclusive(path, value):
    write_exclusive(path, canonical_json_bytes(value))


def validate_profile(profile):
    if (
        type(profile) is not dict
        or profile.get("version") != 1
        or profile.get("kind")
        != "DeterministicSupervisedClassificationGpuProfile"
        or profile.get("profileId")
        != "cupy-single-gpu-supervised-classification-fp32-v1"
        or profile.get("runtimeProfile") != "pythonGpu"
        or profile.get("framework") != "cupy"
        or profile.get("modelFamily") != "declarative-sequential-mlp-v1"
        or profile.get("task") != "supervised-classification"
        or profile.get("devicePolicy", {}).get("deviceCount") != 1
        or profile.get("numericPolicy", {}).get("computeDtype") != "float32"
        or profile.get("numericPolicy", {}).get(
            "automaticMixedPrecisionEnabled"
        )
        is not False
        or profile.get("numericPolicy", {}).get("tensorFloat32Enabled")
        is not False
        or profile.get("extensionPolicy", {}).get("customCodeAllowed")
        is not False
        or profile.get("extensionPolicy", {}).get("customCudaAllowed")
        is not False
        or profile.get("checkpointPolicy", {}).get("pickleAllowed")
        is not False
    ):
        fail("deep_learning_worker_profile_invalid")


def validate_model_ir(model):
    if (
        type(model) is not dict
        or model.get("version") != 1
        or model.get("kind") != "DeterministicSupervisedClassificationModelIR"
        or model.get("modelFamily") != "declarative-sequential-mlp-v1"
        or model.get("task") != "supervised-classification"
        or model.get("executableCodeEmbedded") is not False
        or model.get("customOperatorsAllowed") is not False
        or model.get("operatorAllowlist") != ["dense", "relu", "identity"]
        or type(model.get("seed")) is not int
        or model.get("seed") < 0
        or model.get("seed") > 0xFFFFFFFF
        or type(model.get("parameterCount")) is not int
        or model.get("parameterCount") < 1
        or model.get("parameterCount") > MAXIMUM_PARAMETER_COUNT
    ):
        fail("deep_learning_worker_model_ir_invalid")
    training = model.get("training")
    if (
        type(training) is not dict
        or training.get("optimizer") != "adamw-v1"
        or training.get("loss") != "sparse-cross-entropy-with-logits-v1"
        or training.get("initialization")
        != "stateless-sha256-box-muller-v1"
        or training.get("batchOrder") != "seeded-fisher-yates-v1"
        or training.get("earlyStoppingEnabled") is not False
    ):
        fail("deep_learning_worker_training_contract_invalid")
    layers = model.get("layers")
    if type(layers) is not list or not 2 <= len(layers) <= 16:
        fail("deep_learning_worker_layers_invalid")
    previous = model.get("inputFeatureCount")
    parameter_count = 0
    for index, layer in enumerate(layers):
        final = index == len(layers) - 1
        if (
            type(layer) is not dict
            or layer.get("type") != "dense"
            or layer.get("inputUnits") != previous
            or layer.get("useBias") is not True
            or layer.get("activation") != ("identity" if final else "relu")
            or type(layer.get("outputUnits")) is not int
            or not 1 <= layer.get("outputUnits") <= 1_000_000
        ):
            fail("deep_learning_worker_layer_invalid")
        previous = layer["outputUnits"]
        parameter_count += previous * layer["inputUnits"] + previous
    if previous != model.get("classCount") or parameter_count != model["parameterCount"]:
        fail("deep_learning_worker_model_shape_invalid")


def validate_dataset(dataset, model):
    expected = {
        "version",
        "kind",
        "datasetId",
        "sampleCount",
        "featureCount",
        "classCount",
        "datasetContentHash",
        "features",
        "labels",
        "deepLearningTrainingDatasetManifestHash",
    }
    if type(dataset) is not dict or set(dataset.keys()) != expected:
        fail("deep_learning_worker_dataset_invalid")
    features = dataset.get("features")
    labels = dataset.get("labels")
    if (
        type(features) is not list
        or type(labels) is not list
        or len(features) != dataset.get("sampleCount")
        or len(labels) != len(features)
        or len(features) < 2
        or dataset.get("featureCount") != model.get("inputFeatureCount")
        or dataset.get("classCount") != model.get("classCount")
    ):
        fail("deep_learning_worker_dataset_shape_invalid")
    for row in features:
        if (
            type(row) is not list
            or len(row) != model["inputFeatureCount"]
            or any(type(value) not in (int, float) or not math.isfinite(value) for value in row)
        ):
            fail("deep_learning_worker_dataset_feature_invalid")
    if any(type(label) is not int or not 0 <= label < model["classCount"] for label in labels):
        fail("deep_learning_worker_dataset_label_invalid")


def validate_dataset_authority(authority, dataset):
    expected = {
        "version",
        "kind",
        "status",
        "originClass",
        "trainingDatasetManifestHash",
        "datasetContentHash",
        "source",
        "license",
        "consent",
        "splitLineage",
        "externalAuthority",
        "externalAuthorityRequired",
        "datasetProductionUseAuthorized",
        "selfAuthorizesOverallProductionPromotion",
        "productionPromotionEligible",
        "blockers",
        "deepLearningTrainingDatasetAuthorityHash",
    }
    if (
        type(authority) is not dict
        or set(authority.keys()) != expected
        or authority.get("version") != 1
        or authority.get("kind") != "DeepLearningTrainingDatasetAuthorityBinding"
        or authority.get("status")
        != "deep_learning_training_dataset_authority_bound"
        or authority.get("originClass") != "canonical-synthetic-generated-v1"
        or authority.get("trainingDatasetManifestHash")
        != dataset.get("deepLearningTrainingDatasetManifestHash")
        or authority.get("datasetContentHash") != dataset.get("datasetContentHash")
        or authority.get("externalAuthority") is not None
        or authority.get("externalAuthorityRequired") is not False
        or authority.get("datasetProductionUseAuthorized") is not True
        or authority.get("selfAuthorizesOverallProductionPromotion") is not False
        or authority.get("productionPromotionEligible") is not False
        or type(authority.get("deepLearningTrainingDatasetAuthorityHash")) is not str
    ):
        fail("deep_learning_worker_dataset_authority_invalid")


def gpu_memory_estimate(model, dataset):
    layer_unit_sum = sum(layer["outputUnits"] for layer in model["layers"])
    sample_count = dataset["sampleCount"]
    dataset_resident = (
        sample_count * dataset["featureCount"] * FLOAT32_BYTES
        + sample_count * INT64_BYTES
        + sample_count * INT64_BYTES
    )
    parameter_state = (
        model["parameterCount"]
        * FLOAT32_BYTES
        * PARAMETER_STATE_MULTIPLIER
    )
    full_evaluation = (
        sample_count
        * (model["inputFeatureCount"] + layer_unit_sum * WORKSPACE_TENSOR_MULTIPLIER)
        * FLOAT32_BYTES
    )
    batch_size = min(model["training"]["batchSize"], sample_count)
    training_batch = (
        batch_size
        * (model["inputFeatureCount"] + layer_unit_sum * WORKSPACE_TENSOR_MULTIPLIER)
        * FLOAT32_BYTES
        + batch_size * INT64_BYTES * 2
    )
    subtotal = (
        dataset_resident
        + parameter_state
        + max(full_evaluation, training_batch)
        + CUDA_RUNTIME_RESERVE_BYTES
    )
    allocator_reserve = (subtotal + 3) // 4
    return {
        "datasetResidentBytes": dataset_resident,
        "parameterStateBytes": parameter_state,
        "fullDatasetEvaluationWorkspaceBytes": full_evaluation,
        "trainingBatchWorkspaceBytes": training_batch,
        "cudaRuntimeReserveBytes": CUDA_RUNTIME_RESERVE_BYTES,
        "allocatorSafetyReserveBytes": allocator_reserve,
        "estimatedPeakVramBytes": subtotal + allocator_reserve,
    }


def validate_gpu_memory_capacity_plan(plan, model, dataset, selector):
    keys = {
        "version", "kind", "estimatorId", "capacityPolicyId", "modelIrHash",
        "trainingDatasetManifestHash", "gpuDeviceSelector",
        "trainingDatasetShape",
        "gpuCapacityObservationHash", "gpuCapacityObservation",
        "observedGpuTotalMemoryBytes", "observedGpuFreeMemoryBytes",
        "datasetResidentBytes",
        "parameterStateBytes", "fullDatasetEvaluationWorkspaceBytes",
        "trainingBatchWorkspaceBytes", "cudaRuntimeReserveBytes",
        "allocatorSafetyReserveBytes", "estimatedPeakVramBytes",
        "maximumCapacityFractionNumerator", "maximumCapacityFractionDenominator",
        "minimumUnallocatedHeadroomBytes", "minimumObservedFreeHeadroomBytes",
        "maximumQualifiedWorkingSetBytes",
        "capacitySatisfied", "gpuMemoryIsolationClaimed",
        "multiTenantExclusivityClaimed", "gpuMemoryCapacityPlanHash",
    }
    observation_keys = {
        "version", "kind", "status", "gpuDeviceSelector",
        "reportedTotalMemoryMiB", "reportedFreeMemoryMiB",
        "reportedMemoryUnit", "totalMemoryBytes", "freeMemoryBytes",
        "observationMechanism", "capacityScope", "gpuMemoryIsolationClaimed",
        "multiTenantExclusivityClaimed",
        "nvidiaGpuDeviceCapacityObservationHash",
    }
    if type(plan) is not dict or set(plan.keys()) != keys:
        fail("deep_learning_worker_gpu_memory_capacity_plan_invalid")
    observation = plan.get("gpuCapacityObservation")
    if type(observation) is not dict or set(observation.keys()) != observation_keys:
        fail("deep_learning_worker_gpu_memory_capacity_observation_invalid")
    observation_payload = dict(observation)
    observation_hash = observation_payload.pop(
        "nvidiaGpuDeviceCapacityObservationHash", None
    )
    total_bytes = observation.get("reportedTotalMemoryMiB", 0) * 1024 ** 2
    free_bytes = observation.get("reportedFreeMemoryMiB", -1) * 1024 ** 2
    if (
        observation.get("version") != 1
        or observation.get("kind") != "NvidiaGpuDeviceCapacityObservation"
        or observation.get("status")
        != "nvidia_gpu_total_and_free_memory_capacity_observed"
        or observation.get("gpuDeviceSelector") != selector
        or type(observation.get("reportedTotalMemoryMiB")) is not int
        or observation.get("reportedTotalMemoryMiB") < 256
        or type(observation.get("reportedFreeMemoryMiB")) is not int
        or observation.get("reportedFreeMemoryMiB") < 0
        or observation.get("reportedFreeMemoryMiB")
        > observation.get("reportedTotalMemoryMiB")
        or observation.get("reportedMemoryUnit") != "MiB-binary-v1"
        or observation.get("totalMemoryBytes") != total_bytes
        or observation.get("freeMemoryBytes") != free_bytes
        or observation.get("observationMechanism")
        != "nvidia-smi-query-gpu-uuid-memory.total-memory.free-v1"
        or observation.get("capacityScope")
        != "physical-device-total-and-point-in-time-free-memory-not-exclusive-v1"
        or observation.get("gpuMemoryIsolationClaimed") is not False
        or observation.get("multiTenantExclusivityClaimed") is not False
        or observation_hash
        != hash_record("NvidiaGpuDeviceCapacityObservation", observation_payload)
    ):
        fail("deep_learning_worker_gpu_memory_capacity_observation_invalid")
    components = gpu_memory_estimate(model, dataset)
    maximum_working_set = min(
        total_bytes * 3 // 4,
        max(0, total_bytes - 1024 ** 3),
        max(0, free_bytes - 512 * 1024 ** 2),
    )
    plan_payload = dict(plan)
    plan_hash = plan_payload.pop("gpuMemoryCapacityPlanHash", None)
    if (
        plan.get("version") != 1
        or plan.get("kind") != "CanonicalCupyDeepLearningGpuMemoryCapacityPlan"
        or plan.get("estimatorId") != "conservative-cupy-fp32-mlp-peak-vram-v1"
        or plan.get("capacityPolicyId")
        != "bounded-shared-gpu-total-and-free-capacity-headroom-v2"
        or plan.get("modelIrHash") != model.get("deepLearningModelIrHash")
        or plan.get("trainingDatasetManifestHash")
        != dataset.get("deepLearningTrainingDatasetManifestHash")
        or plan.get("trainingDatasetShape")
        != {
            "sampleCount": dataset["sampleCount"],
            "featureCount": dataset["featureCount"],
            "classCount": dataset["classCount"],
        }
        or plan.get("gpuDeviceSelector") != selector
        or plan.get("gpuCapacityObservationHash") != observation_hash
        or plan.get("observedGpuTotalMemoryBytes") != total_bytes
        or plan.get("observedGpuFreeMemoryBytes") != free_bytes
        or any(plan.get(key) != value for key, value in components.items())
        or plan.get("maximumCapacityFractionNumerator") != 3
        or plan.get("maximumCapacityFractionDenominator") != 4
        or plan.get("minimumUnallocatedHeadroomBytes") != 1024 ** 3
        or plan.get("minimumObservedFreeHeadroomBytes") != 512 * 1024 ** 2
        or plan.get("maximumQualifiedWorkingSetBytes") != maximum_working_set
        or plan.get("capacitySatisfied")
        is not (components["estimatedPeakVramBytes"] <= maximum_working_set)
        or plan.get("capacitySatisfied") is not True
        or plan.get("gpuMemoryIsolationClaimed") is not False
        or plan.get("multiTenantExclusivityClaimed") is not False
        or plan_hash
        != hash_record("CanonicalCupyDeepLearningGpuMemoryCapacityPlan", plan_payload)
    ):
        fail("deep_learning_worker_gpu_memory_capacity_plan_invalid")


def deterministic_uniforms(seed, name, count):
    values = np.empty(count + (count % 2), dtype=np.float64)
    cursor = 0
    counter = 0
    prefix = (str(seed) + "\0" + name + "\0").encode("utf-8")
    while cursor < values.size:
        digest = hashlib.sha256(prefix + str(counter).encode("ascii")).digest()
        for integer in struct.unpack(">8I", digest):
            if cursor >= values.size:
                break
            values[cursor] = (integer + 0.5) / 4294967296.0
            cursor += 1
        counter += 1
    result = np.empty(values.size, dtype=np.float64)
    pairs = values.reshape(-1, 2)
    radius = np.sqrt(-2.0 * np.log(pairs[:, 0]))
    angle = 2.0 * np.pi * pairs[:, 1]
    result[0::2] = radius * np.cos(angle)
    result[1::2] = radius * np.sin(angle)
    return result[:count]


def initialize_parameters(model):
    parameters = {}
    for layer in model["layers"]:
        weight_name = layer["layerId"] + ".weight"
        shape = (layer["outputUnits"], layer["inputUnits"])
        scale = math.sqrt(2.0 / layer["inputUnits"])
        host = deterministic_uniforms(model["seed"], weight_name, math.prod(shape))
        parameters[weight_name] = cp.asarray(
            (host * scale).astype(np.float32).reshape(shape)
        )
        parameters[layer["layerId"] + ".bias"] = cp.zeros(
            (layer["outputUnits"],), dtype=cp.float32
        )
    return parameters


def deterministic_permutation(count, seed, epoch):
    result = list(range(count))
    for current in range(count - 1, 0, -1):
        digest = hashlib.sha256(
            f"{seed}\0{epoch}\0{current}".encode("ascii")
        ).digest()
        selected = int.from_bytes(digest[:8], "big") % (current + 1)
        result[current], result[selected] = result[selected], result[current]
    return np.asarray(result, dtype=np.int64)


def forward(parameters, layers, inputs):
    activations = [inputs]
    preactivations = []
    current = inputs
    for layer in layers:
        preactivation = current @ parameters[layer["layerId"] + ".weight"].T
        preactivation = preactivation + parameters[layer["layerId"] + ".bias"]
        preactivations.append(preactivation)
        current = cp.maximum(preactivation, cp.float32(0.0)) if layer["activation"] == "relu" else preactivation
        activations.append(current)
    return current, activations, preactivations


def loss_accuracy_and_gradient(logits, labels):
    shifted = logits - cp.max(logits, axis=1, keepdims=True)
    exponentials = cp.exp(shifted)
    probabilities = exponentials / cp.sum(exponentials, axis=1, keepdims=True)
    rows = cp.arange(labels.shape[0])
    loss = -cp.mean(cp.log(probabilities[rows, labels]))
    predictions = cp.argmax(probabilities, axis=1)
    accuracy = cp.mean(predictions == labels)
    gradient = probabilities
    gradient[rows, labels] -= cp.float32(1.0)
    gradient /= cp.float32(labels.shape[0])
    return loss, accuracy, gradient


def evaluate(parameters, layers, features, labels):
    logits, _, _ = forward(parameters, layers, features)
    loss, accuracy, _ = loss_accuracy_and_gradient(logits, labels)
    return float(loss.get()), float(accuracy.get()), cp.argmax(logits, axis=1)


def train(model, dataset):
    features = cp.asarray(np.asarray(dataset["features"], dtype=np.float32))
    labels = cp.asarray(np.asarray(dataset["labels"], dtype=np.int64))
    parameters = initialize_parameters(model)
    optimizer = {
        name: {
            "m": cp.zeros_like(value),
            "v": cp.zeros_like(value),
        }
        for name, value in parameters.items()
    }
    training = model["training"]
    batch_size = min(training["batchSize"], len(dataset["features"]))
    steps_per_epoch = math.ceil(len(dataset["features"]) / batch_size)
    total_steps = steps_per_epoch * training["epochs"]
    if total_steps > MAXIMUM_TRAINING_STEPS:
        fail("deep_learning_worker_training_step_budget_exceeded")
    initial_loss, _, _ = evaluate(parameters, model["layers"], features, labels)
    trace = []
    step = 0
    last_gradient_norm = 0.0
    beta1 = training["beta1"]
    beta2 = training["beta2"]
    for epoch in range(1, training["epochs"] + 1):
        permutation = deterministic_permutation(len(dataset["features"]), model["seed"], epoch)
        for offset in range(0, len(permutation), batch_size):
            indices = cp.asarray(permutation[offset : offset + batch_size])
            batch_features = features[indices]
            batch_labels = labels[indices]
            logits, activations, preactivations = forward(
                parameters, model["layers"], batch_features
            )
            _, _, gradient = loss_accuracy_and_gradient(logits, batch_labels)
            gradients = {}
            for index in range(len(model["layers"]) - 1, -1, -1):
                layer = model["layers"][index]
                layer_id = layer["layerId"]
                gradients[layer_id + ".weight"] = gradient.T @ activations[index]
                gradients[layer_id + ".bias"] = cp.sum(gradient, axis=0)
                if index > 0:
                    gradient = gradient @ parameters[layer_id + ".weight"]
                    gradient = gradient * (preactivations[index - 1] > 0)
            squared_norm = cp.float64(0.0)
            for gradient_value in gradients.values():
                squared_norm += cp.sum(gradient_value.astype(cp.float64) ** 2)
            gradient_norm = float(cp.sqrt(squared_norm).get())
            clip_scale = min(1.0, training["gradientClipNorm"] / max(gradient_norm, 1e-30))
            step += 1
            for name in sorted(parameters):
                gradient_value = gradients[name] * cp.float32(clip_scale)
                state = optimizer[name]
                state["m"] = beta1 * state["m"] + (1.0 - beta1) * gradient_value
                state["v"] = beta2 * state["v"] + (1.0 - beta2) * (gradient_value ** 2)
                corrected_m = state["m"] / (1.0 - beta1 ** step)
                corrected_v = state["v"] / (1.0 - beta2 ** step)
                update = corrected_m / (cp.sqrt(corrected_v) + training["epsilon"])
                update = update + training["weightDecay"] * parameters[name]
                parameters[name] -= training["learningRate"] * update
            last_gradient_norm = gradient_norm
        epoch_loss, epoch_accuracy, _ = evaluate(
            parameters, model["layers"], features, labels
        )
        epoch_gradient_norm = last_gradient_norm
        if not all(math.isfinite(value) for value in (epoch_loss, epoch_accuracy, epoch_gradient_norm)):
            fail("deep_learning_worker_non_finite_training_metric")
        trace.append(
            {
                "epoch": epoch,
                "accuracy": epoch_accuracy,
                "crossEntropy": epoch_loss,
                "gradientNorm": epoch_gradient_norm,
            }
        )
    final_loss, final_accuracy, predictions = evaluate(
        parameters, model["layers"], features, labels
    )
    return parameters, trace, step, {
        "accuracy": final_accuracy,
        "crossEntropy": final_loss,
        "initialCrossEntropy": initial_loss,
        "gradientNorm": trace[-1]["gradientNorm"],
    }, cp.asnumpy(predictions).astype(np.int64).tolist()


def version_string(value):
    integer = int(value)
    return f"{integer // 1000}.{(integer % 1000) // 10}"


def nvidia_smi_runtime_observation(selector):
    result = subprocess.run(
        [
            "nvidia-smi",
            "--query-gpu=uuid,driver_version",
            "--format=csv,noheader,nounits",
        ],
        check=True,
        capture_output=True,
        text=True,
        timeout=5,
    )
    rows = [line.strip().split(",", 1) for line in result.stdout.splitlines() if line.strip()]
    if len(rows) != 1 or len(rows[0]) != 2 or rows[0][0].strip() != selector:
        fail("deep_learning_worker_gpu_uuid_observation_invalid")
    version = rows[0][1].strip()
    if not version:
        fail("deep_learning_worker_gpu_driver_observation_invalid")
    return version


def runtime_observation(selector):
    if not GPU_UUID.fullmatch(selector):
        fail("deep_learning_worker_gpu_uuid_not_pinned")
    if cp.cuda.runtime.getDeviceCount() != 1:
        fail("deep_learning_worker_gpu_device_count_invalid")
    observed_driver_version = nvidia_smi_runtime_observation(selector)
    properties = cp.cuda.runtime.getDeviceProperties(0)
    model = properties["name"]
    if isinstance(model, bytes):
        model = model.decode("utf-8")
    return {
        "framework": "cupy",
        "frameworkVersion": cp.__version__,
        "cudaDriverVersion": observed_driver_version,
        "cudaRuntimeVersion": version_string(cp.cuda.runtime.runtimeGetVersion()),
        "gpuComputeCapability": f"{properties['major']}.{properties['minor']}",
        "gpuDeviceSelector": selector,
        "gpuModel": str(model),
        "trainingComputeDevice": "cuda:0-single-visible-device-v1",
    }


def tensor_bundle(parameters):
    chunks = []
    descriptors = []
    for name in sorted(parameters):
        host = cp.asnumpy(parameters[name]).astype("<f4", copy=False)
        if not np.isfinite(host).all():
            fail("deep_learning_worker_checkpoint_non_finite")
        data = host.tobytes(order="C")
        chunks.append(data)
        descriptors.append(
            {
                "name": name,
                "dtype": "float32",
                "shape": list(host.shape),
                "byteLength": len(data),
                "sha256": sha256_bytes(data),
            }
        )
    return b"".join(chunks), descriptors


def main():
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    request = parse_json_bytes(sys.stdin.buffer.read(MAXIMUM_REQUEST_BYTES + 1))
    request_keys = [
            "version",
            "kind",
            "trainingRunId",
            "gpuDeviceSelector",
            "absoluteDeadlineEpochMs",
            "profile",
            "modelIr",
            "trainingDataset",
            "trainingDatasetAuthority",
            "gpuMemoryCapacityPlan",
        ]
    if "executionAuthorityHash" in request:
        request_keys.append("executionAuthorityHash")
    exact_keys(
        request,
        request_keys,
        "deep_learning_worker_request_invalid",
    )
    if request["version"] != 1 or request["kind"] != "CanonicalCupyMlpTrainingRequest":
        fail("deep_learning_worker_request_version_invalid")
    if (
        type(request["absoluteDeadlineEpochMs"]) is not int
        or request["absoluteDeadlineEpochMs"] < 1
        or request["absoluteDeadlineEpochMs"] > 9007199254740991
    ):
        fail("deep_learning_worker_deadline_invalid")
    if not GPU_UUID.fullmatch(request["gpuDeviceSelector"]):
        fail("deep_learning_worker_gpu_uuid_not_pinned")
    if (
        "executionAuthorityHash" in request
        and not SHA256.fullmatch(request["executionAuthorityHash"])
    ):
        fail("deep_learning_worker_execution_authority_invalid")
    if (
        type(request["absoluteDeadlineEpochMs"]) is not int
        or request["absoluteDeadlineEpochMs"] < 1
    ):
        fail("deep_learning_worker_absolute_deadline_invalid")
    validate_profile(request["profile"])
    validate_model_ir(request["modelIr"])
    validate_dataset(request["trainingDataset"], request["modelIr"])
    validate_dataset_authority(
        request["trainingDatasetAuthority"], request["trainingDataset"]
    )
    validate_gpu_memory_capacity_plan(
        request["gpuMemoryCapacityPlan"],
        request["modelIr"],
        request["trainingDataset"],
        request["gpuDeviceSelector"],
    )
    if request["profile"]["deepLearningGpuProfileHash"] != request["modelIr"]["profileHash"]:
        fail("deep_learning_worker_profile_binding_invalid")
    if str(request["modelIr"]["seed"]) != os.environ.get("HEPTA_SEED"):
        fail("deep_learning_worker_seed_binding_invalid")
    output = os.path.realpath(args.output)
    if output != "/output" or not os.path.isdir(output) or os.path.islink(args.output):
        fail("deep_learning_worker_output_root_invalid")
    parameters, trace, steps, metrics, predictions = train(
        request["modelIr"], request["trainingDataset"]
    )
    bundle, tensors = tensor_bundle(parameters)
    runtime = runtime_observation(request["gpuDeviceSelector"])
    model_spec = {
        "version": 1,
        "kind": "DeepLearningModelSpecification",
        "profile": request["profile"],
        "modelIr": request["modelIr"],
    }
    trace_document = {
        "version": 1,
        "kind": "DeepLearningTrainingMetricTrace",
        "trainingRunId": request["trainingRunId"],
        "modelIrHash": request["modelIr"]["deepLearningModelIrHash"],
        "trainingDatasetManifestHash": request["trainingDataset"][
            "deepLearningTrainingDatasetManifestHash"
        ],
        "records": trace,
    }
    predictions_document = {
        "version": 1,
        "kind": "DeepLearningTrainingPredictions",
        "trainingRunId": request["trainingRunId"],
        "modelIrHash": request["modelIr"]["deepLearningModelIrHash"],
        "trainingDatasetManifestHash": request["trainingDataset"][
            "deepLearningTrainingDatasetManifestHash"
        ],
        "scope": "training-dataset-only-not-hidden-evaluation-v1",
        "predictedClass": predictions,
    }
    summary = {
        "version": 1,
        "kind": "CanonicalCupyMlpTrainingSummary",
        "trainingRunId": request["trainingRunId"],
        "profileHash": request["profile"]["deepLearningGpuProfileHash"],
        "modelIrHash": request["modelIr"]["deepLearningModelIrHash"],
        "trainingDatasetManifestHash": request["trainingDataset"][
            "deepLearningTrainingDatasetManifestHash"
        ],
        "seed": request["modelIr"]["seed"],
        "completedEpoch": request["modelIr"]["training"]["epochs"],
        "trainingStepCount": steps,
        "tensorBundleArtifactBytes": len(bundle),
        "tensors": tensors,
        "finalMetrics": metrics,
        "trainingPredictionCount": len(predictions),
        "gpuMemoryCapacityPlanHash": request["gpuMemoryCapacityPlan"][
            "gpuMemoryCapacityPlanHash"
        ],
        "runtime": runtime,
        "networkActionPerformed": False,
        "externalActionPerformed": False,
        "hiddenEvaluationPerformed": False,
    }
    artifacts = {
        "model-spec.json": canonical_json_bytes(model_spec),
        "training-trace.json": canonical_json_bytes(trace_document),
        "training-summary.json": canonical_json_bytes(summary),
        "training-predictions.json": canonical_json_bytes(predictions_document),
        "tensor-bundle.bin": bundle,
    }
    for name in sorted(artifacts):
        write_exclusive(os.path.join(output, name), artifacts[name])
    directory_descriptor = os.open(output, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(directory_descriptor)
    finally:
        os.close(directory_descriptor)


if __name__ == "__main__":
    main()
