source('/datasets/runtime-smoke/TBRL_functions.R')
value <- remove_string_from_name('expt_bait')
stopifnot(identical(value, 'bait'))
output_dir <- Sys.getenv('HEPTA_OUTPUT_DIR')
stopifnot(nzchar(output_dir))
writeLines('{"function_result":1}', file.path(output_dir, 'results.json'))
write.csv(
  data.frame(metric = 'function_result', value = 1),
  file.path(output_dir, 'results.csv'),
  row.names = FALSE,
  quote = FALSE
)
