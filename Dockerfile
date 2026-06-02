# Minimal image so MCP directories (e.g. Glama) can start the server and run
# introspection checks. Installs the published package and launches the stdio server.
FROM node:22-slim
RUN npm install -g @kyanitelabs/epoch
ENTRYPOINT ["epoch"]
