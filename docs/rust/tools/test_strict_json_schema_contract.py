#!/usr/bin/env python3
"""Independent hostile contract tests for the bounded qualification schema verifier."""

import unittest
import strict_json_schema as SCHEMA


class SchemaContractPreflightTests(unittest.TestCase):
    def test_invalid_definitions_cannot_hide_in_unselected_branches(self) -> None:
        bad = {"unsupportedSafetyGuard": True}
        cases = [
            {"anyOf": [{}, bad]}, {"oneOf": [{}, bad]}, {"not": bad},
            {"if": bad, "else": {}}, {"if": {"const": 1}, "else": bad},
            {"if": {"const": 2}, "then": bad}, {"properties": {"absent": bad}},
            {"$defs": {"unused": bad}}, {"items": bad}, {"additionalProperties": bad},
        ]
        for schema in cases:
            with self.subTest(schema=schema):
                with self.assertRaises(SCHEMA.SchemaDefinitionError):
                    SCHEMA.validate(1, schema)

    def test_malformed_keyword_values_are_rejected_without_applicable_instance(self) -> None:
        cases = [
            {"type": ["integer", "unrecognized"]}, {"type": []}, {"type": None},
            {"required": ["a", "a"]}, {"required": "a"}, {"properties": []},
            {"minItems": True}, {"maxLength": -1}, {"maximum": "10"},
            {"uniqueItems": 1}, {"pattern": "["}, {"enum": []},
            {"anyOf": []}, {"format": "unimplemented-format"}, {"$ref": None},
            {"items": None}, {"not": None}, {"if": None},
        ]
        for schema in cases:
            with self.subTest(schema=schema):
                with self.assertRaises(SCHEMA.SchemaDefinitionError):
                    SCHEMA.validate(None, schema)

    def test_boolean_schemas_and_integral_floats_keep_standard_semantics(self) -> None:
        for value in [None, 1, False, {}, []]:
            SCHEMA.validate(value, True)
            with self.assertRaises(SCHEMA.SchemaValidationError):
                SCHEMA.validate(value, False)
        SCHEMA.validate(1.0, {"type": "integer"})
        SCHEMA.validate([], {"items": False})
        SCHEMA.validate({}, {"properties": {"forbidden": False}})
        for value, schema in [([1], {"items": False}),
                               ({"forbidden": 1}, {"properties": {"forbidden": False}}),
                               (True, {"type": "integer"}), (1.1, {"type": "integer"})]:
            with self.assertRaises(SCHEMA.SchemaValidationError):
                SCHEMA.validate(value, schema)

    def test_ref_resolution_and_invalid_pointer_do_not_depend_on_branch_selection(self) -> None:
        SCHEMA.validate(1, {"$ref": "#/$defs/allow", "$defs": {"allow": True}})
        for schema in [
            {"anyOf": [{}, {"$ref": "#/$defs/missing"}]},
            {"$ref": "#/$defs/a~2b", "$defs": {"a~2b": {}}},
            {"not": {"$ref": "https://untrusted.invalid/schema"}},
        ]:
            with self.assertRaises(SCHEMA.SchemaDefinitionError):
                SCHEMA.validate(1, schema)

    def test_non_json_values_are_rejected_even_by_empty_or_negated_schemas(self) -> None:
        for value in [float("nan"), float("inf"), {"a": float("inf")}, (1,), {1: "a"}]:
            for schema in [{}, True, {"not": {"type": "string"}}]:
                with self.subTest(value=value, schema=schema):
                    with self.assertRaises(SCHEMA.SchemaValidationError):
                        SCHEMA.validate(value, schema)

    def test_recursive_ref_cannot_turn_execution_failure_into_not_success(self) -> None:
        schema = {"not": {"$ref": "#/$defs/cycle"},
                  "$defs": {"cycle": {"$ref": "#/$defs/cycle"}}}
        with self.assertRaises(SCHEMA.SchemaDefinitionError):
            SCHEMA.validate(1, schema)

    def test_qualification_datetimes_require_full_time_zone_and_valid_calendar(self) -> None:
        for value in ["2026-09-05T12:34:56Z", "2026-09-05t12:34:56.125z",
                      "2024-02-29T00:00:00+08:00", "2026-09-05T12:34:56-03:30"]:
            SCHEMA.validate(value, {"format": "date-time"})
        for value in ["2026-09-05T12:34:56", "2026-09-05T12", "2026-09-05 12:34:56Z",
                      "2026-02-29T00:00:00Z", "2026-09-05T24:00:00Z",
                      "2026-09-05T12:34:56+24:00", "2026-09-05T12:34:56+00:60",
                      "2026-09-05T12:34:56-01:99", "2026-09-05T12:34:56Z\n"]:
            with self.subTest(value=value):
                with self.assertRaises(SCHEMA.SchemaValidationError):
                    SCHEMA.validate(value, {"format": "date-time"})

    def test_branch_explosion_budget_is_not_swallowed(self) -> None:
        definitions = {"d0": {}}
        for index in range(1, 20):
            reference = {"$ref": f"#/$defs/d{index - 1}"}
            definitions[f"d{index}"] = {"allOf": [reference, reference]}
        schema = {"not": {"$ref": "#/$defs/d19"}, "$defs": definitions}
        with self.assertRaisesRegex(SCHEMA.SchemaDefinitionError, "budget exhausted"):
            SCHEMA.validate(1, schema)


if __name__ == "__main__":
    unittest.main(verbosity=2)
