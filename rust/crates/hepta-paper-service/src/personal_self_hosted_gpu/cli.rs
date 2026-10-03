//! Shared original strict grammar for flat and ordinary GPU check frontends.
use std::collections::BTreeMap;

pub const PERSONAL_GPU_USAGE: &str = "personal-gpu-operational-gate [--write] [--check] [--root PATH] [--runtime-root PATH]\n  Runs the local single-host GPU/PDE/DL gate. Green is personal-only and non-promotable.";

pub fn parse_personal_gpu_arguments(args: &[String]) -> Result<BTreeMap<String, String>, String> {
    let mut parsed = BTreeMap::new();
    let mut index = 0;
    while index < args.len() {
        let token = args[index].as_str();
        if token == "--" {
            return Err("unexpected_cli_argument_separator".into());
        }
        let raw = token
            .strip_prefix("--")
            .ok_or_else(|| format!("unexpected_cli_positional:{token}"))?;
        let (key, inline) = raw
            .split_once('=')
            .map_or((raw, None), |(key, value)| (key, Some(value)));
        if key.is_empty() {
            return Err("empty_cli_option".into());
        }
        let boolean = matches!(key, "check" | "help" | "write");
        let value = if boolean {
            if inline.is_some() {
                return Err(format!("boolean_cli_option_does_not_take_value:--{key}"));
            }
            "true".to_owned()
        } else {
            if !matches!(
                key,
                "root" | "runtime-root" | "receipt" | "output-root" | "run-id" | "deadline-ms"
            ) {
                return Err(format!("unknown_cli_option:--{key}"));
            }
            let value = match inline {
                Some(value) => value,
                None => {
                    index += 1;
                    let value = args
                        .get(index)
                        .filter(|value| !value.starts_with("--"))
                        .ok_or_else(|| format!("missing_cli_option_value:--{key}"))?;
                    value.as_str()
                }
            };
            if value.is_empty() {
                return Err(format!("empty_cli_option_value:--{key}"));
            }
            value.to_owned()
        };
        // The Node parser validates the value before reporting duplication.
        if parsed.insert(key.to_owned(), value).is_some() {
            return Err(format!("duplicate_cli_option:--{key}"));
        }
        index += 1;
    }
    Ok(parsed)
}

pub fn safe_personal_gpu_token(value: &str) -> String {
    let token = value
        .encode_utf16()
        .take(180)
        .map(|unit| {
            if unit <= 127 {
                let character = char::from(unit as u8);
                if character.is_ascii_alphanumeric() || matches!(character, '_' | '.' | ':' | '-') {
                    return character;
                }
            }
            '_'
        })
        .collect::<String>();
    if token.is_empty() {
        "error".to_owned()
    } else {
        token
    }
}
