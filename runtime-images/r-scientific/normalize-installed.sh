#!/bin/sh
set -eu

: "${SOURCE_DATE_EPOCH:?SOURCE_DATE_EPOCH is required}"
[ "$SOURCE_DATE_EPOCH" = "1733097600" ] || {
  echo "unexpected SOURCE_DATE_EPOCH: $SOURCE_DATE_EPOCH" >&2
  exit 1
}

library=/usr/local/lib/R/site-library
source_cas=/opt/hepta-r-source-cas
[ -d "$library" ] && [ -d "$source_cas" ]

rm -rf /root/.cache/R/renv /tmp/Rtmp* /tmp/renv* "$library/.renv"

if find "$library" -name '00LOCK*' -print -quit | grep -q .; then
  echo "R package installation lock survived restore" >&2
  exit 1
fi

# R records the wall clock used to install each package in two places.  Rewrite
# both representations before permission/mtime normalization so two isolated
# source builds serialize the same package metadata.
Rscript --vanilla - "$library" <<'RSCRIPT'
args <- commandArgs(trailingOnly = TRUE)
stopifnot(length(args) == 1L, nzchar(Sys.getenv("SOURCE_DATE_EPOCH")))
library_root <- normalizePath(args[[1L]], mustWork = TRUE)
epoch <- as.numeric(Sys.getenv("SOURCE_DATE_EPOCH"))
stopifnot(is.finite(epoch), epoch >= 0, epoch == floor(epoch))
fixed_date <- format(
  as.POSIXct(epoch, origin = "1970-01-01", tz = "UTC"),
  format = "%Y-%m-%d %H:%M:%S UTC",
  tz = "UTC",
  usetz = FALSE
)

package_roots <- list.dirs(library_root, full.names = TRUE, recursive = FALSE)
stopifnot(length(package_roots) > 0L)
for (package_root in package_roots) {
  description_path <- file.path(package_root, "DESCRIPTION")
  metadata_path <- file.path(package_root, "Meta", "package.rds")
  stopifnot(file.exists(description_path), file.exists(metadata_path))

  description <- readLines(description_path, warn = FALSE)
  built_line <- grep("^Built:", description)
  stopifnot(length(built_line) == 1L)
  built_fields <- strsplit(
    sub("^Built:[[:space:]]*", "", description[[built_line]]),
    ";",
    fixed = TRUE
  )[[1L]]
  stopifnot(length(built_fields) == 4L)
  built_fields <- trimws(built_fields)
  built_fields[[3L]] <- fixed_date
  description[[built_line]] <- paste0("Built: ", paste(built_fields, collapse = "; "))
  writeLines(description, description_path, useBytes = TRUE)

  metadata <- readRDS(metadata_path)
  stopifnot(
    is.list(metadata),
    is.list(metadata$Built),
    is.character(metadata$Built$Date),
    length(metadata$Built$Date) == 1L,
    is.character(metadata$DESCRIPTION),
    length(metadata$DESCRIPTION[["Built"]]) == 1L
  )
  metadata$Built$Date <- fixed_date
  metadata$DESCRIPTION[["Built"]] <- paste(built_fields, collapse = "; ")
  temporary_path <- paste0(metadata_path, ".normalized")
  saveRDS(metadata, temporary_path, compress = "xz", version = 3L)
  stopifnot(file.rename(temporary_path, metadata_path))
}
RSCRIPT

# Every ELF produced by an R source install must be normalized.  This includes
# package shared objects and executables such as littler/bin/r; limiting this
# pass to *.so would leave build IDs and random R.INSTALL paths in executables.
find "$library" -type f -exec sh -c '
  for candidate do
    if ! readelf -h "$candidate" >/dev/null 2>&1; then
      continue
    fi
    objcopy --remove-section=.note.gnu.build-id "$candidate"
    strip --strip-debug "$candidate"
    if readelf -S "$candidate" | grep -Fq ".note.gnu.build-id"; then
      echo "non-reproducible ELF build-id in $candidate" >&2
      exit 1
    fi
    if strings "$candidate" | grep -Eq "/tmp/Rtmp|/tmp/renv|00LOCK"; then
      echo "non-reproducible temporary build path in $candidate" >&2
      exit 1
    fi
  done
' sh {} +

chown -R 0:0 "$library" "$source_cas"
find "$library" "$source_cas" -depth -exec touch -h -d "@$SOURCE_DATE_EPOCH" {} +

# Symlink modes are intentionally 0777 on Linux and cannot be normalized with
# chmod.  Treat links separately, reject any link that escapes the immutable
# runtime roots, and canonicalize only regular-file/directory permissions.
find "$library" "$source_cas" -type l -exec sh -c '
  library=$1
  source_cas=$2
  shift 2
  for candidate do
    target=$(readlink -f "$candidate") || {
      echo "unresolvable R runtime symlink: $candidate" >&2
      exit 1
    }
    case "$target" in
      "$library"|"$library"/*|"$source_cas"|"$source_cas"/*) ;;
      *)
        echo "R runtime symlink escapes immutable roots: $candidate -> $target" >&2
        exit 1
        ;;
    esac
  done
' sh "$library" "$source_cas" {} +
find "$library" "$source_cas" -type d -exec chmod 0555 {} +
find "$library" "$source_cas" -type f -perm /0111 -exec chmod 0555 {} +
find "$library" "$source_cas" -type f ! -perm /0111 -exec chmod 0444 {} +

find "$library" "$source_cas" -exec sh -c '
  epoch=$1
  shift
  for candidate do
    [ "$(stat -c %Y "$candidate")" = "$epoch" ] || {
      echo "mtime normalization failed for $candidate" >&2
      exit 1
    }
  done
' sh "$SOURCE_DATE_EPOCH" {} +

if find "$library" "$source_cas" \( -type f -o -type d \) \
    -perm /0022 -print -quit | grep -q .; then
  echo "group/world-writable R runtime content detected" >&2
  exit 1
fi
