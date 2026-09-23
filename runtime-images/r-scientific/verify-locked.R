manifest_path <- "/opt/hepta-r-source-cas/manifest.json"
stopifnot(file.exists(manifest_path), requireNamespace("jsonlite", quietly = TRUE))
manifest <- jsonlite::fromJSON(manifest_path, simplifyVector = FALSE)
version_equivalent <- function(observed, expected) {
  isTRUE(base::package_version(observed) == base::package_version(expected))
}
stopifnot(
  identical(manifest$kind, "RRuntimeSourceCasManifest"),
  identical(manifest$status, "r_runtime_source_cas_complete"),
  identical(manifest$packageCount, length(manifest$packages)),
  identical(manifest$exactLockClosure, TRUE),
  identical(manifest$allSourceArchivesContentHashed, TRUE),
  identical(manifest$offlineRestoreRequired, TRUE)
)
for (entry in manifest$packages) {
  stopifnot(requireNamespace(entry$package, quietly = TRUE))
  observed <- as.character(utils::packageVersion(entry$package))
  if (!version_equivalent(observed, entry$version)) {
    stop(sprintf(
      "R source CAS version mismatch for %s: expected %s, observed %s",
      entry$package,
      entry$version,
      observed
    ))
  }
}

locked <- list()
for (line in readLines("/tmp/packages.lock")) {
  parts <- strsplit(line, "=", fixed = TRUE)[[1]]
  locked[[parts[[1]]]] <- parts[[2]]
}
stopifnot(all(vapply(names(locked), requireNamespace, logical(1), quietly = TRUE)))
stopifnot(all(vapply(names(locked), function(package) {
  version_equivalent(as.character(utils::packageVersion(package)), locked[[package]])
}, logical(1))))

epoch <- as.numeric(Sys.getenv("SOURCE_DATE_EPOCH"))
stopifnot(is.finite(epoch), epoch >= 0, epoch == floor(epoch))
fixed_built_date <- format(
  as.POSIXct(epoch, origin = "1970-01-01", tz = "UTC"),
  format = "%Y-%m-%d %H:%M:%S UTC",
  tz = "UTC",
  usetz = FALSE
)
library_root <- "/usr/local/lib/R/site-library"
package_roots <- list.dirs(library_root, full.names = TRUE, recursive = FALSE)
runtime_lock <- jsonlite::fromJSON(
  paste(readLines("/tmp/renv.lock", warn = FALSE), collapse = "\n"),
  simplifyVector = FALSE
)
expected_site_packages <- sort(names(Filter(
  function(record) is.null(record$Priority),
  runtime_lock$Packages
)))
observed_site_packages <- sort(basename(package_roots))
stopifnot(
  length(package_roots) > 0L,
  identical(observed_site_packages, expected_site_packages)
)
source_metadata_names <- c("srcref", "srcfile", "wholeSrcref", "parseData")
assert_no_source_metadata <- function(value, location) {
  if (is.environment(value)) {
    if (inherits(value, "srcfile")) {
      stop(sprintf("R source-file environment survived deterministic install: %s", location))
    }
    return(invisible(TRUE))
  }
  attrs <- attributes(value)
  if (!is.null(attrs)) {
    bad <- intersect(names(attrs), source_metadata_names)
    if (length(bad)) {
      stop(sprintf(
        "R source metadata %s survived deterministic install: %s",
        paste(bad, collapse = ","),
        location
      ))
    }
    for (name in names(attrs)) {
      assert_no_source_metadata(attrs[[name]], paste0(location, "@", name))
    }
  }
  if (is.function(value)) {
    assert_no_source_metadata(formals(value), paste0(location, "::formals"))
    assert_no_source_metadata(body(value), paste0(location, "::body"))
  } else if (is.pairlist(value) || is.call(value)
    || is.expression(value) || is.list(value)) {
    for (index in seq_along(value)) {
      assert_no_source_metadata(value[[index]], paste0(location, "[[", index, "]]"))
    }
  }
  invisible(TRUE)
}
for (package_root in package_roots) {
  description <- readLines(file.path(package_root, "DESCRIPTION"), warn = FALSE)
  built_line <- grep("^Built:", description, value = TRUE)
  stopifnot(length(built_line) == 1L)
  built_fields <- strsplit(
    sub("^Built:[[:space:]]*", "", built_line),
    ";",
    fixed = TRUE
  )[[1L]]
  stopifnot(
    length(built_fields) == 4L,
    identical(trimws(built_fields[[3L]]), fixed_built_date)
  )
  metadata <- readRDS(file.path(package_root, "Meta", "package.rds"))
  stopifnot(
    is.list(metadata),
    is.list(metadata$Built),
    identical(metadata$Built$Date, fixed_built_date),
    is.character(metadata$DESCRIPTION),
    identical(
      trimws(strsplit(metadata$DESCRIPTION[["Built"]], ";", fixed = TRUE)[[1L]][[3L]]),
      fixed_built_date
    ),
    !dir.exists(file.path(package_root, "help"))
  )

  namespace <- asNamespace(basename(package_root))
  for (symbol in ls(namespace, all.names = TRUE)) {
    value <- get(symbol, envir = namespace, inherits = FALSE)
    if (!is.function(value)) next
    if (!is.null(utils::getSrcref(value))) {
      source_file <- tryCatch(
        as.character(utils::getSrcFilename(value, full.names = TRUE)),
        error = function(...) "<unavailable>"
      )
      stop(sprintf(
        "R function source reference survived deterministic install: %s:::%s (%s)",
        basename(package_root),
        symbol,
        paste(source_file, collapse = ",")
      ))
    }
    assert_no_source_metadata(
      value,
      paste0(basename(package_root), ":::anonymous-binding:", symbol)
    )
  }
}
