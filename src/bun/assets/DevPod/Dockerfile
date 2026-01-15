FROM oven/bun:alpine AS base

# Install Node.js and npm (needed for Next.js dev server)
RUN apk add --no-cache nodejs npm bash curl

# Create app directory
WORKDIR /app

# Copy control server code
COPY control-server /control-server
WORKDIR /control-server
RUN bun install

# Set up app directory
WORKDIR /app

# Create directories for the app
RUN mkdir -p /app/node_modules

# Expose ports
# 3000: Next.js dev server
# 9000: Control server
EXPOSE 3000 9000

# Start control server (which manages dev server)
CMD ["bun", "run", "/control-server/index.ts"]
