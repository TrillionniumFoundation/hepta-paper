#!/usr/bin/env python3
"""Small fail-closed JSON Schema Draft 2020-12 validator for checked-in contracts.

The validator intentionally supports only the assertion vocabulary used by this
repository. Encountering an unsupported assertion keyword is an error rather
than a silent ignore.
"""

from __future__ import annotations

import argparse
from datetime import datetime
import json
import math
from pathlib import Path
import re
import sys
from typing import Any

ANNOTATIONS = {
    "$schema", "$id", "$anchor", "title", "description", "default",
    "examples", "deprecated", "readOnly", "writeOnly", "$comment", "$defs",
}
ASSERTIONS = {
    "$ref", "type", "const", "enum", "required", "properties",
    "additionalProperties", "propertyNames", "minProperties", "maxProperties", "minItems",
    "maxItems", "uniqueItems", "items", "minLength", "maxLength", "pattern",
    "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "format",
    "allOf", "anyOf", "oneOf", "not", "if", "then", "else",
}
SUPPORTED = ANNOTATIONS | ASSERTIONS


class SchemaValidationError(ValueError):
    """Raised when a schema or instance is invalid."""


def fail(path: str, message: str) -> None:
    raise SchemaValidationError(f"{path}: {message}")


def canonical(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def json_equality_key(value: Any) -> tuple:
    """JSON structural equality: booleans are not numbers; 1 equals 1.0."""
    if value is None:
        return ("null",)
    if isinstance(value, bool):
        return ("boolean", value)
    if isinstance(value, (int, float)):
        if isinstance(value, float) and not math.isfinite(value):
            fail("$", "non-finite JSON number")
        return ("number", value)
    if isinstance(value, str):
        return ("string", value)
    if isinstance(value, list):
        return ("array", tuple(json_equality_key(item) for item in value))
    if isinstance(value, dict) and all(isinstance(key, str) for key in value):
        return ("object", tuple((key, json_equality_key(value[key])) for key in sorted(value)))
    fail("$", "value is not a JSON type")
    return ()


def strict_json_loads(source: str) -> Any:
    """Reject ambiguous object keys and Python's non-JSON NaN/Infinity extension."""
    def object_pairs(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                fail("$", f"duplicate JSON property: {key}")
            result[key] = value
        return result

    def finite_float(token):
        value = float(token)
        if not math.isfinite(value):
            fail("$", "non-finite JSON number")
        return value

    def invalid_constant(_token):
        fail("$", "non-finite JSON constant")

    return json.loads(source, object_pairs_hook=object_pairs,
                      parse_float=finite_float, parse_constant=invalid_constant)


def resolve_ref(root: dict[str, Any], reference: str, path: str) -> dict[str, Any]:
    if not reference.startswith("#/"):
        fail(path, f"only local JSON Pointer refs are supported: {reference}")
    value: Any = root
    for raw in reference[2:].split("/"):
        token = raw.replace("~1", "/").replace("~0", "~")
        if not isinstance(value, dict) or token not in value:
            fail(path, f"unresolved ref: {reference}")
        value = value[token]
    if not isinstance(value, dict):
        fail(path, f"ref does not resolve to a schema object: {reference}")
    return value


def type_matches(instance: Any, expected: str) -> bool:
    if expected == "object":
        return isinstance(instance, dict)
    if expected == "array":
        return isinstance(instance, list)
    if expected == "string":
        return isinstance(instance, str)
    if expected == "integer":
        return isinstance(instance, int) and not isinstance(instance, bool)
    if expected == "number":
        return (isinstance(instance, (int, float)) and not isinstance(instance, bool)
                and (not isinstance(instance, float) or math.isfinite(instance)))
    if expected == "boolean":
        return isinstance(instance, bool)
    if expected == "null":
        return instance is None
    fail("$schema", f"unsupported JSON Schema type: {expected}")
    return False


def valid_datetime(value: str) -> bool:
    try:
        parsed = value[:-1] + "+00:00" if value.endswith("Z") else value
        datetime.fromisoformat(parsed)
        return "T" in value
    except ValueError:
        return False


def validate(instance: Any, schema: dict[str, Any], root: dict[str, Any] | None = None, path: str = "$") -> None:
    if not isinstance(schema, dict):
        fail(path, "schema must be an object")
    root = schema if root is None else root
    unsupported = sorted(set(schema) - SUPPORTED)
    if unsupported:
        fail(path, "unsupported schema keywords: " + ", ".join(unsupported))

    reference = schema.get("$ref")
    if reference is not None:
        if not isinstance(reference, str):
            fail(path, "$ref must be a string")
        validate(instance, resolve_ref(root, reference, path), root, path)

    for keyword in ("allOf", "anyOf", "oneOf"):
        if keyword not in schema:
            continue
        options = schema[keyword]
        if not isinstance(options, list) or not options:
            fail(path, f"{keyword} must be a nonempty array")
        successes = 0
        errors: list[str] = []
        for option in options:
            try:
                validate(instance, option, root, path)
                successes += 1
            except SchemaValidationError as error:
                errors.append(str(error))
        if keyword == "allOf" and successes != len(options):
            fail(path, f"allOf failed: {errors[0] if errors else 'unknown'}")
        if keyword == "anyOf" and successes == 0:
            fail(path, "anyOf failed")
        if keyword == "oneOf" and successes != 1:
            fail(path, f"oneOf matched {successes} schemas")

    if "not" in schema:
        try:
            validate(instance, schema["not"], root, path)
        except SchemaValidationError:
            pass
        else:
            fail(path, "not schema matched")

    if "if" in schema:
        try:
            validate(instance, schema["if"], root, path)
            matched = True
        except SchemaValidationError:
            matched = False
        branch = "then" if matched else "else"
        if branch in schema:
            validate(instance, schema[branch], root, path)

    expected_type = schema.get("type")
    if expected_type is not None:
        allowed = [expected_type] if isinstance(expected_type, str) else expected_type
        if not isinstance(allowed, list) or not allowed or any(not isinstance(v, str) for v in allowed):
            fail(path, "type must be a string or nonempty string array")
        if not any(type_matches(instance, value) for value in allowed):
            fail(path, f"expected type {allowed}, got {type(instance).__name__}")

    if "const" in schema and json_equality_key(instance) != json_equality_key(schema["const"]):
        fail(path, f"value does not equal const {schema['const']!r}")
    if "enum" in schema:
        enum = schema["enum"]
        if not isinstance(enum, list) or not enum:
            fail(path, "enum must be a nonempty array")
        if not any(json_equality_key(instance) == json_equality_key(candidate) for candidate in enum):
            fail(path, f"value is not in enum {enum!r}")

    if isinstance(instance, dict):
        if "propertyNames" in schema:
            for key in instance:
                validate(key, schema["propertyNames"], root, f"{path}.<property-name>")
        minimum = schema.get("minProperties")
        maximum = schema.get("maxProperties")
        if minimum is not None and len(instance) < minimum:
            fail(path, f"object has fewer than {minimum} properties")
        if maximum is not None and len(instance) > maximum:
            fail(path, f"object has more than {maximum} properties")
        required = schema.get("required", [])
        if not isinstance(required, list) or any(not isinstance(v, str) for v in required):
            fail(path, "required must be a string array")
        missing = [key for key in required if key not in instance]
        if missing:
            fail(path, "missing required properties: " + ", ".join(missing))
        properties = schema.get("properties", {})
        if not isinstance(properties, dict):
            fail(path, "properties must be an object")
        for key, subschema in properties.items():
            if key in instance:
                validate(instance[key], subschema, root, f"{path}.{key}")
        extras = set(instance) - set(properties)
        additional = schema.get("additionalProperties", True)
        if additional is False and extras:
            fail(path, "unexpected properties: " + ", ".join(sorted(extras)))
        if isinstance(additional, dict):
            for key in extras:
                validate(instance[key], additional, root, f"{path}.{key}")
        elif not isinstance(additional, bool):
            fail(path, "additionalProperties must be boolean or schema")

    if isinstance(instance, list):
        minimum = schema.get("minItems")
        maximum = schema.get("maxItems")
        if minimum is not None and len(instance) < minimum:
            fail(path, f"array has fewer than {minimum} items")
        if maximum is not None and len(instance) > maximum:
            fail(path, f"array has more than {maximum} items")
        if schema.get("uniqueItems") is True:
            values = [json_equality_key(value) for value in instance]
            if len(values) != len(set(values)):
                fail(path, "array items are not unique")
        items = schema.get("items")
        if items is not None:
            if not isinstance(items, dict):
                fail(path, "items must be a schema object")
            for index, value in enumerate(instance):
                validate(value, items, root, f"{path}[{index}]")

    if isinstance(instance, str):
        minimum = schema.get("minLength")
        maximum = schema.get("maxLength")
        if minimum is not None and len(instance) < minimum:
            fail(path, f"string shorter than {minimum}")
        if maximum is not None and len(instance) > maximum:
            fail(path, f"string longer than {maximum}")
        pattern = schema.get("pattern")
        if pattern is not None:
            if not isinstance(pattern, str):
                fail(path, "pattern must be a string")
            if re.search(pattern, instance) is None:
                fail(path, f"string does not match pattern {pattern!r}")
        format_name = schema.get("format")
        if format_name is not None:
            if format_name == "date-time":
                if not valid_datetime(instance):
                    fail(path, "invalid date-time")
            else:
                fail(path, f"unsupported format: {format_name}")

    if isinstance(instance, (int, float)) and not isinstance(instance, bool):
        for key, predicate in (
            ("minimum", lambda value, bound: value >= bound),
            ("maximum", lambda value, bound: value <= bound),
            ("exclusiveMinimum", lambda value, bound: value > bound),
            ("exclusiveMaximum", lambda value, bound: value < bound),
        ):
            if key in schema and not predicate(instance, schema[key]):
                fail(path, f"numeric constraint failed: {key}={schema[key]}")


def validate_files(schema_path: Path, instance_path: Path) -> None:
    schema = strict_json_loads(schema_path.read_text(encoding="utf-8"))
    instance = strict_json_loads(instance_path.read_text(encoding="utf-8"))
    validate(instance, schema)


def validate_batch_stdin() -> int:
    """Validate captured bytes, never re-open candidate-controlled schema paths."""
    maximum_bytes = 4 * 1024 * 1024
    source = sys.stdin.buffer.read(maximum_bytes + 1)
    if len(source) > maximum_bytes:
        fail("$batch", "schema batch exceeds byte limit")
    batch = strict_json_loads(source.decode("utf-8"))
    if not isinstance(batch, list) or not 1 <= len(batch) <= 128:
        fail("$batch", "expected between 1 and 128 documents")
    failures = []
    for row in batch:
        if (not isinstance(row, dict) or set(row) != {"name", "schema", "instance"}
                or not all(isinstance(row[key], str) for key in row)):
            fail("$batch", "invalid document envelope")
        try:
            schema = strict_json_loads(row["schema"])
            instance = strict_json_loads(row["instance"])
            validate(instance, schema)
        except (ValueError, RecursionError) as error:
            failures.append({"name": row["name"], "error": str(error)[:1000]})
    print(json.dumps({"ok": not failures, "failures": failures}, sort_keys=True))
    return 1 if failures else 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--schema", type=Path)
    parser.add_argument("--instance", type=Path)
    parser.add_argument("--batch-stdin", action="store_true")
    args = parser.parse_args()
    if args.batch_stdin:
        if args.schema is not None or args.instance is not None:
            parser.error("--batch-stdin cannot be combined with file arguments")
        return validate_batch_stdin()
    if args.schema is None or args.instance is None:
        parser.error("--schema and --instance are required without --batch-stdin")
    validate_files(args.schema, args.instance)
    print(json.dumps({"status": "json_schema_valid", "schema": str(args.schema), "instance": str(args.instance)}, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, UnicodeError, ValueError, RecursionError) as error:
        print(f"JSON Schema validation failed: {error}", file=sys.stderr)
        raise SystemExit(1)
