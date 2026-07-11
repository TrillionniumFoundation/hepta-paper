FROM rocker/r-ver:4.4.2
ENV R_LIBS_SITE=/usr/local/lib/R/site-library:/usr/lib/R/site-library
RUN sed -i 's#http://archive.ubuntu.com/ubuntu#http://cn.archive.ubuntu.com/ubuntu#g' /etc/apt/sources.list.d/ubuntu.sources \
 && DEBIAN_FRONTEND=noninteractive apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends libcurl4-openssl-dev libssl-dev libxml2-dev libfontconfig1-dev libfreetype6-dev libpng-dev libtiff5-dev libjpeg-dev libuv1-dev libicu-dev \
 && rm -rf /var/lib/apt/lists/*
COPY renv.lock /tmp/renv.lock
COPY restore-locked.R /tmp/restore-locked.R
RUN Rscript /tmp/restore-locked.R
COPY packages.lock /tmp/packages.lock
COPY verify-locked.R /tmp/verify-locked.R
RUN Rscript /tmp/verify-locked.R
WORKDIR /work
