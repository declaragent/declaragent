# WS6 — runnable agent image. Ships the already-built workspace (`dist/` is
# arch-independent JS emitted by tsc) and installs only correct-arch runtime
# deps inside the image, then runs `declaragent up` in the FOREGROUND (PID 1 is
# the agent loop — not a detached child that exits 0 → CrashLoopBackOff). The
# agent config is mounted at /etc/declaragent via the rendered ConfigMap;
# health probes bind to 0.0.0.0 so the kubelet reaches /healthz + /readyz.
#
# Build from a tree that has been built (`bun run build`) so packages/*/dist
# exist. CI's clean build produces these; this image consumes them.
FROM oven/bun:1.3

WORKDIR /app

# Manifests + lockfile first for layer caching, then install runtime deps.
COPY package.json bun.lock ./
COPY packages packages
COPY templates templates
RUN bun install

ENV DECLARAGENT_METRICS_PORT=9464 \
    DECLARAGENT_BIND_ADDRESS=0.0.0.0
EXPOSE 9464

ENTRYPOINT ["bun", "run", "/app/packages/cli/dist/index.js"]
CMD ["up", "-f", "/etc/declaragent/agent.yaml"]
