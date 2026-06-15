# gh-proxy — zero-dependency relay. The image is just Node + source.
FROM node:20-alpine

WORKDIR /app

# No runtime dependencies to install; copy the source the server reads.
COPY package.json server.js ./
COPY docs ./docs
COPY skills ./skills

ENV NODE_ENV=production
# Listen on all interfaces inside the container by default.
ENV BIND_HOST=0.0.0.0
EXPOSE 8788

USER node
CMD ["node", "server.js"]
