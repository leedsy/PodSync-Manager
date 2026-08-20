FROM ghcr.io/mxpv/podsync:nightly
USER root
RUN apk add --no-cache nodejs
COPY postprocess-ipod-video.sh /usr/local/bin/postprocess-ipod-video.sh
RUN chmod +x /usr/local/bin/postprocess-ipod-video.sh
