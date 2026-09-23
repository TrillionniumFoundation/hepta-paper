# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e
FROM python:3.12.7-slim-bookworm@sha256:60d9996b6a8a3689d36db740b49f4327be3be09a21122bd02fb8895abb38b50d
ARG TARGETPLATFORM
ARG SOURCE_DATE_EPOCH=1733097600
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONHASHSEED=0 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    MPLBACKEND=Agg \
    SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH} \
    TZ=UTC \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8
COPY requirements.lock /tmp/requirements.lock
RUN test "$TARGETPLATFORM" = "linux/amd64" \
 && test "$SOURCE_DATE_EPOCH" = "1733097600" \
 && sed -i \
      -e 's#http://deb.debian.org/debian-security#https://snapshot.debian.org/archive/debian-security/20241202T000000Z#g' \
      -e 's#http://deb.debian.org/debian#https://snapshot.debian.org/archive/debian/20241202T000000Z#g' \
      /etc/apt/sources.list.d/debian.sources \
 && printf 'Acquire::Check-Valid-Until "false";\n' > /etc/apt/apt.conf.d/99hepta-snapshot \
 && apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends strace=6.1-0.1 \
 && pip install --no-cache-dir --only-binary=:all: --require-hashes --requirement /tmp/requirements.lock \
 && python -c "import numpy,pandas,scipy,statsmodels,sklearn,matplotlib,seaborn" \
 && apt-get clean \
 && rm -rf \
      /var/lib/apt/lists/* \
      /var/cache/apt/* \
      /var/cache/fontconfig/* \
      /var/log/apt/* \
      /root/.cache \
 && rm -f \
      /var/cache/ldconfig/aux-cache \
      /var/log/alternatives.log \
      /var/log/dpkg.log
COPY hepta-dataset-access-supervisor /usr/local/libexec/hepta-dataset-access-supervisor
RUN chmod 0555 /usr/local/libexec/hepta-dataset-access-supervisor \
 && echo "a62b96c00d1989398f2f94df878b0983e98f8db472f29a3c6db9a4c3ccfe0de0  /usr/local/libexec/hepta-dataset-access-supervisor" | sha256sum -c - \
 && test -x /usr/bin/strace \
 && test -x /usr/bin/setpriv
LABEL io.hepta.dataset-supervisor.protocol="hepta-container-dataset-supervisor-v1" \
      io.hepta.dataset-supervisor.sha256="sha256:a62b96c00d1989398f2f94df878b0983e98f8db472f29a3c6db9a4c3ccfe0de0"
WORKDIR /work
