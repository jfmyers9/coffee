FROM node:24-alpine
LABEL org.opencontainers.image.source="https://github.com/jfmyers9/coffee" \
      org.opencontainers.image.description="Mobile-first guided V60 and Chemex coffee brewing"
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --chown=node:node server.js ./
COPY --chown=node:node server ./server
COPY --chown=node:node migrations ./migrations
COPY --chown=node:node public ./public
COPY --chown=node:node recipes ./recipes
USER node
ENV HOST=0.0.0.0 PORT=8080
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
