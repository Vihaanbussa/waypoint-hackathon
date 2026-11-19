# Waypoint: no dependencies, so the image is just Node and the files.
FROM node:22-alpine
WORKDIR /app
COPY . .
ENV HOST=0.0.0.0 PORT=8080 WAYPOINT_DATA_DIR=/data
RUN mkdir -p /data && cp data/portal-users.json /data/ 2>/dev/null || true
EXPOSE 8080
CMD ["node", "server.js"]
