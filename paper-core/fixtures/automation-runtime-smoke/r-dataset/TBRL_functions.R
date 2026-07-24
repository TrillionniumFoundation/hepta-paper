# Minimal repository-owned helper used to verify read-only R dataset mounting.
remove_string_from_name <- function(value) {
  sub('^expt_', '', value)
}
