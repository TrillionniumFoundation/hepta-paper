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
    "additionalProperties", "minProperties", "maxProperties", "minItems",
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
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


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
        return isinstance(instance, (int, float)) and not isinstance(instance, bool)
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

    if "const" in schema and instance != schema["const"]:
        fail(path, f"value does not equal const {schema['const']!r}")
    if "enum" in schema:
        enum = schema["enum"]
        if not isinstance(enum, list) or not enum:
            fail(path, "enum must be a nonempty array")
        if not any(instance == candidate for candidate in enum):
            fail(path, f"value is not in enum {enum!r}")

    if isinstance(instance, dict):
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
        elif additional not in (True, False):
            fail(path, "additionalProperties must be boolean or schema")

    if isinstance(instance, list):
        minimum = schema.get("minItems")
        maximum = schema.get("maxItems")
        if minimum is not None and len(instance) < minimum:
            fail(path, f"array has fewer than {minimum} items")
        if maximum is not None and len(instance) > maximum:
            fail(path, f"array has more than {maximum} items")
        if schema.get("uniqueItems") is True:
            values = [canonical(value) for value in instance]
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
    schema = json.loads(schema_path.read_text(encoding="utf-8"))
    instance = json.loads(instance_path.read_text(encoding="utf-8"))
    validate(instance, schema)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--schema", required=True, type=Path)
    parser.add_argument("--instance", required=True, type=Path)
    args = parser.parse_args()
    validate_files(args.schema, args.instance)
    print(json.dumps({"status": "json_schema_valid", "schema": str(args.schema), "instance": str(args.instance)}, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, json.JSONDecodeError, SchemaValidationError) as error:
        print(f"JSON Schema validation failed: {error}", file=sys.stderr)
        raise SystemExit(1)
