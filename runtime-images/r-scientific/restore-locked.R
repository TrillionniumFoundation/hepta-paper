options(
  repos = c(CRAN = "https://packagemanager.posit.co/cran/2024-11-01"),
  timeout = 600,
  download.file.method = "libcurl"
)

if (!requireNamespace("renv", quietly = TRUE)) {
  install.packages("renv")
}

last_error <- NULL
for (attempt in seq_len(5)) {
  restored <- tryCatch({
    renv::restore(lockfile = "/tmp/renv.lock", prompt = FALSE)
    TRUE
  }, error = function(error) {
    last_error <<- conditionMessage(error)
    message(sprintf("renv restore attempt %d/5 failed: %s", attempt, last_error))
    FALSE
  })
  if (restored) {
    quit(status = 0)
  }
  Sys.sleep(attempt * 5)
}

stop(sprintf("renv restore failed after 5 attempts: %s", last_error))
