# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e
FROM rocker/r-ver:4.4.2@sha256:df26749182af64d5263bf64149d51a427b476ed28c4e046997143be3f97fdd7c
ENV R_LIBS_SITE=/usr/local/lib/R/site-library:/usr/lib/R/site-library \
    SOURCE_DATE_EPOCH=1733097600 \
    TZ=UTC
RUN sed -i \
      -e 's#http://archive.ubuntu.com/ubuntu/#https://snapshot.ubuntu.com/ubuntu/20260715T000000Z/#g' \
      -e 's#http://security.ubuntu.com/ubuntu/#https://snapshot.ubuntu.com/ubuntu/20260715T000000Z/#g' \
      /etc/apt/sources.list.d/ubuntu.sources \
 && DEBIAN_FRONTEND=noninteractive apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      strace=6.8-0ubuntu2 \
      libcurl4-openssl-dev=8.5.0-2ubuntu10.11 \
      libssl-dev=3.0.13-0ubuntu3.11 \
      libxml2-dev=2.9.14+dfsg-1.3ubuntu3.8 \
      libfontconfig1-dev=2.15.0-1.1ubuntu2 \
      libfreetype-dev=2.13.2+dfsg-1ubuntu0.1 \
      libpng-dev=1.6.43-5ubuntu0.6 \
      libtiff-dev=4.5.1+git230720-4ubuntu2.5 \
      libjpeg-dev=8c-2ubuntu11 \
      libpcre2-dev=10.42-4ubuntu2.1 \
      libuv1-dev=1.48.0-1.1build1 \
      libicu-dev=74.2-1ubuntu3.1 \
 && rm -rf \
      /var/lib/apt/lists/* \
      /var/cache/apt/archives/* \
      /var/log/apt/* \
 && rm -f \
      /var/cache/ldconfig/aux-cache \
      /var/log/alternatives.log \
      /var/log/dpkg.log \
      /var/log/fontconfig.log
COPY renv.lock /tmp/renv.lock
COPY source-cas /opt/hepta-r-source-cas
COPY restore-locked.R /tmp/restore-locked.R
COPY normalize-installed.sh /tmp/normalize-installed.sh
RUN --network=none Rscript /tmp/restore-locked.R \
 && sh /tmp/normalize-installed.sh
COPY packages.lock /tmp/packages.lock
# The normalization pass removes all /tmp/renv* working state, including the
# bootstrap copy. Re-copy the immutable lock solely for the offline verifier.
COPY renv.lock /tmp/renv.lock
COPY verify-locked.R /tmp/verify-locked.R
RUN --network=none Rscript /tmp/verify-locked.R
COPY hepta-dataset-access-supervisor /usr/local/libexec/hepta-dataset-access-supervisor
RUN chmod 0555 /usr/local/libexec/hepta-dataset-access-supervisor \
 && echo "a62b96c00d1989398f2f94df878b0983e98f8db472f29a3c6db9a4c3ccfe0de0  /usr/local/libexec/hepta-dataset-access-supervisor" | sha256sum -c - \
 && test -x /usr/bin/strace \
 && test -x /usr/bin/setpriv
LABEL io.hepta.dataset-supervisor.protocol="hepta-container-dataset-supervisor-v1" \
      io.hepta.dataset-supervisor.sha256="sha256:a62b96c00d1989398f2f94df878b0983e98f8db472f29a3c6db9a4c3ccfe0de0"
WORKDIR /work
