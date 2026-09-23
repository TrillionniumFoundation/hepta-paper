cas_root <- "/opt/hepta-r-source-cas"
contrib <- file.path(cas_root, "src", "contrib")
sums <- file.path(cas_root, "SHA256SUMS")
lockfile <- "/tmp/renv.lock"
site_library <- "/usr/local/lib/R/site-library"

stopifnot(
  dir.exists(contrib),
  file.exists(sums),
  file.exists(lockfile),
  dir.exists(site_library),
  normalizePath(site_library, mustWork = TRUE) == site_library
)
preinstalled <- list.files(
  site_library,
  all.files = TRUE,
  no.. = TRUE,
  full.names = TRUE
)
if (length(preinstalled)) unlink(preinstalled, recursive = TRUE, force = TRUE)
stopifnot(length(list.files(site_library, all.files = TRUE, no.. = TRUE)) == 0L)
.libPaths(unique(c(site_library, .libPaths())))
old <- setwd(cas_root)
on.exit(setwd(old), add = TRUE)
status <- system2("sha256sum", c("--strict", "-c", "SHA256SUMS"))
if (!identical(status, 0L)) stop("R source CAS SHA-256 verification failed")

tools::write_PACKAGES(contrib, type = "source", latestOnly = FALSE)
repository <- paste0("file://", cas_root)
options(repos = c(CRAN = repository), timeout = 600)
Sys.setenv(
  RENV_CONFIG_REPOS_OVERRIDE = repository,
  RENV_CONFIG_AUTOLOADER_ENABLED = "FALSE",
  RENV_CONFIG_SYNCHRONIZED_CHECK = "FALSE",
  RENV_CONFIG_INSTALL_KEEP_SOURCE = "FALSE",
  RENV_CONFIG_INSTALL_STAGED = "FALSE",
  RENV_CONFIG_INSTALL_TRANSACTIONAL = "FALSE",
  RENV_CONFIG_INSTALL_JOBS = "1"
)

deterministic_install_options <- c(
  "--no-staged-install",
  "--without-keep.source",
  "--without-keep.parse.data",
  "--no-byte-compile",
  "--no-help",
  "--built-timestamp=1733097600"
)
options(install.opts = deterministic_install_options)
install.packages(
  "renv",
  repos = repository,
  type = "source",
  dependencies = FALSE,
  INSTALL_opts = deterministic_install_options
)
if (!identical(as.character(utils::packageVersion("renv")), "1.2.3")) {
  stop(sprintf("renv bootstrap version mismatch: expected 1.2.3, observed %s", utils::packageVersion("renv")))
}

renv::restore(lockfile = lockfile, prompt = FALSE, rebuild = TRUE)

# vctrs is the sole locked source archive whose DESCRIPTION explicitly sets
# `KeepSource: true`. That package-level field can retain the random
# Rtmp/R.INSTALL extraction path even when the global install flags request no
# source metadata. Reinstall it from a fixed, verified CAS extraction after
# changing only that metadata policy; the build directory is deleted in this
# same image layer and the installed namespace is verified below.
vctrs_archive <- file.path(contrib, "vctrs_0.7.3.tar.gz")
vctrs_build_root <- "/opt/hepta-r-deterministic-build"
stopifnot(file.exists(vctrs_archive))
unlink(vctrs_build_root, recursive = TRUE, force = TRUE)
dir.create(vctrs_build_root, recursive = TRUE, mode = "0755")
utils::untar(vctrs_archive, exdir = vctrs_build_root)
vctrs_source <- file.path(vctrs_build_root, "vctrs")
vctrs_description <- file.path(vctrs_source, "DESCRIPTION")
description <- readLines(vctrs_description, warn = FALSE)
keep_source <- grep("^KeepSource:[[:space:]]*true[[:space:]]*$", description)
stopifnot(length(keep_source) == 1L)
description[[keep_source]] <- "KeepSource: false"
writeLines(description, vctrs_description, useBytes = TRUE)
status <- system2(
  file.path(R.home("bin"), "R"),
  c(
    "--vanilla", "CMD", "INSTALL", "--preclean", "--no-multiarch",
    deterministic_install_options,
    "-l", site_library,
    vctrs_source
  )
)
if (!identical(status, 0L)) stop("deterministic vctrs reinstall failed")
unlink(vctrs_build_root, recursive = TRUE, force = TRUE)
stopifnot(
  !dir.exists(vctrs_build_root),
  identical(as.character(utils::packageVersion("vctrs")), "0.7.3")
)
