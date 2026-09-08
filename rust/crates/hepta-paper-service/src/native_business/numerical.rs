use super::{NativeBusinessError, NativeBusinessOutputV1, hash_bytes, hash_serialized};
use serde::Serialize;
use serde_json::json;

const MAX_MATRIX_DIMENSION: usize = 128;

#[allow(clippy::needless_range_loop)]
pub(super) fn numerical_linear_solve(
    matrix: Vec<Vec<f64>>,
    rhs: Vec<f64>,
    tolerance: f64,
) -> Result<NativeBusinessOutputV1, NativeBusinessError> {
    let dimension = matrix.len();
    if dimension == 0
        || dimension > MAX_MATRIX_DIMENSION
        || rhs.len() != dimension
        || !tolerance.is_finite()
        || tolerance <= 0.0
        || matrix.iter().any(|row| row.len() != dimension)
        || matrix
            .iter()
            .flatten()
            .chain(rhs.iter())
            .any(|value| !value.is_finite())
    {
        return Err(NativeBusinessError::Contract);
    }
    let original_matrix = matrix.clone();
    let original_rhs = rhs.clone();
    let mut coefficients = matrix;
    let mut values = rhs;
    for pivot in 0..dimension {
        let mut selected = pivot;
        let mut selected_abs = coefficients[pivot][pivot].abs();
        for row in (pivot + 1)..dimension {
            let candidate = coefficients[row][pivot].abs();
            if candidate > selected_abs {
                selected = row;
                selected_abs = candidate;
            }
        }
        if !selected_abs.is_finite() || selected_abs <= tolerance {
            return Err(NativeBusinessError::SingularMatrix);
        }
        if selected != pivot {
            coefficients.swap(selected, pivot);
            values.swap(selected, pivot);
        }
        for row in (pivot + 1)..dimension {
            let factor = coefficients[row][pivot] / coefficients[pivot][pivot];
            coefficients[row][pivot] = 0.0;
            for column in (pivot + 1)..dimension {
                coefficients[row][column] -= factor * coefficients[pivot][column];
            }
            values[row] -= factor * values[pivot];
            if !values[row].is_finite()
                || coefficients[row][(pivot + 1)..]
                    .iter()
                    .any(|value| !value.is_finite())
            {
                return Err(NativeBusinessError::Numeric);
            }
        }
    }
    let mut solution = vec![0.0f64; dimension];
    for row in (0..dimension).rev() {
        let mut remainder = values[row];
        for column in (row + 1)..dimension {
            remainder -= coefficients[row][column] * solution[column];
        }
        if coefficients[row][row].abs() <= tolerance {
            return Err(NativeBusinessError::SingularMatrix);
        }
        solution[row] = remainder / coefficients[row][row];
        if !solution[row].is_finite() {
            return Err(NativeBusinessError::Numeric);
        }
    }
    let mut residual_linf = 0.0f64;
    for row in 0..dimension {
        let computed = original_matrix[row]
            .iter()
            .zip(solution.iter())
            .map(|(coefficient, value)| coefficient * value)
            .sum::<f64>();
        residual_linf = residual_linf.max((computed - original_rhs[row]).abs());
    }
    if !residual_linf.is_finite() {
        return Err(NativeBusinessError::Numeric);
    }
    let report = NumericalReportV1 {
        kind: "NativeNumericalLinearSolutionV1",
        version: 1,
        dimension,
        solution,
        residual_linf,
        tolerance,
        input_hash: hash_serialized(
            "HeptaNativeLinearSystemV1",
            &(original_matrix, original_rhs),
        )?,
    };
    let bytes = serde_json::to_vec(&report).map_err(|_| NativeBusinessError::Encoding)?;
    Ok(NativeBusinessOutputV1 {
        artifacts: vec![bytes.clone()],
        evidence: json!({
            "kind": "NativeNumericalEvidenceV1",
            "version": 1,
            "reportHash": hash_bytes(&bytes),
            "dimension": dimension,
            "residualLinf": residual_linf,
            "externalActionMayHaveStarted": false
        }),
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NumericalReportV1 {
    kind: &'static str,
    version: u16,
    dimension: usize,
    solution: Vec<f64>,
    residual_linf: f64,
    tolerance: f64,
    input_hash: String,
}
