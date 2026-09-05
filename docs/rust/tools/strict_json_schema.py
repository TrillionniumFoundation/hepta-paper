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


class SchemaDefinitionError(SchemaValidationError):
    """An invalid contract or exhausted evaluation must not become a branch mismatch."""


def fail_definition(path: str, message: str) -> None:
    raise SchemaDefinitionError(f"{path}: {message}")


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
        if re.search(r"~(?![01])", raw):
            fail_definition(path, "invalid JSON Pointer escape")
        token = raw.replace("~1", "/").replace("~0", "~")
        if not isinstance(value, dict) or token not in value:
            fail(path, f"unresolved ref: {reference}")
        value = value[token]
    if not isinstance(value, (dict, bool)):
        fail_definition(path, f"ref does not resolve to a schema: {reference}")
    return value


def type_matches(instance: Any, expected: str) -> bool:
    if expected == "object":
        return isinstance(instance, dict)
    if expected == "array":
        return isinstance(instance, list)
    if expected == "string":
        return isinstance(instance, str)
    if expected == "integer":
        return (isinstance(instance, int) and not isinstance(instance, bool)) or (
            isinstance(instance, float) and math.isfinite(instance) and instance.is_integer())
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
    # Qualification times require a full timestamp and explicit UTC offset.
    # Leap-second timestamps are outside this repository's supported profile.
    if re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}[Tt][0-9]{2}:[0-9]{2}:[0-9]{2}"
                    r"(?:\.[0-9]+)?(?:[Zz]|[+-][0-9]{2}:[0-9]{2})", value) is None:
        return False
    try:
        parsed = value[:-1] + "+00:00" if value[-1] in "Zz" else value
        return datetime.fromisoformat(parsed).tzinfo is not None
    except ValueError:
        return False


def validate_schema_definition(schema: Any, root: Any) -> None:
    """Check every schema branch before evaluating any instance branch.

    Unsupported keywords in absent properties, unused definitions or a failing
    anyOf/not/if branch are contract errors, never evidence of a valid instance.
    This deliberately remains the repository's bounded subset, not a general
    implementation of every Draft 2020-12 vocabulary.
    """
    pending = [(schema, "$schema", 0)]
    seen = set()
    count = 0
    while pending:
        selected, location, depth = pending.pop()
        count += 1
        if count > 10000 or depth > 128:
            fail_definition(location, "schema definition exceeds traversal limit")
        if isinstance(selected, bool):
            continue
        if not isinstance(selected, dict):
            fail_definition(location, "schema must be an object or boolean")
        if id(selected) in seen:
            continue
        seen.add(id(selected))
        unsupported = sorted(set(selected) - SUPPORTED)
        if unsupported:
            fail_definition(location, "unsupported schema keywords: " + ", ".join(unsupported))
        if "type" in selected:
            types = [selected["type"]] if isinstance(selected["type"], str) else selected["type"]
            known = {"object", "array", "string", "number", "integer", "boolean", "null"}
            if (not isinstance(types, list) or not types
                    or any(not isinstance(value, str) or value not in known for value in types)
                    or len(set(types)) != len(types)):
                fail_definition(location, "invalid schema type declaration")
        for key in ("minProperties", "maxProperties", "minItems", "maxItems", "minLength", "maxLength"):
            if key in selected and (not type_matches(selected[key], "integer") or selected[key] < 0):
                fail_definition(location, f"{key} must be a nonnegative integer")
        for key in ("minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"):
            if key in selected and not type_matches(selected[key], "number"):
                fail_definition(location, f"{key} must be a finite number")
        for key in ("uniqueItems", "deprecated", "readOnly", "writeOnly"):
            if key in selected and not isinstance(selected[key], bool):
                fail_definition(location, f"{key} must be a boolean")
        if "required" in selected:
            required = selected["required"]
            if (not isinstance(required, list) or any(not isinstance(item, str) for item in required)
                    or len(set(required)) != len(required)):
                fail_definition(location, "required must contain unique strings")
        if "enum" in selected and (not isinstance(selected["enum"], list) or not selected["enum"]):
            fail_definition(location, "enum must be a nonempty array")
        if "pattern" in selected:
            if not isinstance(selected["pattern"], str):
                fail_definition(location, "pattern must be a string")
            try:
                re.compile(selected["pattern"])
            except re.error as error:
                fail_definition(location, f"invalid regular expression: {error}")
        if "format" in selected and selected["format"] != "date-time":
            fail_definition(location, "unsupported format")
        for key in ("$schema", "$id", "$anchor", "$comment", "title", "description"):
            if key in selected and not isinstance(selected[key], str):
                fail_definition(location, f"{key} must be a string")
        for key in ("properties", "$defs"):
            if key in selected:
                if not isinstance(selected[key], dict):
                    fail_definition(location, f"{key} must be an object")
                pending.extend((value, f"{location}.{key}.{name}", depth + 1)
                               for name, value in selected[key].items())
        for key in ("allOf", "anyOf", "oneOf"):
            if key in selected:
                if not isinstance(selected[key], list) or not selected[key]:
                    fail_definition(location, f"{key} must be a nonempty array")
                pending.extend((value, f"{location}.{key}[{index}]", depth + 1)
                               for index, value in enumerate(selected[key]))
        for key in ("items", "propertyNames", "additionalProperties", "not", "if", "then", "else"):
            if key in selected:
                pending.append((selected[key], f"{location}.{key}", depth + 1))
        if "$ref" in selected:
            if not isinstance(selected["$ref"], str):
                fail_definition(location, "$ref must be a string")
            try:
                target = resolve_ref(root, selected["$ref"], location)
            except SchemaValidationError as error:
                fail_definition(location, str(error))
            pending.append((target, f"{location}.$ref", depth + 1))


def validate(instance: Any, schema: Any, root: Any = None, path: str = "$") -> None:
    """Validate a JSON instance only after its entire contract is well formed."""
    selected_root = schema if root is None else root
    try:
        # Reject non-JSON values even when an empty/negated schema could accept them.
        json_equality_key(instance)
        json_equality_key(selected_root)
        json_equality_key(schema)
        validate_schema_definition(selected_root, selected_root)
        if schema is not selected_root:
            validate_schema_definition(schema, selected_root)
        _validate(instance, schema, selected_root, path, [100000])
    except RecursionError as error:
        raise SchemaDefinitionError(f"{path}: schema or instance recursion limit exceeded") from error


def _validate(instance: Any, schema: Any, root: Any, path: str, budget: list[int]) -> None:
    budget[0] -= 1
    if budget[0] < 0:
        fail_definition(path, "schema evaluation budget exhausted")
    if isinstance(schema, bool):
        if not schema:
            fail(path, "false schema rejects instance")
        return
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
        _validate(instance, resolve_ref(root, reference, path), root, path, budget)

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
                _validate(instance, option, root, path, budget)
                successes += 1
            except SchemaValidationError as error:
                if isinstance(error, SchemaDefinitionError):
                    raise
                errors.append(str(error))
        if keyword == "allOf" and successes != len(options):
            fail(path, f"allOf failed: {errors[0] if errors else 'unknown'}")
        if keyword == "anyOf" and successes == 0:
            fail(path, "anyOf failed")
        if keyword == "oneOf" and successes != 1:
            fail(path, f"oneOf matched {successes} schemas")

    if "not" in schema:
        try:
            _validate(instance, schema["not"], root, path, budget)
        except SchemaValidationError as error:
            if isinstance(error, SchemaDefinitionError):
                raise
            pass
        else:
            fail(path, "not schema matched")

    if "if" in schema:
        try:
            _validate(instance, schema["if"], root, path, budget)
            matched = True
        except SchemaValidationError as error:
            if isinstance(error, SchemaDefinitionError):
                raise
            matched = False
        branch = "then" if matched else "else"
        if branch in schema:
            _validate(instance, schema[branch], root, path, budget)

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
                _validate(key, schema["propertyNames"], root, f"{path}.<property-name>", budget)
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
                _validate(instance[key], subschema, root, f"{path}.{key}", budget)
        extras = set(instance) - set(properties)
        additional = schema.get("additionalProperties", True)
        if additional is False and extras:
            fail(path, "unexpected properties: " + ", ".join(sorted(extras)))
        if isinstance(additional, dict):
            for key in extras:
                _validate(instance[key], additional, root, f"{path}.{key}", budget)
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
            if not isinstance(items, (dict, bool)):
                fail(path, "items must be a schema object")
            for index, value in enumerate(instance):
                _validate(value, items, root, f"{path}[{index}]", budget)

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
