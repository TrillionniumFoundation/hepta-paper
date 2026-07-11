locked <- list()
version_equal <- function(installed, expected) {
  identical(as.character(package_version(installed)), as.character(package_version(expected)))
}
for (line in readLines("/tmp/packages.lock")) {
  parts <- strsplit(line, "=", fixed = TRUE)[[1]]
  locked[[parts[[1]]]] <- parts[[2]]
}
stopifnot(all(vapply(names(locked), requireNamespace, logical(1), quietly = TRUE)))
stopifnot(all(vapply(names(locked), function(package) {
  version_equal(as.character(packageVersion(package)), locked[[package]])
}, logical(1))))
