#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <gshadow.h>
#include <inttypes.h>
#include <linux/openat2.h>
#include <pwd.h>
#include <shadow.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <unistd.h>

#ifndef PATH_MAX
#define PATH_MAX 4096
#endif

#define SUPERVISOR_USER "hepta-paper"
#define SUPERVISOR_GROUP "hepta-paper"
#define SUPERVISOR_HOME "/var/lib/hepta-paper"
#define DISPATCHER_USER "hepta-submission-dispatcher"
#define DISPATCHER_GROUP "hepta-submission-dispatcher"
#define DISPATCHER_HOME "/nonexistent"
#define HANDOFF_GROUP "hepta-runtime-handoff"
#define SUPERVISOR_RUNTIME_GROUP "docker"
#define RESOLVE_CHILD (RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_XDEV)
#define PRODUCTION_RUNTIME_ROOT "/var/lib/hepta-paper/runtime"
#define PRODUCTION_RECEIPT_PATH \
  "/run/hepta-paper-handoff-layout/" \
  "autonomous-submission-handoff-layout.receipt.json"

struct identities {
  uid_t supervisor_uid;
  gid_t supervisor_gid;
  uid_t dispatcher_uid;
  gid_t dispatcher_gid;
  gid_t handoff_gid;
  uid_t root_uid;
};

struct entry {
  int parent_fd;
  int fd;
  const char *name;
  struct stat before;
  bool directory;
};

#define MAX_OPENED_FDS 64

static void fail(const char *code);

struct sha256_context {
  uint32_t state[8];
  uint64_t bit_count;
  unsigned char block[64];
  size_t block_size;
};

static uint32_t rotate_right(uint32_t value, unsigned int count) {
  return (value >> count) | (value << (32U - count));
}

static void sha256_transform(struct sha256_context *context,
                             const unsigned char block[64]) {
  static const uint32_t constants[64] = {
    0x428a2f98U, 0x71374491U, 0xb5c0fbcfU, 0xe9b5dba5U,
    0x3956c25bU, 0x59f111f1U, 0x923f82a4U, 0xab1c5ed5U,
    0xd807aa98U, 0x12835b01U, 0x243185beU, 0x550c7dc3U,
    0x72be5d74U, 0x80deb1feU, 0x9bdc06a7U, 0xc19bf174U,
    0xe49b69c1U, 0xefbe4786U, 0x0fc19dc6U, 0x240ca1ccU,
    0x2de92c6fU, 0x4a7484aaU, 0x5cb0a9dcU, 0x76f988daU,
    0x983e5152U, 0xa831c66dU, 0xb00327c8U, 0xbf597fc7U,
    0xc6e00bf3U, 0xd5a79147U, 0x06ca6351U, 0x14292967U,
    0x27b70a85U, 0x2e1b2138U, 0x4d2c6dfcU, 0x53380d13U,
    0x650a7354U, 0x766a0abbU, 0x81c2c92eU, 0x92722c85U,
    0xa2bfe8a1U, 0xa81a664bU, 0xc24b8b70U, 0xc76c51a3U,
    0xd192e819U, 0xd6990624U, 0xf40e3585U, 0x106aa070U,
    0x19a4c116U, 0x1e376c08U, 0x2748774cU, 0x34b0bcb5U,
    0x391c0cb3U, 0x4ed8aa4aU, 0x5b9cca4fU, 0x682e6ff3U,
    0x748f82eeU, 0x78a5636fU, 0x84c87814U, 0x8cc70208U,
    0x90befffaU, 0xa4506cebU, 0xbef9a3f7U, 0xc67178f2U,
  };
  uint32_t words[64];
  for (size_t index = 0; index < 16; index++) {
    words[index] = ((uint32_t) block[index * 4] << 24)
      | ((uint32_t) block[index * 4 + 1] << 16)
      | ((uint32_t) block[index * 4 + 2] << 8)
      | (uint32_t) block[index * 4 + 3];
  }
  for (size_t index = 16; index < 64; index++) {
    uint32_t left = words[index - 15];
    uint32_t right = words[index - 2];
    uint32_t sigma0 = rotate_right(left, 7) ^ rotate_right(left, 18) ^ (left >> 3);
    uint32_t sigma1 = rotate_right(right, 17) ^ rotate_right(right, 19) ^ (right >> 10);
    words[index] = words[index - 16] + sigma0 + words[index - 7] + sigma1;
  }
  uint32_t a = context->state[0];
  uint32_t b = context->state[1];
  uint32_t c = context->state[2];
  uint32_t d = context->state[3];
  uint32_t e = context->state[4];
  uint32_t f = context->state[5];
  uint32_t g = context->state[6];
  uint32_t h = context->state[7];
  for (size_t index = 0; index < 64; index++) {
    uint32_t sum1 = rotate_right(e, 6) ^ rotate_right(e, 11) ^ rotate_right(e, 25);
    uint32_t choice = (e & f) ^ ((~e) & g);
    uint32_t first = h + sum1 + choice + constants[index] + words[index];
    uint32_t sum0 = rotate_right(a, 2) ^ rotate_right(a, 13) ^ rotate_right(a, 22);
    uint32_t majority = (a & b) ^ (a & c) ^ (b & c);
    uint32_t second = sum0 + majority;
    h = g;
    g = f;
    f = e;
    e = d + first;
    d = c;
    c = b;
    b = a;
    a = first + second;
  }
  context->state[0] += a;
  context->state[1] += b;
  context->state[2] += c;
  context->state[3] += d;
  context->state[4] += e;
  context->state[5] += f;
  context->state[6] += g;
  context->state[7] += h;
}

static void sha256_initialize(struct sha256_context *context) {
  *context = (struct sha256_context) {
    .state = {
      0x6a09e667U, 0xbb67ae85U, 0x3c6ef372U, 0xa54ff53aU,
      0x510e527fU, 0x9b05688cU, 0x1f83d9abU, 0x5be0cd19U,
    },
  };
}

static void sha256_update(struct sha256_context *context,
                          const unsigned char *bytes, size_t length) {
  context->bit_count += (uint64_t) length * 8U;
  while (length > 0) {
    size_t available = sizeof(context->block) - context->block_size;
    size_t selected = length < available ? length : available;
    memcpy(context->block + context->block_size, bytes, selected);
    context->block_size += selected;
    bytes += selected;
    length -= selected;
    if (context->block_size == sizeof(context->block)) {
      sha256_transform(context, context->block);
      context->block_size = 0;
    }
  }
}

static void sha256_finalize(struct sha256_context *context,
                            unsigned char digest[32]) {
  uint64_t original_bit_count = context->bit_count;
  const unsigned char marker = 0x80;
  sha256_update(context, &marker, 1);
  const unsigned char zero = 0;
  while (context->block_size != 56) sha256_update(context, &zero, 1);
  unsigned char length[8];
  for (size_t index = 0; index < 8; index++) {
    length[7 - index] = (unsigned char) (original_bit_count >> (index * 8));
  }
  sha256_update(context, length, sizeof(length));
  for (size_t index = 0; index < 8; index++) {
    digest[index * 4] = (unsigned char) (context->state[index] >> 24);
    digest[index * 4 + 1] = (unsigned char) (context->state[index] >> 16);
    digest[index * 4 + 2] = (unsigned char) (context->state[index] >> 8);
    digest[index * 4 + 3] = (unsigned char) context->state[index];
  }
}

static void sha256_fd(int fd, char output[65]) {
  struct sha256_context context;
  sha256_initialize(&context);
  unsigned char buffer[65536];
  off_t offset = 0;
  for (;;) {
    ssize_t count = pread(fd, buffer, sizeof(buffer), offset);
    if (count < 0) fail("autonomous_submission_handoff_database_hash_failed");
    if (count == 0) break;
    sha256_update(&context, buffer, (size_t) count);
    offset += count;
  }
  unsigned char digest[32];
  sha256_finalize(&context, digest);
  static const char hex[] = "0123456789abcdef";
  for (size_t index = 0; index < sizeof(digest); index++) {
    output[index * 2] = hex[digest[index] >> 4];
    output[index * 2 + 1] = hex[digest[index] & 0x0f];
  }
  output[64] = '\0';
}

static void fail(const char *code) {
  fprintf(stderr, "%s: %s\n", code, strerror(errno));
  exit(EXIT_FAILURE);
}

static int openat2_beneath(int parent_fd, const char *name, int flags,
                           unsigned long resolve) {
  struct open_how how = {
    .flags = (unsigned long) flags,
    .resolve = resolve,
  };
  return (int) syscall(SYS_openat2, parent_fd, name, &how, sizeof(how));
}

#ifndef HEPTA_LAYOUT_TEST_MODE
static bool nologin_shell(const char *shell) {
  return shell != NULL
    && (strcmp(shell, "/usr/sbin/nologin") == 0
      || strcmp(shell, "/sbin/nologin") == 0);
}

static bool locked_secret(const char *secret) {
  return secret != NULL && (secret[0] == '!' || secret[0] == '*');
}

static bool passwd_placeholder_or_locked(const char *secret) {
  return secret != NULL
    && (strcmp(secret, "x") == 0 || locked_secret(secret));
}

static void require_locked_unique_account(const char *name) {
  setspent();
  struct spwd *row;
  size_t name_count = 0;
  while ((row = getspent()) != NULL) {
    if (strcmp(row->sp_namp, name) == 0) {
      name_count++;
      if (!locked_secret(row->sp_pwdp)) {
        endspent();
        errno = EINVAL;
        fail("autonomous_submission_handoff_system_account_not_locked");
      }
    }
  }
  endspent();
  if (name_count != 1) {
    errno = EINVAL;
    fail("autonomous_submission_handoff_system_shadow_name_not_unique");
  }
}

static void inspect_exact_members(char **members, bool *supervisor_member,
                                  bool *dispatcher_member,
                                  size_t *member_count,
                                  const char *failure_code) {
  *supervisor_member = false;
  *dispatcher_member = false;
  *member_count = 0;
  for (char **member = members; member != NULL && *member != NULL; member++) {
    (*member_count)++;
    if (strcmp(*member, SUPERVISOR_USER) == 0) {
      *supervisor_member = true;
    } else if (strcmp(*member, DISPATCHER_USER) == 0) {
      *dispatcher_member = true;
    } else {
      errno = EINVAL;
      fail(failure_code);
    }
  }
}

static bool name_in_list(char **members, const char *name) {
  for (char **member = members; member != NULL && *member != NULL; member++) {
    if (strcmp(*member, name) == 0) return true;
  }
  return false;
}

static void require_locked_exact_gshadow(void) {
  setsgent();
  struct sgrp *row;
  size_t supervisor_group_count = 0;
  size_t dispatcher_group_count = 0;
  size_t handoff_group_count = 0;
  while ((row = getsgent()) != NULL) {
    bool supervisor_primary = strcmp(row->sg_namp, SUPERVISOR_GROUP) == 0;
    bool dispatcher_primary = strcmp(row->sg_namp, DISPATCHER_GROUP) == 0;
    bool handoff = strcmp(row->sg_namp, HANDOFF_GROUP) == 0;
    bool supervisor_listed = name_in_list(row->sg_mem, SUPERVISOR_USER);
    bool dispatcher_listed = name_in_list(row->sg_mem, DISPATCHER_USER);
    bool service_admin = name_in_list(row->sg_adm, SUPERVISOR_USER)
      || name_in_list(row->sg_adm, DISPATCHER_USER);
    bool supervisor_group_allowed = handoff
      || strcmp(row->sg_namp, SUPERVISOR_RUNTIME_GROUP) == 0;
    if (service_admin || (supervisor_listed && !supervisor_group_allowed)
        || (dispatcher_listed && !handoff)) {
      endsgent();
      errno = EINVAL;
      fail("autonomous_submission_handoff_group_shadow_membership_forbidden");
    }
    if (!supervisor_primary && !dispatcher_primary && !handoff) continue;
    if (supervisor_primary) supervisor_group_count++;
    if (dispatcher_primary) dispatcher_group_count++;
    if (handoff) handoff_group_count++;
    if (!locked_secret(row->sg_passwd)
        || (row->sg_adm != NULL && row->sg_adm[0] != NULL)) {
      endsgent();
      errno = EINVAL;
      fail("autonomous_submission_handoff_group_shadow_invalid");
    }
    if ((supervisor_primary || dispatcher_primary)
        && row->sg_mem != NULL && row->sg_mem[0] != NULL) {
      endsgent();
      errno = EINVAL;
      fail("autonomous_submission_handoff_primary_group_shadow_members_invalid");
    }
    if (!handoff) continue;
    bool supervisor_member;
    bool dispatcher_member;
    size_t member_count;
    inspect_exact_members(
      row->sg_mem,
      &supervisor_member,
      &dispatcher_member,
      &member_count,
      "autonomous_submission_handoff_group_shadow_membership_not_exclusive");
    if (!supervisor_member || !dispatcher_member || member_count != 2) {
      endsgent();
      errno = EINVAL;
      fail("autonomous_submission_handoff_group_shadow_membership_invalid");
    }
  }
  endsgent();
  if (supervisor_group_count != 1 || dispatcher_group_count != 1
      || handoff_group_count != 1) {
    errno = EINVAL;
    fail("autonomous_submission_handoff_group_shadow_name_not_unique");
  }
}

static void require_allowed_initgroups(const char *name, gid_t primary_gid,
                                       gid_t handoff_gid,
                                       gid_t optional_runtime_gid,
                                       bool allow_optional_runtime_group) {
  int count = 0;
  (void) getgrouplist(name, primary_gid, NULL, &count);
  if (count < 1 || count > 1024) {
    errno = EINVAL;
    fail("autonomous_submission_handoff_initgroups_invalid");
  }
  gid_t *groups = calloc((size_t) count, sizeof(*groups));
  if (groups == NULL) fail("autonomous_submission_handoff_initgroups_allocation_failed");
  int capacity = count;
  if (getgrouplist(name, primary_gid, groups, &capacity) < 0 || capacity != count) {
    free(groups);
    errno = EINVAL;
    fail("autonomous_submission_handoff_initgroups_invalid");
  }
  bool primary_present = false;
  bool handoff_present = false;
  for (int index = 0; index < count; index++) {
    if (groups[index] == primary_gid) primary_present = true;
    else if (groups[index] == handoff_gid) handoff_present = true;
    else if (allow_optional_runtime_group
        && groups[index] == optional_runtime_gid) {
      continue;
    }
    else {
      free(groups);
      errno = EINVAL;
      fail("autonomous_submission_handoff_persistent_supplementary_group_forbidden");
    }
  }
  free(groups);
  if (!primary_present || !handoff_present) {
    errno = EINVAL;
    fail("autonomous_submission_handoff_initgroups_invalid");
  }
}

static void require_exact_public_group_memberships(
    gid_t supervisor_gid, gid_t dispatcher_gid, gid_t handoff_gid,
    gid_t supervisor_runtime_gid) {
  setgrent();
  struct group *row;
  while ((row = getgrent()) != NULL) {
    bool supervisor_member = name_in_list(row->gr_mem, SUPERVISOR_USER);
    bool dispatcher_member = name_in_list(row->gr_mem, DISPATCHER_USER);
    if ((row->gr_gid == supervisor_gid || row->gr_gid == dispatcher_gid)
        && row->gr_mem != NULL && row->gr_mem[0] != NULL) {
      endgrent();
      errno = EINVAL;
      fail("autonomous_submission_handoff_primary_group_members_invalid");
    }
    if ((supervisor_member && row->gr_gid != handoff_gid
          && row->gr_gid != supervisor_runtime_gid)
        || (dispatcher_member && row->gr_gid != handoff_gid)) {
      endgrent();
      errno = EINVAL;
      fail("autonomous_submission_handoff_persistent_supplementary_group_forbidden");
    }
  }
  endgrent();
  require_allowed_initgroups(
    SUPERVISOR_USER,
    supervisor_gid,
    handoff_gid,
    supervisor_runtime_gid,
    true);
  require_allowed_initgroups(
    DISPATCHER_USER,
    dispatcher_gid,
    handoff_gid,
    supervisor_runtime_gid,
    false);
}

static void require_unique_user(uid_t uid, const char *expected_name) {
  setpwent();
  struct passwd *row;
  size_t name_count = 0;
  while ((row = getpwent()) != NULL) {
    if (strcmp(row->pw_name, expected_name) == 0) {
      name_count++;
      if (row->pw_uid != uid) {
        endpwent();
        errno = EINVAL;
        fail("autonomous_submission_handoff_system_user_name_collision");
      }
    }
    if (row->pw_uid == uid && strcmp(row->pw_name, expected_name) != 0) {
      endpwent();
      errno = EINVAL;
      fail("autonomous_submission_handoff_system_uid_collision");
    }
  }
  endpwent();
  if (name_count != 1) {
    errno = EINVAL;
    fail("autonomous_submission_handoff_system_user_name_not_unique");
  }
}

static void require_unique_group(gid_t gid, const char *expected_name) {
  setgrent();
  struct group *row;
  size_t name_count = 0;
  while ((row = getgrent()) != NULL) {
    if (strcmp(row->gr_name, expected_name) == 0) {
      name_count++;
      if (row->gr_gid != gid) {
        endgrent();
        errno = EINVAL;
        fail("autonomous_submission_handoff_system_group_name_collision");
      }
    }
    if (row->gr_gid == gid && strcmp(row->gr_name, expected_name) != 0) {
      endgrent();
      errno = EINVAL;
      fail("autonomous_submission_handoff_system_gid_collision");
    }
  }
  endgrent();
  if (name_count != 1) {
    errno = EINVAL;
    fail("autonomous_submission_handoff_system_group_name_not_unique");
  }
}

static struct identities production_identities(bool privileged) {
  if (privileged && geteuid() != 0) {
    fail("autonomous_submission_handoff_layout_root_required");
  }
  errno = 0;
  struct passwd *supervisor = getpwnam(SUPERVISOR_USER);
  if (supervisor == NULL || !nologin_shell(supervisor->pw_shell)
      || strcmp(supervisor->pw_dir, SUPERVISOR_HOME) != 0
      || !passwd_placeholder_or_locked(supervisor->pw_passwd)) {
    fail("autonomous_submission_handoff_supervisor_identity_invalid");
  }
  uid_t supervisor_uid = supervisor->pw_uid;
  gid_t supervisor_gid = supervisor->pw_gid;
  struct group *supervisor_group = getgrgid(supervisor_gid);
  if (supervisor_group == NULL
      || strcmp(supervisor_group->gr_name, SUPERVISOR_GROUP) != 0
      || !passwd_placeholder_or_locked(supervisor_group->gr_passwd)) {
    fail("autonomous_submission_handoff_supervisor_primary_group_invalid");
  }

  struct passwd *dispatcher = getpwnam(DISPATCHER_USER);
  if (dispatcher == NULL || !nologin_shell(dispatcher->pw_shell)
      || strcmp(dispatcher->pw_dir, DISPATCHER_HOME) != 0
      || !passwd_placeholder_or_locked(dispatcher->pw_passwd)) {
    fail("autonomous_submission_handoff_dispatcher_identity_invalid");
  }
  uid_t dispatcher_uid = dispatcher->pw_uid;
  gid_t dispatcher_gid = dispatcher->pw_gid;
  struct group *dispatcher_group = getgrgid(dispatcher_gid);
  if (dispatcher_group == NULL
      || strcmp(dispatcher_group->gr_name, DISPATCHER_GROUP) != 0
      || !passwd_placeholder_or_locked(dispatcher_group->gr_passwd)) {
    fail("autonomous_submission_handoff_dispatcher_primary_group_invalid");
  }

  struct group *handoff = getgrnam(HANDOFF_GROUP);
  if (handoff == NULL || !passwd_placeholder_or_locked(handoff->gr_passwd)) {
    fail("autonomous_submission_handoff_group_identity_missing");
  }
  gid_t handoff_gid = handoff->gr_gid;
  bool supervisor_member;
  bool dispatcher_member;
  size_t member_count;
  inspect_exact_members(
    handoff->gr_mem,
    &supervisor_member,
    &dispatcher_member,
    &member_count,
    "autonomous_submission_handoff_group_membership_not_exclusive");
  struct group *supervisor_runtime = getgrnam(SUPERVISOR_RUNTIME_GROUP);
  if (supervisor_runtime == NULL
      || !passwd_placeholder_or_locked(supervisor_runtime->gr_passwd)) {
    fail("autonomous_submission_handoff_supervisor_runtime_group_missing");
  }
  gid_t supervisor_runtime_gid = supervisor_runtime->gr_gid;
  if (!supervisor_member || !dispatcher_member || member_count != 2
      || supervisor_uid == dispatcher_uid
      || supervisor_gid == dispatcher_gid
      || handoff_gid == supervisor_gid
      || handoff_gid == dispatcher_gid
      || supervisor_runtime_gid == supervisor_gid
      || supervisor_runtime_gid == dispatcher_gid
      || supervisor_runtime_gid == handoff_gid) {
    errno = EINVAL;
    fail("autonomous_submission_handoff_system_identity_mismatch");
  }
  if (!privileged && geteuid() != supervisor_uid) {
    errno = EPERM;
    fail("autonomous_submission_handoff_receipt_verifier_identity_invalid");
  }
  if (privileged) {
    require_locked_unique_account(SUPERVISOR_USER);
    require_locked_unique_account(DISPATCHER_USER);
    require_locked_exact_gshadow();
  }
  require_unique_user(supervisor_uid, SUPERVISOR_USER);
  require_unique_user(dispatcher_uid, DISPATCHER_USER);
  require_unique_group(supervisor_gid, SUPERVISOR_GROUP);
  require_unique_group(dispatcher_gid, DISPATCHER_GROUP);
  require_unique_group(handoff_gid, HANDOFF_GROUP);
  require_unique_group(supervisor_runtime_gid, SUPERVISOR_RUNTIME_GROUP);
  require_exact_public_group_memberships(
    supervisor_gid, dispatcher_gid, handoff_gid, supervisor_runtime_gid);
  return (struct identities) {
    .supervisor_uid = supervisor_uid,
    .supervisor_gid = supervisor_gid,
    .dispatcher_uid = dispatcher_uid,
    .dispatcher_gid = dispatcher_gid,
    .handoff_gid = handoff_gid,
    .root_uid = 0,
  };
}
#else
static struct identities production_identities(bool privileged) {
  if ((privileged && geteuid() != (uid_t) HEPTA_TEST_ROOT_UID)
      || (!privileged && geteuid() != (uid_t) HEPTA_TEST_SUPERVISOR_UID)) {
    errno = EPERM;
    fail("autonomous_submission_handoff_test_identity_invalid");
  }
  return (struct identities) {
    .supervisor_uid = (uid_t) HEPTA_TEST_SUPERVISOR_UID,
    .supervisor_gid = (gid_t) HEPTA_TEST_SUPERVISOR_GID,
    .dispatcher_uid = (uid_t) HEPTA_TEST_DISPATCHER_UID,
    .dispatcher_gid = (gid_t) HEPTA_TEST_DISPATCHER_GID,
    .handoff_gid = (gid_t) HEPTA_TEST_HANDOFF_GID,
    .root_uid = (uid_t) HEPTA_TEST_ROOT_UID,
  };
}
#endif

static void remember_fd(int *opened, size_t *opened_count, int fd) {
  if (*opened_count >= MAX_OPENED_FDS) {
    errno = EOVERFLOW;
    fail("autonomous_submission_handoff_runtime_root_too_deep");
  }
  opened[(*opened_count)++] = fd;
}

static struct entry open_child(int parent_fd, const char *name, bool directory,
                               bool allow_missing, const char *code) {
  int flags = O_RDONLY | O_CLOEXEC | O_NOFOLLOW;
  if (directory) flags |= O_DIRECTORY;
  int fd = openat2_beneath(parent_fd, name, flags, RESOLVE_CHILD);
  if (fd < 0 && allow_missing && errno == ENOENT) {
    return (struct entry) {.fd = -1};
  }
  if (fd < 0) fail(code);
  struct stat stat_value;
  if (fstat(fd, &stat_value) != 0
      || (directory ? !S_ISDIR(stat_value.st_mode) : !S_ISREG(stat_value.st_mode))
      || (!directory && stat_value.st_nlink != 1)) {
    close(fd);
    fail(code);
  }
  return (struct entry) {
    .parent_fd = parent_fd,
    .fd = fd,
    .name = name,
    .before = stat_value,
    .directory = directory,
  };
}

static struct entry create_or_open_directory(int parent_fd, const char *name,
                                              uid_t allowed_a, uid_t allowed_b) {
  struct entry result = open_child(parent_fd, name, true, true,
    "autonomous_submission_handoff_layout_directory_unsafe");
  if (result.fd < 0) {
    if (mkdirat(parent_fd, name, 0700) != 0) {
      fail("autonomous_submission_handoff_layout_directory_create_failed");
    }
    result = open_child(parent_fd, name, true, false,
      "autonomous_submission_handoff_layout_directory_unsafe");
  }
  if (result.before.st_uid != allowed_a
      && result.before.st_uid != allowed_b) {
    fail("autonomous_submission_handoff_layout_directory_owner_invalid");
  }
  return result;
}

static void converge(struct entry *entry, uid_t uid, gid_t gid, mode_t mode,
                     const char *code) {
  if (fchown(entry->fd, uid, gid) != 0 || fchmod(entry->fd, mode) != 0
      || fsync(entry->fd) != 0) {
    fail(code);
  }
  struct stat after;
  if (fstat(entry->fd, &after) != 0
      || after.st_uid != uid || after.st_gid != gid
      || (after.st_mode & 07777) != mode
      || after.st_dev != entry->before.st_dev
      || after.st_ino != entry->before.st_ino
      || (!entry->directory
        && (after.st_nlink != 1 || after.st_size != entry->before.st_size))) {
    fail(code);
  }
}

static void require_metadata(struct entry *entry, uid_t uid, gid_t gid,
                             mode_t mode, const char *code) {
  if (entry->before.st_uid != uid || entry->before.st_gid != gid
      || (entry->before.st_mode & 07777) != mode
      || (!entry->directory && entry->before.st_nlink != 1)) {
    errno = EINVAL;
    fail(code);
  }
}

static struct stat verify_entry(struct entry *entry) {
  struct stat current;
  if (fstatat(entry->parent_fd, entry->name, &current, AT_SYMLINK_NOFOLLOW) != 0
      || current.st_dev != entry->before.st_dev
      || current.st_ino != entry->before.st_ino
      || (entry->directory ? !S_ISDIR(current.st_mode) : !S_ISREG(current.st_mode))
      || (!entry->directory && current.st_nlink != 1)) {
    fail("autonomous_submission_handoff_layout_entry_replaced");
  }
  return current;
}

static int open_absolute_parent(const char *candidate, char **leaf_name) {
  if (candidate == NULL || candidate[0] != '/' || strlen(candidate) >= PATH_MAX) {
    errno = EINVAL;
    fail("autonomous_submission_handoff_receipt_path_invalid");
  }
  char copy[PATH_MAX];
  strcpy(copy, candidate);
  char *separator = strrchr(copy, '/');
  if (separator == NULL || separator == copy || separator[1] == '\0'
      || strcmp(separator + 1, ".") == 0 || strcmp(separator + 1, "..") == 0) {
    errno = EINVAL;
    fail("autonomous_submission_handoff_receipt_path_invalid");
  }
  *leaf_name = strdup(separator + 1);
  if (*leaf_name == NULL) {
    fail("autonomous_submission_handoff_receipt_name_allocation_failed");
  }
  *separator = '\0';
  int current = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  if (current < 0) fail("autonomous_submission_handoff_root_open_failed");
  char *save = NULL;
  char *segment = strtok_r(copy + 1, "/", &save);
  size_t depth = 0;
  while (segment != NULL) {
    if (++depth >= MAX_OPENED_FDS || strcmp(segment, ".") == 0
        || strcmp(segment, "..") == 0) {
      close(current);
      errno = EINVAL;
      fail("autonomous_submission_handoff_receipt_path_invalid");
    }
    int next = openat2_beneath(current, segment,
      O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW,
      RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS);
    if (next < 0) {
      close(current);
      fail("autonomous_submission_handoff_receipt_parent_unsafe");
    }
    close(current);
    current = next;
    segment = strtok_r(NULL, "/", &save);
  }
  return current;
}

static void write_all(int fd, const char *bytes, size_t length) {
  size_t written = 0;
  while (written < length) {
    ssize_t count = write(fd, bytes + written, length - written);
    if (count < 0) fail("autonomous_submission_handoff_receipt_write_failed");
    written += (size_t) count;
  }
}

static int receipt_entry_json(char *target, size_t capacity, const char *label,
                              const struct stat *value) {
  return snprintf(target, capacity,
    "\"%s\":{\"device\":\"%" PRIuMAX "\",\"inode\":\"%" PRIuMAX "\","
    "\"uid\":%" PRIuMAX ",\"gid\":%" PRIuMAX ",\"mode\":\"%04o\"}",
    label,
    (uintmax_t) value->st_dev,
    (uintmax_t) value->st_ino,
    (uintmax_t) value->st_uid,
    (uintmax_t) value->st_gid,
    (unsigned int) (value->st_mode & 07777));
}

static size_t serialize_receipt(
    char *receipt,
    size_t receipt_capacity,
    const struct stat *runtime_stat,
    const struct stat *research_stat,
    const struct stat *handoff_stat,
    const struct stat *database_stat,
    const struct stat *challenges_stat,
    const struct stat *cycles_stat,
    const char database_sha256[65]) {
  char entries[6144];
  size_t used = 0;
  const struct {
    const char *label;
    const struct stat *value;
  } selected[] = {
    {"runtimeRoot", runtime_stat},
    {"autonomousResearchRoot", research_stat},
    {"handoffRoot", handoff_stat},
    {"database", database_stat},
    {"dispatcherChallenges", challenges_stat},
    {"dispatcherCycles", cycles_stat},
  };
  for (size_t index = 0; index < sizeof(selected) / sizeof(selected[0]); index++) {
    if (index > 0) entries[used++] = ',';
    int count = receipt_entry_json(
      entries + used, sizeof(entries) - used,
      selected[index].label, selected[index].value);
    if (count < 0 || (size_t) count >= sizeof(entries) - used) {
      errno = EOVERFLOW;
      fail("autonomous_submission_handoff_receipt_serialization_failed");
    }
    used += (size_t) count;
  }
  entries[used] = '\0';
  int receipt_size = snprintf(receipt, receipt_capacity,
    "{\"version\":1,\"kind\":\"AutonomousSubmissionHandoffLayoutReceipt\","
    "\"status\":\"autonomous_submission_handoff_layout_ready\","
    "\"ready\":true,\"databaseOpenedReadOnly\":true,"
    "\"databaseContentCreated\":false,\"credentialContentCreated\":false,"
    "\"authorityContentCreated\":false,"
    "\"databaseSha256Before\":\"sha256:%s\","
    "\"databaseSha256After\":\"sha256:%s\",\"entries\":{%s}}\n",
    database_sha256, database_sha256, entries);
  if (receipt_size < 0 || (size_t) receipt_size >= receipt_capacity) {
    errno = EOVERFLOW;
    fail("autonomous_submission_handoff_receipt_serialization_failed");
  }
  return (size_t) receipt_size;
}

static void publish_receipt(
    const char *receipt_path,
    const struct identities *ids,
    const struct stat *runtime_stat,
    const struct stat *research_stat,
    const struct stat *handoff_stat,
    const struct stat *database_stat,
    const struct stat *challenges_stat,
    const struct stat *cycles_stat,
    const char database_sha256[65]) {
  char receipt[8192];
  size_t receipt_size = serialize_receipt(
    receipt,
    sizeof(receipt),
    runtime_stat,
    research_stat,
    handoff_stat,
    database_stat,
    challenges_stat,
    cycles_stat,
    database_sha256);
  char *leaf_name = NULL;
  int parent_fd = open_absolute_parent(receipt_path, &leaf_name);
  char temporary_name[128];
  int temporary_fd = -1;
  for (unsigned int attempt = 0; attempt < 128; attempt++) {
    int count = snprintf(temporary_name, sizeof(temporary_name),
      ".%s.tmp.%jd.%u", leaf_name, (intmax_t) getpid(), attempt);
    if (count < 0 || (size_t) count >= sizeof(temporary_name)) {
      errno = EOVERFLOW;
      fail("autonomous_submission_handoff_receipt_name_invalid");
    }
    temporary_fd = openat(parent_fd, temporary_name,
      O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0600);
    if (temporary_fd >= 0) break;
    if (errno != EEXIST) fail("autonomous_submission_handoff_receipt_create_failed");
  }
  if (temporary_fd < 0) {
    errno = EEXIST;
    fail("autonomous_submission_handoff_receipt_create_failed");
  }
  write_all(temporary_fd, receipt, receipt_size);
  if (fchown(temporary_fd, ids->root_uid, ids->supervisor_gid) != 0
      || fchmod(temporary_fd, 0440) != 0 || fsync(temporary_fd) != 0) {
    unlinkat(parent_fd, temporary_name, 0);
    fail("autonomous_submission_handoff_receipt_metadata_failed");
  }
  struct stat receipt_stat;
  if (fstat(temporary_fd, &receipt_stat) != 0 || !S_ISREG(receipt_stat.st_mode)
      || receipt_stat.st_nlink != 1
      || receipt_stat.st_uid != ids->root_uid
      || receipt_stat.st_gid != ids->supervisor_gid
      || (receipt_stat.st_mode & 07777) != 0440) {
    unlinkat(parent_fd, temporary_name, 0);
    errno = EINVAL;
    fail("autonomous_submission_handoff_receipt_metadata_failed");
  }
  if (renameat(parent_fd, temporary_name, parent_fd, leaf_name) != 0
      || fsync(parent_fd) != 0) {
    unlinkat(parent_fd, temporary_name, 0);
    fail("autonomous_submission_handoff_receipt_publish_failed");
  }
  struct stat published;
  if (fstatat(parent_fd, leaf_name, &published, AT_SYMLINK_NOFOLLOW) != 0
      || !S_ISREG(published.st_mode) || published.st_nlink != 1
      || published.st_dev != receipt_stat.st_dev
      || published.st_ino != receipt_stat.st_ino) {
    errno = EINVAL;
    fail("autonomous_submission_handoff_receipt_publish_failed");
  }
  close(temporary_fd);
  close(parent_fd);
  free(leaf_name);
}

struct receipt_entry_metadata {
  uintmax_t device;
  uintmax_t inode;
  uintmax_t uid;
  uintmax_t gid;
  unsigned int mode;
};

static void consume_literal(char **cursor, const char *end, const char *literal) {
  size_t length = strlen(literal);
  if (*cursor > end || (size_t) (end - *cursor) < length
      || memcmp(*cursor, literal, length) != 0) {
    errno = EINVAL;
    fail("autonomous_submission_handoff_receipt_schema_invalid");
  }
  *cursor += length;
}

static uintmax_t consume_decimal(char **cursor, const char *end) {
  if (*cursor >= end || **cursor < '0' || **cursor > '9') {
    errno = EINVAL;
    fail("autonomous_submission_handoff_receipt_schema_invalid");
  }
  char *start = *cursor;
  errno = 0;
  char *parsed_end = NULL;
  uintmax_t value = strtoumax(start, &parsed_end, 10);
  if (errno != 0 || parsed_end == start || parsed_end > end
      || (start[0] == '0' && parsed_end - start > 1)) {
    errno = EINVAL;
    fail("autonomous_submission_handoff_receipt_schema_invalid");
  }
  *cursor = parsed_end;
  return value;
}

static void consume_hash(char **cursor, const char *end, char output[65]) {
  if (*cursor > end || (size_t) (end - *cursor) < 64) {
    errno = EINVAL;
    fail("autonomous_submission_handoff_receipt_schema_invalid");
  }
  for (size_t index = 0; index < 64; index++) {
    char value = (*cursor)[index];
    if (!((value >= '0' && value <= '9') || (value >= 'a' && value <= 'f'))) {
      errno = EINVAL;
      fail("autonomous_submission_handoff_receipt_schema_invalid");
    }
    output[index] = value;
  }
  output[64] = '\0';
  *cursor += 64;
}

static unsigned int consume_mode(char **cursor, const char *end) {
  if (*cursor > end || (size_t) (end - *cursor) < 4) {
    errno = EINVAL;
    fail("autonomous_submission_handoff_receipt_schema_invalid");
  }
  unsigned int value = 0;
  for (size_t index = 0; index < 4; index++) {
    char digit = (*cursor)[index];
    if (digit < '0' || digit > '7') {
      errno = EINVAL;
      fail("autonomous_submission_handoff_receipt_schema_invalid");
    }
    value = value * 8U + (unsigned int) (digit - '0');
  }
  *cursor += 4;
  return value;
}

static struct receipt_entry_metadata consume_receipt_entry(
    char **cursor, const char *end, const char *label, bool last) {
  consume_literal(cursor, end, "\"");
  consume_literal(cursor, end, label);
  consume_literal(cursor, end, "\":{\"device\":\"");
  struct receipt_entry_metadata entry = {.device = consume_decimal(cursor, end)};
  consume_literal(cursor, end, "\",\"inode\":\"");
  entry.inode = consume_decimal(cursor, end);
  consume_literal(cursor, end, "\",\"uid\":");
  entry.uid = consume_decimal(cursor, end);
  consume_literal(cursor, end, ",\"gid\":");
  entry.gid = consume_decimal(cursor, end);
  consume_literal(cursor, end, ",\"mode\":\"");
  entry.mode = consume_mode(cursor, end);
  consume_literal(cursor, end, last ? "\"}" : "\"},");
  return entry;
}

static void require_receipt_entry_matches(
    const struct receipt_entry_metadata *receipt,
    const struct stat *current,
    const char *code) {
  if (receipt->device != (uintmax_t) current->st_dev
      || receipt->inode != (uintmax_t) current->st_ino
      || receipt->uid != (uintmax_t) current->st_uid
      || receipt->gid != (uintmax_t) current->st_gid
      || receipt->mode != (unsigned int) (current->st_mode & 07777)) {
    errno = EINVAL;
    fail(code);
  }
}

static void verify_published_receipt(
    const char *receipt_path,
    const struct identities *ids,
    const struct stat *runtime_stat,
    const struct stat *research_stat,
    const struct stat *handoff_stat,
    const struct stat *database_stat,
    const struct stat *challenges_stat,
    const struct stat *cycles_stat,
    char database_sha256[65]) {
  char *leaf_name = NULL;
  int parent_fd = open_absolute_parent(receipt_path, &leaf_name);
  struct stat parent_stat;
  if (fstat(parent_fd, &parent_stat) != 0 || !S_ISDIR(parent_stat.st_mode)
      || parent_stat.st_uid != ids->root_uid
      || parent_stat.st_gid != ids->supervisor_gid
#ifndef HEPTA_LAYOUT_TEST_MODE
      || (parent_stat.st_mode & 07777) != 0750
#endif
  ) {
    errno = EINVAL;
    fail("autonomous_submission_handoff_receipt_parent_metadata_invalid");
  }
  int receipt_fd = openat2_beneath(
    parent_fd,
    leaf_name,
    O_RDONLY | O_CLOEXEC | O_NOFOLLOW,
    RESOLVE_CHILD);
  if (receipt_fd < 0) {
    fail("autonomous_submission_handoff_receipt_open_failed");
  }
  struct stat before;
  if (fstat(receipt_fd, &before) != 0 || !S_ISREG(before.st_mode)
      || before.st_nlink != 1 || before.st_uid != ids->root_uid
      || before.st_gid != ids->supervisor_gid
      || (before.st_mode & 07777) != 0440
      || before.st_size < 1 || before.st_size >= 8192) {
    errno = EINVAL;
    fail("autonomous_submission_handoff_receipt_metadata_invalid");
  }
  char observed[8192];
  size_t observed_size = 0;
  while (observed_size < sizeof(observed) - 1) {
    ssize_t count = pread(
      receipt_fd,
      observed + observed_size,
      sizeof(observed) - 1 - observed_size,
      (off_t) observed_size);
    if (count < 0) fail("autonomous_submission_handoff_receipt_read_failed");
    if (count == 0) break;
    observed_size += (size_t) count;
  }
  observed[observed_size] = '\0';
  char *cursor = observed;
  const char *receipt_end = observed + observed_size;
  consume_literal(&cursor, receipt_end,
    "{\"version\":1,\"kind\":\"AutonomousSubmissionHandoffLayoutReceipt\","
    "\"status\":\"autonomous_submission_handoff_layout_ready\","
    "\"ready\":true,\"databaseOpenedReadOnly\":true,"
    "\"databaseContentCreated\":false,\"credentialContentCreated\":false,"
    "\"authorityContentCreated\":false,"
    "\"databaseSha256Before\":\"sha256:");
  char before_hash[65];
  char after_hash[65];
  consume_hash(&cursor, receipt_end, before_hash);
  consume_literal(
    &cursor, receipt_end, "\",\"databaseSha256After\":\"sha256:");
  consume_hash(&cursor, receipt_end, after_hash);
  consume_literal(&cursor, receipt_end, "\",\"entries\":{");
  struct receipt_entry_metadata receipt_entries[] = {
    consume_receipt_entry(&cursor, receipt_end, "runtimeRoot", false),
    consume_receipt_entry(
      &cursor, receipt_end, "autonomousResearchRoot", false),
    consume_receipt_entry(&cursor, receipt_end, "handoffRoot", false),
    consume_receipt_entry(&cursor, receipt_end, "database", false),
    consume_receipt_entry(
      &cursor, receipt_end, "dispatcherChallenges", false),
    consume_receipt_entry(&cursor, receipt_end, "dispatcherCycles", true),
  };
  consume_literal(&cursor, receipt_end, "}}\n");
  if (cursor != receipt_end || strcmp(before_hash, after_hash) != 0) {
    errno = EINVAL;
    fail("autonomous_submission_handoff_receipt_content_invalid");
  }
  const struct stat *current_entries[] = {
    runtime_stat,
    research_stat,
    handoff_stat,
    database_stat,
    challenges_stat,
    cycles_stat,
  };
  const char *entry_errors[] = {
    "autonomous_submission_handoff_runtime_root_receipt_drift",
    "autonomous_submission_handoff_research_root_receipt_drift",
    "autonomous_submission_handoff_handoff_root_receipt_drift",
    "autonomous_submission_handoff_database_receipt_drift",
    "autonomous_submission_handoff_challenges_receipt_drift",
    "autonomous_submission_handoff_cycles_receipt_drift",
  };
  for (size_t index = 0; index < 6; index++) {
    require_receipt_entry_matches(
      &receipt_entries[index], current_entries[index], entry_errors[index]);
  }
  strcpy(database_sha256, after_hash);
  struct stat after;
  struct stat current;
  if (fstat(receipt_fd, &after) != 0
      || fstatat(parent_fd, leaf_name, &current, AT_SYMLINK_NOFOLLOW) != 0
      || after.st_dev != before.st_dev || after.st_ino != before.st_ino
      || after.st_nlink != before.st_nlink || after.st_size != before.st_size
      || current.st_dev != before.st_dev || current.st_ino != before.st_ino
      || current.st_nlink != before.st_nlink || current.st_size != before.st_size
      || !S_ISREG(current.st_mode)) {
    errno = EINVAL;
    fail("autonomous_submission_handoff_receipt_replaced");
  }
  close(receipt_fd);
  close(parent_fd);
  free(leaf_name);
}

static struct entry open_runtime_root(const char *runtime_root, int *opened,
                                      size_t *opened_count) {
  if (runtime_root == NULL || runtime_root[0] != '/'
      || strlen(runtime_root) >= PATH_MAX) {
    fail("autonomous_submission_handoff_runtime_root_invalid");
  }
  char copy[PATH_MAX];
  strcpy(copy, runtime_root);
  int current = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  if (current < 0) fail("autonomous_submission_handoff_root_open_failed");
  remember_fd(opened, opened_count, current);
  int parent = -1;
  char *save = NULL;
  char *segment = strtok_r(copy + 1, "/", &save);
  const char *last_name = NULL;
  struct stat last_stat = {0};
  while (segment != NULL) {
    if (strcmp(segment, ".") == 0 || strcmp(segment, "..") == 0) {
      fail("autonomous_submission_handoff_runtime_root_invalid");
    }
    int next = openat2_beneath(current, segment,
      O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW,
      RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS);
    if (next < 0) fail("autonomous_submission_handoff_runtime_root_unsafe");
    if (fstat(next, &last_stat) != 0 || !S_ISDIR(last_stat.st_mode)) {
      fail("autonomous_submission_handoff_runtime_root_unsafe");
    }
    remember_fd(opened, opened_count, next);
    parent = current;
    current = next;
    last_name = segment;
    segment = strtok_r(NULL, "/", &save);
  }
  if (parent < 0 || last_name == NULL) {
    fail("autonomous_submission_handoff_runtime_root_invalid");
  }
  char *stable_name = strdup(last_name);
  if (stable_name == NULL) {
    fail("autonomous_submission_handoff_runtime_root_name_allocation_failed");
  }
  return (struct entry) {
    .parent_fd = parent,
    .fd = current,
    .name = stable_name,
    .before = last_stat,
    .directory = true,
  };
}

int main(int argc, char **argv) {
  if (argc == 2 && strcmp(argv[1], "--verify-identities") == 0) {
    (void) production_identities(true);
    printf("{\"status\":\"autonomous_submission_handoff_identities_ready\","
      "\"ready\":true}\n");
    return EXIT_SUCCESS;
  }
  bool verify_only = argc == 6
    && strcmp(argv[1], "--verify-layout-receipt") == 0
    && strcmp(argv[2], "--runtime-root") == 0
    && strcmp(argv[4], "--receipt-path") == 0;
  bool provision = argc == 5
    && strcmp(argv[1], "--runtime-root") == 0
    && strcmp(argv[3], "--receipt-path") == 0;
  if (!verify_only && !provision) {
    errno = EINVAL;
    fail("autonomous_submission_handoff_layout_arguments_invalid");
  }
  const char *runtime_root = verify_only ? argv[3] : argv[2];
  const char *receipt_path = verify_only ? argv[5] : argv[4];
#ifndef HEPTA_LAYOUT_TEST_MODE
  if (strcmp(runtime_root, PRODUCTION_RUNTIME_ROOT) != 0
      || strcmp(receipt_path, PRODUCTION_RECEIPT_PATH) != 0) {
    errno = EINVAL;
    fail("autonomous_submission_handoff_layout_production_path_invalid");
  }
#endif
  struct identities ids = production_identities(!verify_only);
  int opened[MAX_OPENED_FDS];
  size_t opened_count = 0;
  struct entry runtime = open_runtime_root(runtime_root, opened, &opened_count);
  if (!verify_only && runtime.before.st_uid != ids.supervisor_uid) {
    fail("autonomous_submission_handoff_runtime_root_owner_invalid");
  }
  struct entry research = open_child(runtime.fd, "autonomous-research", true, false,
    "autonomous_submission_handoff_research_root_unsafe");
  remember_fd(opened, &opened_count, research.fd);
  if (!verify_only && research.before.st_uid != ids.supervisor_uid) {
    fail("autonomous_submission_handoff_research_root_owner_invalid");
  }
  struct entry handoff = open_child(research.fd, "submission-handoff", true, false,
    "autonomous_submission_handoff_layout_offline_store_required");
  remember_fd(opened, &opened_count, handoff.fd);
  if (!verify_only && handoff.before.st_uid != ids.supervisor_uid
      && handoff.before.st_uid != ids.root_uid) {
    fail("autonomous_submission_handoff_layout_directory_owner_invalid");
  }
  struct entry database = open_child(handoff.fd, "submission-handoff.sqlite", false, false,
    "autonomous_submission_handoff_layout_offline_store_required");
  remember_fd(opened, &opened_count, database.fd);
  if (!verify_only && database.before.st_uid != ids.supervisor_uid) {
    fail("autonomous_submission_handoff_database_owner_invalid");
  }
  char database_sha256_before[65];
  char database_sha256_after[65];
  database_sha256_before[0] = '\0';
  database_sha256_after[0] = '\0';
  if (!verify_only) sha256_fd(database.fd, database_sha256_before);
  struct entry challenges = verify_only
    ? open_child(handoff.fd, "dispatcher-challenges", true, false,
      "autonomous_submission_handoff_layout_directory_unsafe")
    : create_or_open_directory(
      handoff.fd, "dispatcher-challenges",
      ids.root_uid, ids.supervisor_uid);
  remember_fd(opened, &opened_count, challenges.fd);
  struct entry cycles = verify_only
    ? open_child(handoff.fd, "dispatcher-cycles", true, false,
      "autonomous_submission_handoff_layout_directory_unsafe")
    : create_or_open_directory(
      handoff.fd, "dispatcher-cycles",
      ids.root_uid, ids.dispatcher_uid);
  remember_fd(opened, &opened_count, cycles.fd);

  if (verify_only) {
    require_metadata(&runtime, ids.supervisor_uid, ids.handoff_gid, 0710,
      "autonomous_submission_handoff_runtime_root_metadata_invalid");
    require_metadata(&research, ids.supervisor_uid, ids.handoff_gid, 0710,
      "autonomous_submission_handoff_research_root_metadata_invalid");
    require_metadata(&handoff, ids.root_uid, ids.handoff_gid, 03770,
      "autonomous_submission_handoff_handoff_root_metadata_invalid");
    require_metadata(&database, ids.supervisor_uid, ids.handoff_gid, 0660,
      "autonomous_submission_handoff_database_metadata_invalid");
    require_metadata(&challenges, ids.supervisor_uid, ids.handoff_gid, 02750,
      "autonomous_submission_handoff_challenges_metadata_invalid");
    require_metadata(&cycles, ids.dispatcher_uid, ids.handoff_gid, 02750,
      "autonomous_submission_handoff_cycles_metadata_invalid");
  } else {
    converge(&runtime, ids.supervisor_uid, ids.handoff_gid, 0710,
      "autonomous_submission_handoff_runtime_root_convergence_failed");
    converge(&research, ids.supervisor_uid, ids.handoff_gid, 0710,
      "autonomous_submission_handoff_research_root_convergence_failed");
    converge(&handoff, ids.root_uid, ids.handoff_gid, 03770,
      "autonomous_submission_handoff_layout_directory_convergence_failed");
    converge(&database, ids.supervisor_uid, ids.handoff_gid, 0660,
      "autonomous_submission_handoff_database_metadata_convergence_failed");
    converge(&challenges, ids.supervisor_uid, ids.handoff_gid, 02750,
      "autonomous_submission_handoff_layout_directory_convergence_failed");
    converge(&cycles, ids.dispatcher_uid, ids.handoff_gid, 02750,
      "autonomous_submission_handoff_layout_directory_convergence_failed");
  }

  if (!verify_only) {
    sha256_fd(database.fd, database_sha256_after);
    if (strcmp(database_sha256_before, database_sha256_after) != 0) {
      errno = EBUSY;
      fail("autonomous_submission_handoff_database_content_changed");
    }
  }
  struct stat runtime_stat = verify_entry(&runtime);
  struct stat research_stat = verify_entry(&research);
  struct stat handoff_stat = verify_entry(&handoff);
  struct stat database_stat = verify_entry(&database);
  struct stat challenges_stat = verify_entry(&challenges);
  struct stat cycles_stat = verify_entry(&cycles);
  if (!verify_only) {
    publish_receipt(
      receipt_path,
      &ids,
      &runtime_stat,
      &research_stat,
      &handoff_stat,
      &database_stat,
      &challenges_stat,
      &cycles_stat,
      database_sha256_after);
  }
  verify_published_receipt(
    receipt_path,
    &ids,
    &runtime_stat,
    &research_stat,
    &handoff_stat,
    &database_stat,
    &challenges_stat,
    &cycles_stat,
    database_sha256_after);
  for (size_t index = opened_count; index > 0; index--) close(opened[index - 1]);
  free((void *) runtime.name);
  printf("{\"status\":\"%s\","
    "\"ready\":true,\"runtimeRootMode\":\"0710\","
    "\"autonomousResearchRootMode\":\"0710\",\"handoffRootMode\":\"3770\","
    "\"databaseMode\":\"0660\",\"dispatcherChallengesMode\":\"2750\","
    "\"dispatcherCyclesMode\":\"2750\",\"databaseOpenedReadOnly\":true,"
    "\"databaseSha256\":\"sha256:%s\","
    "\"databaseContentCreated\":false,\"credentialContentCreated\":false,"
    "\"authorityContentCreated\":false}\n",
    verify_only
      ? "autonomous_submission_handoff_layout_receipt_verified"
      : "autonomous_submission_handoff_layout_ready",
    database_sha256_after);
  return EXIT_SUCCESS;
}
