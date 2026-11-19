# Waypoint: no dependencies, so the image is just Node and the files.
FROM node:22-alpine
WORKDIR /app
COPY --chown=node:node . .
ENV HOST=0.0.0.0 PORT=8080 WAYPOINT_DATA_DIR=/data
# The data folder is the only place the server writes. Mount a volume here to keep it.
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "server.js"]
